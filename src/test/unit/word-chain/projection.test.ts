import { describe, expect, test } from "bun:test";

import type { Game, GameResult, Player, WordAssignment, WordChainGame } from "@/generated/prisma/client";
import { projectWordChain } from "@/server/games/word-chain/projection";
import type { WordChainProjection, WordChainProjectionInput } from "@/server/games/word-chain/projection";
import type { GameStatus, WordChainPhase } from "@/server/games/word-chain/types";
import type { HintItem, PlayerRef } from "@/shared/contracts/game";

type PlayerKey = "pl-masha" | "pl-petya" | "pl-vanya" | "pl-sasha";

// Канарейки уникальны для каждого автора: утекание чужого слова видно
// по сериализованному JSON независимо от поля, куда оно попало.
const SECRETS: Record<PlayerKey, string> = {
  "pl-masha": "SECRET_MASHA_01",
  "pl-petya": "SECRET_PETYA_02",
  "pl-vanya": "SECRET_VANYA_03",
  "pl-sasha": "SECRET_SASHA_04",
};
const ALL_SECRETS: readonly string[] = Object.values(SECRETS);

// Единый направленный цикл: Маша → Петя → Ваня → Саша → Маша.
const CYCLE_TARGET: Record<PlayerKey, PlayerKey> = {
  "pl-masha": "pl-petya",
  "pl-petya": "pl-vanya",
  "pl-vanya": "pl-sasha",
  "pl-sasha": "pl-masha",
};

const ASSIGNMENT_IDS: Record<PlayerKey, string> = {
  "pl-masha": "asg-masha",
  "pl-petya": "asg-petya",
  "pl-vanya": "asg-vanya",
  "pl-sasha": "asg-sasha",
};

// Петя и Маша делят createdAt: порядок между ними решает id.
const ASSIGNMENT_CREATED_AT_OFFSET_MS: Record<PlayerKey, number> = {
  "pl-masha": 2_000,
  "pl-petya": 2_000,
  "pl-vanya": 3_000,
  "pl-sasha": 1_000,
};

// На вход проекции назначения поступают не в порядке createdAt:
// проекция обязана вернуть детерминированный порядок (createdAt, id).
const SHUFFLED_AUTHORS: readonly PlayerKey[] = ["pl-vanya", "pl-sasha", "pl-petya", "pl-masha"];

// Ожидаемый порядок hints: (createdAt, id).
const HINT_ORDER: readonly PlayerKey[] = ["pl-sasha", "pl-masha", "pl-petya", "pl-vanya"];

const PLAYER_FIXTURES: ReadonlyArray<{
  id: PlayerKey;
  name: string;
  normalizedName: string;
  joinedAtMs: number;
}> = [
  { id: "pl-masha", name: "Маша", normalizedName: "маша", joinedAtMs: 0 },
  { id: "pl-petya", name: "Петя", normalizedName: "петя", joinedAtMs: 1_000 },
  { id: "pl-vanya", name: "Ваня", normalizedName: "ваня", joinedAtMs: 2_000 },
  { id: "pl-sasha", name: "Саша", normalizedName: "саша", joinedAtMs: 3_000 },
];

const PLAYER_IDS: readonly PlayerKey[] = ["pl-masha", "pl-petya", "pl-vanya", "pl-sasha"];
const HOST_ID: PlayerKey = "pl-masha";

const GAME_ID = "game-00000001";
const T0 = new Date("2026-11-23T09:00:00.000Z");
const ASSIGN_BASE = new Date("2026-11-23T09:05:00.000Z");
const PLAYING_STARTED_AT = new Date("2026-11-23T09:15:00.000Z");
const FINISHED_AT = new Date("2026-11-23T09:45:00.000Z");

const DURATION_MS: Readonly<Record<"petya" | "masha" | "vanya", number>> = {
  petya: 90_000,
  masha: 120_000,
  vanya: 150_000,
};

function at(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

function playerRef(id: PlayerKey): PlayerRef {
  const fixture = PLAYER_FIXTURES.find((player) => player.id === id);
  if (!fixture) throw new Error("FIXTURE_BROKEN");
  return { id: fixture.id, name: fixture.name };
}

function playerName(id: PlayerKey): string {
  return playerRef(id).name;
}

function targetOf(viewerId: PlayerKey): PlayerKey {
  return CYCLE_TARGET[viewerId];
}

// Слово, которое viewer должен угадать: написано предшественником в цикле.
function targetedSecret(viewerId: PlayerKey): string {
  for (const authorId of PLAYER_IDS) {
    if (CYCLE_TARGET[authorId] === viewerId) return SECRETS[authorId];
  }
  throw new Error("FIXTURE_BROKEN");
}

function revealedSecretsFor(viewerId: PlayerKey): readonly string[] {
  return ALL_SECRETS.filter((secret) => secret !== targetedSecret(viewerId));
}

function makePlayers(): Player[] {
  return PLAYER_FIXTURES.map((fixture) => ({
    id: fixture.id,
    gameId: GAME_ID,
    name: fixture.name,
    normalizedName: fixture.normalizedName,
    isReady: true,
    joinedAt: at(T0, fixture.joinedAtMs),
  }));
}

function playerById(players: readonly Player[], id: PlayerKey): Player {
  const player = players.find((candidate) => candidate.id === id);
  if (!player) throw new Error("FIXTURE_BROKEN");
  return player;
}

function makeAssignments(words: Partial<Record<PlayerKey, string | null>>): WordAssignment[] {
  return SHUFFLED_AUTHORS.map((authorId) => ({
    id: ASSIGNMENT_IDS[authorId],
    gameId: GAME_ID,
    authorPlayerId: authorId,
    targetPlayerId: CYCLE_TARGET[authorId],
    word: words[authorId] ?? null,
    submittedAt: null,
    createdAt: at(ASSIGN_BASE, ASSIGNMENT_CREATED_AT_OFFSET_MS[authorId]),
  }));
}

function makeResult(playerId: PlayerKey, place: number | null, score: number, finishedAt: Date | null): GameResult {
  return { id: `res-${playerId}`, gameId: GAME_ID, playerId, place, score, finishedAt };
}

const STANDARD_RESULTS: GameResult[] = [
  makeResult("pl-petya", 1, 4, at(PLAYING_STARTED_AT, DURATION_MS.petya)),
  makeResult("pl-masha", 2, 3, at(PLAYING_STARTED_AT, DURATION_MS.masha)),
  makeResult("pl-vanya", 3, 2, at(PLAYING_STARTED_AT, DURATION_MS.vanya)),
  makeResult("pl-sasha", null, 0, null),
];

type InputOptions = {
  status: GameStatus;
  phase: WordChainPhase | null;
  hideTargetNames?: boolean;
  words?: Partial<Record<PlayerKey, string | null>>;
  results?: GameResult[];
};

function buildInput(options: InputOptions): Omit<WordChainProjectionInput, "viewer"> {
  const game: Game = {
    id: GAME_ID,
    code: "WC1001",
    type: "WORD_CHAIN",
    status: options.status,
    hostPlayerId: HOST_ID,
    revision: 0,
    createdAt: T0,
    updatedAt: T0,
    startedAt: options.status === "LOBBY" ? null : T0,
    finishedAt: options.status === "FINISHED" ? FINISHED_AT : null,
  };
  const wordChain: WordChainGame = {
    gameId: GAME_ID,
    phase: options.phase,
    hideTargetNamesDuringSetup: options.hideTargetNames ?? false,
    playingStartedAt:
      options.phase === "PLAYING" || options.status === "FINISHED" ? PLAYING_STARTED_AT : null,
  };
  return {
    game,
    wordChain,
    players: makePlayers(),
    assignments: makeAssignments(options.words ?? {}),
    results: options.results ?? [],
  };
}

function projectFor(viewerId: PlayerKey, options: InputOptions): WordChainProjection {
  const input = buildInput(options);
  return projectWordChain({ ...input, viewer: playerById(input.players, viewerId) });
}

function capabilities(partial: Partial<WordChainProjection["capabilities"]>): WordChainProjection["capabilities"] {
  return { canSubmitWord: false, canMarkGuessed: false, canFinish: false, canCancel: false, ...partial };
}

function expectGameCapabilitiesKeys(capabilitiesValue: WordChainProjection["capabilities"]): void {
  expect(Object.keys(capabilitiesValue).sort()).toEqual([
    "canCancel",
    "canFinish",
    "canMarkGuessed",
    "canSubmitWord",
  ]);
}

function expectSecretsAbsent(serialized: string, secrets: readonly string[]): void {
  for (const secret of secrets) expect(serialized).not.toContain(secret);
}

function expectSecretsPresent(serialized: string, secrets: readonly string[]): void {
  for (const secret of secrets) expect(serialized).toContain(secret);
}

function wordsOnly(authorId: PlayerKey, word: string): Partial<Record<PlayerKey, string | null>> {
  const words: Record<PlayerKey, string | null> = {
    "pl-masha": null,
    "pl-petya": null,
    "pl-vanya": null,
    "pl-sasha": null,
  };
  words[authorId] = word;
  return words;
}

function expectedHints(viewerId: PlayerKey, revealAll: boolean): HintItem[] {
  return HINT_ORDER.map((authorId) => {
    const targetId = CYCLE_TARGET[authorId];
    const hidden = !revealAll && targetId === viewerId;
    return {
      assignmentId: ASSIGNMENT_IDS[authorId],
      author: playerRef(authorId),
      target: playerRef(targetId),
      word: hidden ? null : SECRETS[authorId],
      wordHidden: hidden,
    };
  });
}

describe("LOBBY", () => {
  test("для каждого зрителя проекция пустая и все игровые возможности выключены", () => {
    for (const viewerId of PLAYER_IDS) {
      const projection = projectFor(viewerId, { status: "LOBBY", phase: null });
      expect(projection).toEqual({ setup: null, hints: null, results: null, capabilities: capabilities({}) });
      expectGameCapabilitiesKeys(projection.capabilities);
      expectSecretsAbsent(JSON.stringify(projection), ALL_SECRETS);
    }
  });
});

describe("ASSIGNING_WORDS", () => {
  test("при открытом адресате setup содержит PlayerRef адресата и собственное введённое слово", () => {
    for (const viewerId of PLAYER_IDS) {
      const projection = projectFor(viewerId, {
        status: "ACTIVE",
        phase: "ASSIGNING_WORDS",
        words: SECRETS,
      });
      expect(projection).toEqual({
        setup: { target: playerRef(targetOf(viewerId)), targetHidden: false, word: SECRETS[viewerId] },
        hints: null,
        results: null,
        capabilities: capabilities({}),
      });
      expectGameCapabilitiesKeys(projection.capabilities);
    }
  });

  test("пока своё слово не введено: setup.word=null, canSubmitWord=true, секретов нет в JSON", () => {
    for (const hideTargetNames of [false, true]) {
      for (const viewerId of PLAYER_IDS) {
        const projection = projectFor(viewerId, {
          status: "ACTIVE",
          phase: "ASSIGNING_WORDS",
          hideTargetNames,
        });
        expect(projection.setup).toEqual({
          target: hideTargetNames ? null : playerRef(targetOf(viewerId)),
          targetHidden: hideTargetNames,
          word: null,
        });
        expect(projection.hints).toBeNull();
        expect(projection.results).toBeNull();
        expect(projection.capabilities).toEqual(capabilities({ canSubmitWord: true }));
        expectSecretsAbsent(JSON.stringify(projection), ALL_SECRETS);
      }
    }
  });

  test("после ввода своего слова в JSON есть только собственный секрет зрителя", () => {
    for (const viewerId of PLAYER_IDS) {
      const projection = projectFor(viewerId, {
        status: "ACTIVE",
        phase: "ASSIGNING_WORDS",
        words: wordsOnly(viewerId, SECRETS[viewerId]),
      });
      expect(projection.setup?.word).toBe(SECRETS[viewerId]);
      const serialized = JSON.stringify(projection);
      expect(serialized).toContain(SECRETS[viewerId]);
      expectSecretsAbsent(
        serialized,
        ALL_SECRETS.filter((secret) => secret !== SECRETS[viewerId]),
      );
    }
  });

  test("скрытие адресата: target=null, targetHidden=true, id и имя адресата отсутствуют в JSON", () => {
    for (const viewerId of PLAYER_IDS) {
      const projection = projectFor(viewerId, {
        status: "ACTIVE",
        phase: "ASSIGNING_WORDS",
        hideTargetNames: true,
        words: SECRETS,
      });
      const targetId = targetOf(viewerId);
      expect(projection.setup).toEqual({ target: null, targetHidden: true, word: SECRETS[viewerId] });
      const serialized = JSON.stringify(projection);
      expect(serialized).not.toContain(targetId);
      expect(serialized).not.toContain(playerName(targetId));
      expectSecretsAbsent(
        serialized,
        ALL_SECRETS.filter((secret) => secret !== SECRETS[viewerId]),
      );
    }
  });
});

describe("PLAYING", () => {
  test("для каждого зрителя скрыто ровно его собственное слово, остальные слова раскрыты", () => {
    for (const viewerId of PLAYER_IDS) {
      const projection = projectFor(viewerId, { status: "ACTIVE", phase: "PLAYING", words: SECRETS });
      expect(projection.setup).toBeNull();
      expect(projection.results).toBeNull();
      expect(projection.hints).toEqual(expectedHints(viewerId, false));
      const hiddenItems = projection.hints?.filter((hint) => hint.wordHidden) ?? [];
      expect(hiddenItems).toHaveLength(1);
      expect(hiddenItems[0]?.target.id).toBe(viewerId);
      expect(hiddenItems[0]?.word).toBeNull();
      expectGameCapabilitiesKeys(projection.capabilities);
      expect(projection.capabilities).toEqual(
        capabilities({ canMarkGuessed: true, canFinish: viewerId === HOST_ID }),
      );
      const serialized = JSON.stringify(projection);
      expect(serialized).not.toContain(targetedSecret(viewerId));
      expectSecretsPresent(serialized, revealedSecretsFor(viewerId));
    }
  });

  test("зритель с установленным местом теряет canMarkGuessed, права хоста не меняются", () => {
    const results = [makeResult("pl-petya", 1, 4, at(PLAYING_STARTED_AT, DURATION_MS.petya))];
    const options: InputOptions = { status: "ACTIVE", phase: "PLAYING", words: SECRETS, results };
    const petya = projectFor("pl-petya", options);
    expect(petya.capabilities).toEqual(capabilities({}));
    const masha = projectFor("pl-masha", options);
    expect(masha.capabilities).toEqual(capabilities({ canMarkGuessed: true, canFinish: true }));
    const sasha = projectFor("pl-sasha", options);
    expect(sasha.capabilities).toEqual(capabilities({ canMarkGuessed: true }));
  });

  test("незаполненное слово в PLAYING бросает INVALID_GAME_STATE", () => {
    expect(() =>
      projectFor("pl-masha", {
        status: "ACTIVE",
        phase: "PLAYING",
        words: { "pl-petya": "SECRET_PETYA_02" },
      }),
    ).toThrow("INVALID_GAME_STATE");
  });

  test("порядок hints детерминирован по (createdAt, id) независимо от порядка входного массива", () => {
    const projection = projectFor("pl-masha", { status: "ACTIVE", phase: "PLAYING", words: SECRETS });
    expect(projection.hints?.map((hint) => hint.assignmentId)).toEqual([
      "asg-sasha",
      "asg-masha",
      "asg-petya",
      "asg-vanya",
    ]);
  });

  test("не изменяет входные массивы назначений, игроков и результатов", () => {
    const input = buildInput({ status: "ACTIVE", phase: "PLAYING", words: SECRETS, results: STANDARD_RESULTS });
    const assignmentIds = input.assignments.map((assignment) => assignment.id);
    const playerIds = input.players.map((player) => player.id);
    const resultIds = input.results.map((result) => result.id);
    projectWordChain({ ...input, viewer: playerById(input.players, "pl-masha") });
    projectWordChain({ ...input, viewer: playerById(input.players, "pl-sasha") });
    expect(input.assignments.map((assignment) => assignment.id)).toEqual(assignmentIds);
    expect(input.players.map((player) => player.id)).toEqual(playerIds);
    expect(input.results.map((result) => result.id)).toEqual(resultIds);
  });
});

describe("FINISHED", () => {
  test("раскрывает все слова и возвращает рейтинг с местами и длительностями", () => {
    const projection = projectFor("pl-vanya", {
      status: "FINISHED",
      phase: "PLAYING",
      words: SECRETS,
      results: STANDARD_RESULTS,
    });
    expect(projection.setup).toBeNull();
    expect(projection.hints).toEqual(expectedHints("pl-vanya", true));
    expect(projection.results).toEqual([
      { playerId: "pl-petya", name: "Петя", place: 1, score: 4, durationMs: DURATION_MS.petya },
      { playerId: "pl-masha", name: "Маша", place: 2, score: 3, durationMs: DURATION_MS.masha },
      { playerId: "pl-vanya", name: "Ваня", place: 3, score: 2, durationMs: DURATION_MS.vanya },
      { playerId: "pl-sasha", name: "Саша", place: null, score: 0, durationMs: null },
    ]);
    expect(projection.capabilities).toEqual(capabilities({}));
    expectGameCapabilitiesKeys(projection.capabilities);
    expectSecretsPresent(JSON.stringify(projection), ALL_SECRETS);
  });

  test("не угадавшие сортируются после занявших места по (normalizedName, id)", () => {
    const results: GameResult[] = [
      makeResult("pl-petya", 1, 4, at(PLAYING_STARTED_AT, DURATION_MS.petya)),
      makeResult("pl-masha", 2, 3, at(PLAYING_STARTED_AT, DURATION_MS.masha)),
      makeResult("pl-vanya", null, 0, null),
      makeResult("pl-sasha", null, 0, null),
    ];
    const projection = projectFor("pl-masha", {
      status: "FINISHED",
      phase: "PLAYING",
      words: SECRETS,
      results,
    });
    expect(projection.results?.map((result) => result.playerId)).toEqual([
      "pl-petya",
      "pl-masha",
      "pl-vanya",
      "pl-sasha",
    ]);
  });

  test("игрок без результата включается в рейтинг как не угадавший", () => {
    const results = STANDARD_RESULTS.filter((result) => result.playerId !== "pl-sasha");
    const projection = projectFor("pl-masha", {
      status: "FINISHED",
      phase: "PLAYING",
      words: SECRETS,
      results,
    });
    const sasha = projection.results?.find((result) => result.playerId === "pl-sasha");
    expect(sasha).toEqual({ playerId: "pl-sasha", name: "Саша", place: null, score: 0, durationMs: null });
  });

  test("незаполненное слово в FINISHED бросает INVALID_GAME_STATE", () => {
    expect(() =>
      projectFor("pl-masha", { status: "FINISHED", phase: "PLAYING", results: STANDARD_RESULTS }),
    ).toThrow("INVALID_GAME_STATE");
  });

  test("FINISHED без playingStartedAt бросает INVALID_GAME_STATE", () => {
    const input = buildInput({ status: "FINISHED", phase: "PLAYING", words: SECRETS, results: STANDARD_RESULTS });
    const wordChain: WordChainGame = { ...input.wordChain, playingStartedAt: null };
    expect(() => projectWordChain({ ...input, wordChain, viewer: playerById(input.players, "pl-masha") })).toThrow(
      "INVALID_GAME_STATE",
    );
  });
});

describe("недопустимые состояния", () => {
  test("все запрещённые сочетания статуса и фазы бросают INVALID_GAME_STATE", () => {
    const invalid: ReadonlyArray<{ status: GameStatus; phase: WordChainPhase | null }> = [
      { status: "LOBBY", phase: "ASSIGNING_WORDS" },
      { status: "LOBBY", phase: "PLAYING" },
      { status: "ACTIVE", phase: null },
      { status: "FINISHED", phase: null },
      { status: "FINISHED", phase: "ASSIGNING_WORDS" },
    ];
    for (const { status, phase } of invalid) {
      expect(() =>
        projectFor("pl-masha", { status, phase, words: SECRETS, results: STANDARD_RESULTS }),
      ).toThrow("INVALID_GAME_STATE");
    }
  });
});
