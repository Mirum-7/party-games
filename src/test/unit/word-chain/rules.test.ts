import { describe, expect, test } from "bun:test";

import {
  assertSingleCycle,
  buildCycle,
  canStart,
  compareResults,
  generateRoomCode,
  getPublicPhase,
  nameKey,
  normalizeCode,
  normalizeName,
  normalizeWord,
  scoreForPlace,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "@/server/games/word-chain/rules";
import type { AssignmentPair, RandomInt } from "@/server/games/word-chain/rules";
import { cryptoRandomInt } from "@/server/games/word-chain/random";
import type { GameStatus, PublicPhase, ResultSortKey, WordChainPhase } from "@/server/games/word-chain/types";

function makeIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `p${i}`);
}

// Детерминированный RNG, выдающий значения заданной последовательности.
// Бросает ошибку, если последовательность исчерпана, — чтобы тест не
// подменял недостающие значения случайными.
function sequenceRandom(values: readonly number[]): RandomInt {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("SEQUENCE_EXHAUSTED");
    index += 1;
    return value;
  };
}

// Детерминированный RNG, циклически повторяющий значения:
// supplies valid values for every Fisher–Yates iteration при любом N.
function repeatingRandom(values: readonly number[]): RandomInt {
  let index = 0;
  return () => {
    const value = values[index % values.length] ?? 0;
    index += 1;
    return value;
  };
}

// Меняет местами адресатов двух назначений так, что единый цикл
// распадается на два подцикла (для N >= 4), сохраняя при этом уникальность
// авторов и адресатов и отсутствие самоназначений.
function swapTwoTargets(pairs: readonly AssignmentPair[]): AssignmentPair[] {
  const swapped = pairs.map((pair) => ({ ...pair }));
  const second = Math.floor(swapped.length / 2);
  const firstTarget = swapped[0].targetPlayerId;
  swapped[0].targetPlayerId = swapped[second].targetPlayerId;
  swapped[second].targetPlayerId = firstTarget;
  return swapped;
}

function hasSelfLoopOrDuplicate(pairs: readonly AssignmentPair[]): boolean {
  const authors = new Set(pairs.map((pair) => pair.authorPlayerId));
  const targets = new Set(pairs.map((pair) => pair.targetPlayerId));
  return (
    authors.size !== pairs.length ||
    targets.size !== pairs.length ||
    pairs.some((pair) => pair.authorPlayerId === pair.targetPlayerId)
  );
}

describe("buildCycle", () => {
  test("для каждого N=3..12 создаёт один цикл: обход от каждого игрока посещает всех ровно один раз и возвращается в начало", () => {
    for (let n = 3; n <= 12; n += 1) {
      const ids = makeIds(n);
      const pairs = buildCycle(ids, repeatingRandom([0, 1]));

      expect(pairs).toHaveLength(n);
      expect(new Set(pairs.map((p) => p.authorPlayerId)).size).toBe(n);
      expect(new Set(pairs.map((p) => p.targetPlayerId)).size).toBe(n);
      expect(pairs.some((p) => p.authorPlayerId === p.targetPlayerId)).toBe(false);
      expect(() => assertSingleCycle(pairs)).not.toThrow();

      // Обход от каждого игрока: ровно N разных вершин и возврат в начало.
      const targetByAuthor = new Map(pairs.map((p) => [p.authorPlayerId, p.targetPlayerId]));
      for (const start of ids) {
        const visited = new Set<string>();
        let current = start;
        for (let step = 0; step < n; step += 1) {
          expect(visited.has(current)).toBe(false);
          visited.add(current);
          const next = targetByAuthor.get(current);
          if (next === undefined) throw new Error("BROKEN_CHAIN");
          current = next;
        }
        expect(current).toBe(start);
        expect(visited.size).toBe(n);
      }

      // Подмена двух адресатов нарушает инвариант единственного цикла.
      expect(() => assertSingleCycle(swapTwoTargets(pairs))).toThrow("SINGLE_CYCLE_REQUIRED");
    }
  });

  test("границы RNG: все нули и все максимумы дают валидный единый цикл для каждого N=3..12", () => {
    for (let n = 3; n <= 12; n += 1) {
      const ids = makeIds(n);
      expect(() => assertSingleCycle(buildCycle(ids, () => 0))).not.toThrow();
      expect(() => assertSingleCycle(buildCycle(ids, (maxExclusive) => maxExclusive - 1))).not.toThrow();
    }
  });

  test("выбрасывает RNG_OUT_OF_RANGE, если RNG вернул значение вне [0, i]", () => {
    expect(() => buildCycle(makeIds(4), sequenceRandom([4]))).toThrow("RNG_OUT_OF_RANGE");
    expect(() => buildCycle(makeIds(4), sequenceRandom([-1]))).toThrow("RNG_OUT_OF_RANGE");
    expect(() => buildCycle(makeIds(4), sequenceRandom([0.5, 0, 0]))).toThrow("RNG_OUT_OF_RANGE");
    expect(() => buildCycle(makeIds(4), sequenceRandom([Number.NaN, 0, 0]))).toThrow("RNG_OUT_OF_RANGE");
  });

  test("RNG вызывается ровно N−1 раз с аргументами n, n−1, …, 2", () => {
    const calls: number[] = [];
    buildCycle(makeIds(5), (maxExclusive) => {
      calls.push(maxExclusive);
      return 0;
    });
    expect(calls).toEqual([5, 4, 3, 2]);
  });

  test("детерминирован: фиксированная последовательность RNG даёт тот же порядок", () => {
    const pairs = buildCycle(["a", "b", "c", "d"], sequenceRandom([0, 2, 1]));
    expect(pairs).toEqual([
      { authorPlayerId: "d", targetPlayerId: "b" },
      { authorPlayerId: "b", targetPlayerId: "c" },
      { authorPlayerId: "c", targetPlayerId: "a" },
      { authorPlayerId: "a", targetPlayerId: "d" },
    ]);
  });

  test("отклоняет недопустимый набор игроков", () => {
    expect(() => buildCycle(makeIds(2), () => 0)).toThrow("INVALID_PLAYER_SET");
    expect(() => buildCycle(makeIds(13), () => 0)).toThrow("INVALID_PLAYER_SET");
    expect(() => buildCycle([], () => 0)).toThrow("INVALID_PLAYER_SET");
    expect(() => buildCycle(["a", "b", "b"], () => 0)).toThrow("INVALID_PLAYER_SET");
  });

  test("не изменяет входной массив игроков", () => {
    const ids = makeIds(5);
    const before = [...ids];
    buildCycle(ids, repeatingRandom([0, 1]));
    expect(ids).toEqual(before);
  });
});

describe("assertSingleCycle", () => {
  test("отклоняет пустой набор назначений", () => {
    expect(() => assertSingleCycle([])).toThrow("SINGLE_CYCLE_REQUIRED");
  });

  test("отклоняет самоназначение", () => {
    expect(() =>
      assertSingleCycle([
        { authorPlayerId: "a", targetPlayerId: "a" },
        { authorPlayerId: "b", targetPlayerId: "c" },
        { authorPlayerId: "c", targetPlayerId: "b" },
      ]),
    ).toThrow("SINGLE_CYCLE_REQUIRED");
  });

  test("отклоняет повторного автора", () => {
    expect(() =>
      assertSingleCycle([
        { authorPlayerId: "a", targetPlayerId: "b" },
        { authorPlayerId: "a", targetPlayerId: "c" },
        { authorPlayerId: "c", targetPlayerId: "a" },
      ]),
    ).toThrow("SINGLE_CYCLE_REQUIRED");
  });

  test("отклоняет повторного адресата", () => {
    expect(() =>
      assertSingleCycle([
        { authorPlayerId: "a", targetPlayerId: "b" },
        { authorPlayerId: "b", targetPlayerId: "a" },
        { authorPlayerId: "c", targetPlayerId: "b" },
      ]),
    ).toThrow("SINGLE_CYCLE_REQUIRED");
  });

  test("отклоняет адресата вне набора авторов", () => {
    expect(() =>
      assertSingleCycle([
        { authorPlayerId: "a", targetPlayerId: "b" },
        { authorPlayerId: "b", targetPlayerId: "a" },
        { authorPlayerId: "c", targetPlayerId: "d" },
      ]),
    ).toThrow("SINGLE_CYCLE_REQUIRED");
  });

  test("отклоняет два подцикла без нарушения уникальности и самоназначений (чётные N)", () => {
    for (const n of [4, 6, 8, 10, 12]) {
      const pairs = buildCycle(makeIds(n), repeatingRandom([0, 1]));
      const broken = swapTwoTargets(pairs);
      // Подмена создала именно подциклы, а не более дешёвое нарушение:
      // авторы и адресаты уникальны, самоназначений нет.
      expect(hasSelfLoopOrDuplicate(broken)).toBe(false);
      expect(() => assertSingleCycle(broken)).toThrow("SINGLE_CYCLE_REQUIRED");
    }
  });
});

describe("нормализация", () => {
  test("normalizeName: trim и сворачивание повторных пробелов", () => {
    expect(normalizeName("  Маша   и  Петя ")).toBe("Маша и Петя");
    expect(normalizeName("Маша\t\n Петя")).toBe("Маша Петя");
    expect(normalizeName("   ")).toBe("");
  });

  test("normalizeName: NFKC и сохранение регистра отображения", () => {
    expect(normalizeName("１２３")).toBe("123");
    expect(normalizeName("мАшА")).toBe("мАшА");
  });

  test("nameKey: регистронезависимый ключ после нормализации", () => {
    expect(nameKey("  ПеТя ")).toBe("петя");
    expect(nameKey("ＴＯＮＹ")).toBe("tony");
    expect(nameKey("МАША")).toBe(nameKey("маша"));
  });

  test("normalizeWord: только trim, внутренние пробелы сохраняются", () => {
    expect(normalizeWord("  два   слова  ")).toBe("два   слова");
    expect(normalizeWord("\t слово \n")).toBe("слово");
    expect(normalizeWord("")).toBe("");
  });

  test("normalizeCode: удаление пробелов и верхний регистр", () => {
    expect(normalizeCode("  ab cd\n")).toBe("ABCD");
    expect(normalizeCode("a b 2 3")).toBe("AB23");
  });
});

describe("код комнаты", () => {
  test("генерирует детерминированный код из шести символов алфавита", () => {
    expect(generateRoomCode(sequenceRandom([0, 1, 2, 3, 4, 5]))).toBe("ABCDEF");
    expect(generateRoomCode(sequenceRandom([31, 31, 31, 31, 31, 31]))).toBe("999999");
    expect(generateRoomCode(sequenceRandom([0, 1, 2, 3, 4, 5]))).toBe("ABCDEF");
  });

  test("RNG вызывается ровно 6 раз с аргументом, равным размеру алфавита", () => {
    const calls: number[] = [];
    generateRoomCode((maxExclusive) => {
      calls.push(maxExclusive);
      return 0;
    });
    expect(calls).toEqual([32, 32, 32, 32, 32, 32]);
    expect(ROOM_CODE_ALPHABET).toHaveLength(32);
    expect(ROOM_CODE_LENGTH).toBe(6);
  });

  test("каждый сгенерированный символ принадлежит алфавиту без I, O, 0, 1", () => {
    for (let roll = 0; roll < 50; roll += 1) {
      const code = generateRoomCode(cryptoRandomInt);
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      for (const ch of code) {
        expect(ROOM_CODE_ALPHABET).toContain(ch);
      }
    }
  });

  test("выбрасывает RNG_OUT_OF_RANGE, если RNG вернул значение вне алфавита", () => {
    expect(() => generateRoomCode(sequenceRandom([32]))).toThrow("RNG_OUT_OF_RANGE");
    expect(() => generateRoomCode(sequenceRandom([-1]))).toThrow("RNG_OUT_OF_RANGE");
  });
});

describe("getPublicPhase", () => {
  test("все разрешённые сочетания статуса и фазы", () => {
    const valid: Array<[GameStatus, WordChainPhase | null, PublicPhase]> = [
      ["LOBBY", null, "LOBBY"],
      ["ACTIVE", "ASSIGNING_WORDS", "ASSIGNING_WORDS"],
      ["ACTIVE", "PLAYING", "PLAYING"],
      ["FINISHED", "PLAYING", "FINISHED"],
    ];
    for (const [status, phase, expected] of valid) {
      expect(getPublicPhase(status, phase)).toBe(expected);
    }
  });

  test("все запрещённые сочетания отклоняются", () => {
    const invalid: Array<[GameStatus, WordChainPhase | null]> = [
      ["LOBBY", "ASSIGNING_WORDS"],
      ["LOBBY", "PLAYING"],
      ["ACTIVE", null],
      ["FINISHED", null],
      ["FINISHED", "ASSIGNING_WORDS"],
    ];
    for (const [status, phase] of invalid) {
      expect(() => getPublicPhase(status, phase)).toThrow("INVALID_GAME_STATE");
    }
  });
});

describe("canStart", () => {
  test("границы числа игроков и готовности", () => {
    const cases: Array<[number, boolean, boolean]> = [
      [0, true, false],
      [1, true, false],
      [2, true, false],
      [2, false, false],
      [3, true, true],
      [3, false, false],
      [7, true, true],
      [12, true, true],
      [12, false, false],
      [13, true, false],
    ];
    for (const [playerCount, allReady, expected] of cases) {
      expect(canStart(playerCount, allReady)).toBe(expected);
    }
  });
});

describe("scoreForPlace", () => {
  test("очки равны N − место + 1", () => {
    expect(scoreForPlace(4, 1)).toBe(4);
    expect(scoreForPlace(4, 2)).toBe(3);
    expect(scoreForPlace(4, 3)).toBe(2);
    expect(scoreForPlace(4, 4)).toBe(1);
    expect(scoreForPlace(12, 1)).toBe(12);
    expect(scoreForPlace(12, 12)).toBe(1);
    expect(scoreForPlace(3, 2)).toBe(2);
  });
});

describe("compareResults", () => {
  test("сортировка: сначала места по возрастанию, затем (normalizedName, id) для не угадавших", () => {
    const entries: ResultSortKey[] = [
      { place: null, normalizedName: "боря", playerId: "p4" },
      { place: 2, normalizedName: "аня", playerId: "p2" },
      { place: null, normalizedName: "аня", playerId: "p9" },
      { place: 1, normalizedName: "вова", playerId: "p1" },
      { place: null, normalizedName: "аня", playerId: "p3" },
    ];
    const sorted = [...entries].sort(compareResults);
    expect(sorted.map((entry) => entry.playerId)).toEqual(["p1", "p2", "p3", "p9", "p4"]);
  });

  test("компаратор рефлексивен: равные ключи дают 0", () => {
    const entry: ResultSortKey = { place: null, normalizedName: "аня", playerId: "p1" };
    expect(compareResults(entry, entry)).toBe(0);
    const placed: ResultSortKey = { place: 3, normalizedName: "петя", playerId: "p2" };
    expect(compareResults(placed, placed)).toBe(0);
  });
});

describe("cryptoRandomInt", () => {
  test("возвращает целые значения в [0, max) и покрывает диапазон", () => {
    for (const max of [1, 2, 32, 1000]) {
      for (let i = 0; i < 200; i += 1) {
        const value = cryptoRandomInt(max);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(max);
      }
    }
    const distinct = new Set(Array.from({ length: 1000 }, () => cryptoRandomInt(32)));
    expect(distinct.size).toBeGreaterThan(16);
  });
});
