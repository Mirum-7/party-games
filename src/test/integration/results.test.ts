import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { GameCommandError } from "@/server/core/games/errors";
import type { GameErrorCode, GameErrorStatus } from "@/server/core/games/errors";
import { createGame, joinGame } from "@/server/core/games/service";
import { setReadiness } from "@/server/core/players/service";
import type { GameRealtime } from "@/server/core/realtime/types";
import { prisma } from "@/server/db";
import { getGameDefinition } from "@/server/games/registry";
import {
  finishWordChain,
  markGuessed,
  startWordChain,
  submitWord,
} from "@/server/games/word-chain/service";
import type { FinalStandingItem } from "@/server/games/word-chain/service";
import { applyMigrationsOnce, cleanTables } from "@/test/integration/database";

const definition = getGameDefinition("WORD_CHAIN");

beforeAll(async () => {
  await applyMigrationsOnce();
});

beforeEach(async () => {
  await cleanTables(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

type Published = { gameId: string; revision: number };

function createSpyRealtime(): { realtime: GameRealtime; published: Published[] } {
  const published: Published[] = [];
  return {
    published,
    realtime: {
      publish: (gameId, revision) => {
        published.push({ gameId, revision });
      },
      subscribe: () => () => {},
    },
  };
}

async function expectGameError(
  promise: Promise<unknown>,
  code: GameErrorCode,
  status: GameErrorStatus,
): Promise<GameCommandError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GameCommandError);
    const gameError = error as GameCommandError;
    expect(gameError.code).toBe(code);
    expect(gameError.status).toBe(status);
    return gameError;
  }
  throw new Error(`Expected GameCommandError ${code}, but the promise resolved`);
}

async function loadGame(gameId: string) {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: { players: true, wordChain: true },
  });
  expect(game).not.toBeNull();
  return game!;
}

function loadResults(gameId: string) {
  return prisma.gameResult.findMany({ where: { gameId } });
}

type ReadyRoom = {
  gameId: string;
  code: string;
  hostId: string;
  playerIds: string[];
  baseRevision: number;
};

// Комната с N готовыми участниками: create (rev 0) + (N−1) входов + N готовностей.
async function createReadyRoom(names: string[]): Promise<ReadyRoom> {
  const created = await createGame({ definition, name: names[0]! });
  const playerIds = [created.playerId];
  for (const name of names.slice(1)) {
    const joined = await joinGame({
      definition,
      code: created.code,
      name,
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });
    playerIds.push(joined.value.playerId);
  }
  for (const playerId of playerIds) {
    await setReadiness({
      code: created.code,
      playerId,
      ready: true,
      realtime: createSpyRealtime().realtime,
    });
  }
  return {
    gameId: created.gameId,
    code: created.code,
    hostId: created.playerId,
    playerIds,
    baseRevision: 0 + (names.length - 1) + names.length,
  };
}

// Комната в фазе PLAYING: запуск + ввод всех слов.
async function createPlayingRoom(names: string[]): Promise<ReadyRoom> {
  const room = await createReadyRoom(names);
  await startWordChain({
    code: room.code,
    playerId: room.hostId,
    realtime: createSpyRealtime().realtime,
  });
  for (const [index, playerId] of room.playerIds.entries()) {
    await submitWord({
      code: room.code,
      playerId,
      word: `слово-${index}`,
      realtime: createSpyRealtime().realtime,
    });
  }
  return room;
}

function standingNames(standings: FinalStandingItem[]): string[] {
  return standings.map((item) => item.name);
}

describe("markGuessed", () => {
  test("N=4: последовательные угадывания дают места 1–4 и очки 4–1, durationMs от playingStartedAt; последнее ставит FINISHED с серверным finishedAt", async () => {
    const room = await createPlayingRoom(["Маша", "Петя", "Ваня", "Саша"]);
    // baseRevision 7, start → 8, четыре слова → 12.
    const game = await loadGame(room.gameId);
    const playingStartedAt = game.wordChain!.playingStartedAt!;
    const { realtime, published } = createSpyRealtime();

    const clockAt = (offsetMs: number) => () => new Date(playingStartedAt.getTime() + offsetMs);
    const values = [];
    for (const [index, playerId] of room.playerIds.entries()) {
      const result = await markGuessed({
        code: room.code,
        playerId,
        realtime,
        now: clockAt((index + 1) * 1000),
      });
      values.push(result.value);
      expect(result.changed).toBe(true);
      expect(result.revision).toBe(12 + index + 1);
    }

    expect(values.map((v) => v.place)).toEqual([1, 2, 3, 4]);
    expect(values.map((v) => v.score)).toEqual([4, 3, 2, 1]);
    expect(values.map((v) => v.finishedAt.getTime() - playingStartedAt.getTime())).toEqual([
      1000, 2000, 3000, 4000,
    ]);
    expect(values.map((v) => v.durationMs)).toEqual([1000, 2000, 3000, 4000]);
    expect(values.map((v) => v.finished)).toEqual([false, false, false, true]);

    const finished = await loadGame(room.gameId);
    expect(finished.status).toBe("FINISHED");
    expect(finished.finishedAt!.getTime()).toBe(playingStartedAt.getTime() + 4000);
    expect(finished.revision).toBe(16);

    const results = await loadResults(room.gameId);
    expect(results).toHaveLength(4);
    for (const [index, playerId] of room.playerIds.entries()) {
      const row = results.find((r) => r.playerId === playerId)!;
      expect(row.place).toBe(index + 1);
      expect(row.score).toBe(4 - index);
      expect(row.finishedAt!.getTime()).toBe(playingStartedAt.getTime() + (index + 1) * 1000);
    }

    expect(published).toEqual([
      { gameId: room.gameId, revision: 13 },
      { gameId: room.gameId, revision: 14 },
      { gameId: room.gameId, revision: 15 },
      { gameId: room.gameId, revision: 16 },
    ]);
  });

  test("повтор угадывания в PLAYING — no-op: результат и ревизия не меняются, публикации нет", async () => {
    const room = await createPlayingRoom(["Маша", "Петя", "Ваня", "Саша"]);
    const { realtime, published } = createSpyRealtime();

    const first = await markGuessed({
      code: room.code,
      playerId: room.playerIds[0]!,
      realtime,
      now: () => new Date("2026-11-23T10:00:01Z"),
    });
    expect(first.changed).toBe(true);

    const again = await markGuessed({
      code: room.code,
      playerId: room.playerIds[0]!,
      realtime,
      now: () => new Date("2026-11-23T11:00:00Z"),
    });

    expect(again.changed).toBe(false);
    expect(again.revision).toBe(first.revision);
    expect(again.value).toEqual(first.value);
    const game = await loadGame(room.gameId);
    expect(game.revision).toBe(first.revision);
    expect(game.status).toBe("ACTIVE");
    const row = (await loadResults(room.gameId)).find((r) => r.playerId === room.playerIds[0]!)!;
    expect(row.finishedAt!.toISOString()).toBe("2026-11-23T10:00:01.000Z");
    expect(published).toEqual([{ gameId: room.gameId, revision: first.revision }]);
  });

  test("повтор последнего угадывания после автоматического FINISHED — success no-op, результат сохранён", async () => {
    const room = await createPlayingRoom(["Маша", "Петя", "Ваня", "Саша"]);
    const { realtime, published } = createSpyRealtime();
    for (const playerId of room.playerIds) {
      await markGuessed({ code: room.code, playerId, realtime });
    }
    const revisionAfterFinish = (await loadGame(room.gameId)).revision;
    const before = await loadResults(room.gameId);

    const repeat = await markGuessed({
      code: room.code,
      playerId: room.playerIds[3]!,
      realtime,
      now: () => new Date("2030-01-01T00:00:00Z"),
    });

    expect(repeat.changed).toBe(false);
    expect(repeat.revision).toBe(revisionAfterFinish);
    expect(repeat.value.place).toBe(4);
    expect(repeat.value.finishedAt.getTime()).toBe(
      before.find((r) => r.playerId === room.playerIds[3]!)!.finishedAt!.getTime(),
    );
    const after = await loadResults(room.gameId);
    for (const row of before) {
      const unchanged = after.find((r) => r.id === row.id)!;
      expect(unchanged.place).toBe(row.place);
      expect(unchanged.score).toBe(row.score);
      expect(unchanged.finishedAt).toEqual(row.finishedAt);
    }
    expect(published).toHaveLength(4);
  });

  test("одновременные угадывания четырёх игроков получают уникальные последовательные места и атомарный FINISHED", async () => {
    const room = await createPlayingRoom(["Маша", "Петя", "Ваня", "Саша"]);
    const { realtime, published } = createSpyRealtime();

    const results = await Promise.all(
      room.playerIds.map((playerId) => markGuessed({ code: room.code, playerId, realtime })),
    );

    const places = results.map((r) => r.value.place).sort((a, b) => a - b);
    expect(places).toEqual([1, 2, 3, 4]);
    const revisions = results.map((r) => r.revision).sort((a, b) => a - b);
    expect(revisions).toEqual([13, 14, 15, 16]);
    expect(results.every((r) => r.changed)).toBe(true);

    const rows = await loadResults(room.gameId);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.place!).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    for (const row of rows) {
      expect(row.score).toBe(4 - row.place! + 1);
      expect(row.finishedAt).not.toBeNull();
    }

    const game = await loadGame(room.gameId);
    expect(game.status).toBe("FINISHED");
    expect(game.finishedAt).not.toBeNull();
    expect(game.revision).toBe(16);
    expect(published.map((p) => p.revision).sort((a, b) => a - b)).toEqual([13, 14, 15, 16]);
  });

  test("незарегистрированный игрок получает FORBIDDEN и результата не создаётся", async () => {
    const room = await createPlayingRoom(["Маша", "Петя", "Ваня", "Саша"]);

    await expectGameError(
      Promise.resolve(
        markGuessed({
          code: room.code,
          playerId: randomUUID(),
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "FORBIDDEN",
      403,
    );

    expect(await loadResults(room.gameId)).toHaveLength(0);
    const game = await loadGame(room.gameId);
    expect(game.status).toBe("ACTIVE");
    expect(game.revision).toBe(12);
  });

  test("угадывание вне PLAYING отклоняется: в LOBBY и в ASSIGNING_WORDS", async () => {
    const lobbyRoom = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await expectGameError(
      Promise.resolve(
        markGuessed({
          code: lobbyRoom.code,
          playerId: lobbyRoom.playerIds[0]!,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );

    const setupRoom = await createReadyRoom(["Оля", "Гриша", "Дима"]);
    await startWordChain({
      code: setupRoom.code,
      playerId: setupRoom.hostId,
      realtime: createSpyRealtime().realtime,
    });
    await expectGameError(
      Promise.resolve(
        markGuessed({
          code: setupRoom.code,
          playerId: setupRoom.playerIds[0]!,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );

    expect(await loadResults(setupRoom.gameId)).toHaveLength(0);
  });
});

describe("finishWordChain", () => {
  test("досрочное завершение сразу в PLAYING: N результатов null/0/null, FINISHED с серверным finishedAt, сортировка по (normalizedName, id)", async () => {
    const room = await createPlayingRoom(["Саша", "Ваня", "Маша", "Петя"]);
    const { realtime, published } = createSpyRealtime();
    const finishedAt = new Date("2026-11-23T12:00:00Z");

    const result = await finishWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime,
      now: () => finishedAt,
    });

    expect(result.changed).toBe(true);
    expect(result.revision).toBe(13);
    expect(result.value.finishedAt).toEqual(finishedAt);
    expect(standingNames(result.value.results)).toEqual(["Ваня", "Маша", "Петя", "Саша"]);
    for (const item of result.value.results) {
      expect(item).toMatchObject({ place: null, score: 0, durationMs: null });
    }

    const game = await loadGame(room.gameId);
    expect(game.status).toBe("FINISHED");
    expect(game.finishedAt).toEqual(finishedAt);
    expect(game.revision).toBe(13);

    const rows = await loadResults(room.gameId);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.place).toBeNull();
      expect(row.score).toBe(0);
      expect(row.finishedAt).toBeNull();
    }

    expect(published).toEqual([{ gameId: room.gameId, revision: 13 }]);
  });

  test("досрочное завершение сохраняет места, очки и время уже угадавших и дополняет только остальных", async () => {
    const room = await createPlayingRoom(["Саша", "Ваня", "Маша", "Петя"]);
    const game = await loadGame(room.gameId);
    const playingStartedAt = game.wordChain!.playingStartedAt!;
    const guessTime = new Date(playingStartedAt.getTime() + 7000);
    const finishTime = new Date(playingStartedAt.getTime() + 20000);

    const guess = await markGuessed({
      code: room.code,
      playerId: room.playerIds[0]!,
      realtime: createSpyRealtime().realtime,
      now: () => guessTime,
    });
    expect(guess.value).toMatchObject({ place: 1, score: 4, durationMs: 7000 });

    const { realtime, published } = createSpyRealtime();
    const result = await finishWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime,
      now: () => finishTime,
    });

    expect(result.changed).toBe(true);
    expect(result.revision).toBe(14);
    const first = result.value.results[0]!;
    expect(first).toMatchObject({
      playerId: room.playerIds[0]!,
      name: "Саша",
      place: 1,
      score: 4,
      durationMs: 7000,
    });
    expect(standingNames(result.value.results.slice(1))).toEqual(["Ваня", "Маша", "Петя"]);
    for (const item of result.value.results.slice(1)) {
      expect(item).toMatchObject({ place: null, score: 0, durationMs: null });
    }

    const rows = await loadResults(room.gameId);
    const winner = rows.find((r) => r.playerId === room.playerIds[0]!)!;
    expect(winner.place).toBe(1);
    expect(winner.score).toBe(4);
    expect(winner.finishedAt).toEqual(guessTime);
    expect(rows.filter((r) => r.place === null)).toHaveLength(3);

    const after = await loadGame(room.gameId);
    expect(after.status).toBe("FINISHED");
    expect(after.finishedAt).toEqual(finishTime);
    expect(published).toEqual([{ gameId: room.gameId, revision: 14 }]);
  });

  test("не админ не может завершить игру досрочно", async () => {
    const room = await createPlayingRoom(["Маша", "Петя", "Ваня", "Саша"]);

    await expectGameError(
      Promise.resolve(
        finishWordChain({
          code: room.code,
          playerId: room.playerIds[1]!,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "FORBIDDEN",
      403,
    );

    const game = await loadGame(room.gameId);
    expect(game.status).toBe("ACTIVE");
    expect(await loadResults(room.gameId)).toHaveLength(0);
  });

  test("завершение вне PLAYING отклоняется: в LOBBY и в ASSIGNING_WORDS", async () => {
    const lobbyRoom = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await expectGameError(
      Promise.resolve(
        finishWordChain({
          code: lobbyRoom.code,
          playerId: lobbyRoom.hostId,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );

    const setupRoom = await createReadyRoom(["Оля", "Гриша", "Дима"]);
    await startWordChain({
      code: setupRoom.code,
      playerId: setupRoom.hostId,
      realtime: createSpyRealtime().realtime,
    });
    await expectGameError(
      Promise.resolve(
        finishWordChain({
          code: setupRoom.code,
          playerId: setupRoom.hostId,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );

    const game = await loadGame(setupRoom.gameId);
    expect(game.status).toBe("ACTIVE");
    expect(await loadResults(setupRoom.gameId)).toHaveLength(0);
  });
});

describe("гонка угадывания и досрочного завершения", () => {
  test("finish зафиксирован первым: позднее угадывание отклоняется INVALID_GAME_STATE, новый результат не создаётся", async () => {
    const room = await createPlayingRoom(["Маша", "Петя", "Ваня", "Саша"]);

    const finished = await finishWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });
    expect(finished.changed).toBe(true);

    await expectGameError(
      Promise.resolve(
        markGuessed({
          code: room.code,
          playerId: room.playerIds[1]!,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );

    const rows = await loadResults(room.gameId);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.place === null && r.score === 0 && r.finishedAt === null)).toBe(
      true,
    );
    const game = await loadGame(room.gameId);
    expect(game.status).toBe("FINISHED");
    expect(game.revision).toBe(13);
  });

  test("угадывание зафиксировано первым: поздний finish сохраняет его результат без изменений", async () => {
    const room = await createPlayingRoom(["Саша", "Ваня", "Маша", "Петя"]);
    const game = await loadGame(room.gameId);
    const playingStartedAt = game.wordChain!.playingStartedAt!;
    const guessTime = new Date(playingStartedAt.getTime() + 5000);

    await markGuessed({
      code: room.code,
      playerId: room.playerIds[1]!,
      realtime: createSpyRealtime().realtime,
      now: () => guessTime,
    });
    const before = (await loadResults(room.gameId)).find(
      (r) => r.playerId === room.playerIds[1]!,
    )!;

    const finished = await finishWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });

    expect(finished.changed).toBe(true);
    const winner = finished.value.results.find((r) => r.playerId === room.playerIds[1]!)!;
    expect(winner).toMatchObject({ place: 1, score: 4, durationMs: 5000 });
    const after = (await loadResults(room.gameId)).find((r) => r.playerId === room.playerIds[1]!)!;
    expect(after.place).toBe(before.place);
    expect(after.score).toBe(before.score);
    expect(after.finishedAt).toEqual(before.finishedAt);
  });

  test("конкурентные guessed/finish: finish всегда успешен, угадывание либо первым, либо отклонено доменной ошибкой без raw unique violation", async () => {
    const room = await createPlayingRoom(["Маша", "Петя", "Ваня", "Саша"]);

    const [guessOutcome, finishOutcome] = await Promise.allSettled([
      markGuessed({
        code: room.code,
        playerId: room.playerIds[1]!,
        realtime: createSpyRealtime().realtime,
      }),
      finishWordChain({
        code: room.code,
        playerId: room.hostId,
        realtime: createSpyRealtime().realtime,
      }),
    ]);

    // finish идёт до конца в любом порядке блокировки: либо после чужого
    // угадывания (PLAYING ещё активен), либо первым.
    expect(finishOutcome.status).toBe("fulfilled");
    if (finishOutcome.status === "fulfilled") {
      expect(finishOutcome.value.changed).toBe(true);
      expect(finishOutcome.value.value.results).toHaveLength(4);
    }

    if (guessOutcome.status === "rejected") {
      expect(guessOutcome.reason).toBeInstanceOf(GameCommandError);
      expect((guessOutcome.reason as GameCommandError).code).toBe("INVALID_GAME_STATE");
    } else {
      expect(guessOutcome.value.changed).toBe(true);
      expect(guessOutcome.value.value.place).toBe(1);
    }

    const rows = await loadResults(room.gameId);
    expect(rows).toHaveLength(4);
    // Кто зафиксировал первым, тот и определил судьбу угадывания: либо
    // результат с местом 1 сохранён, либо завершение создало только нулевые
    // результаты, а угадывание отклонено.
    const placed = rows.filter((r) => r.place !== null);
    if (guessOutcome.status === "fulfilled") {
      expect(placed.map((r) => r.place)).toEqual([1]);
      expect(placed[0]!.playerId).toBe(room.playerIds[1]!);
    } else {
      expect(placed).toHaveLength(0);
    }
    const game = await loadGame(room.gameId);
    expect(game.status).toBe("FINISHED");
  });
});
