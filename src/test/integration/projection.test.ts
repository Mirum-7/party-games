import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { WordAssignment } from "@/generated/prisma/client";
import { GameCommandError } from "@/server/core/games/errors";
import type { GameErrorCode, GameErrorStatus } from "@/server/core/games/errors";
import { createGame, joinGame, updateSettings } from "@/server/core/games/service";
import { setReadiness } from "@/server/core/players/service";
import type { GameRealtime } from "@/server/core/realtime/types";
import { prisma } from "@/server/db";
import { getGameDefinition } from "@/server/games/registry";
import { getGameState } from "@/server/games/state";
import { startWordChain, submitWord } from "@/server/games/word-chain/service";
import type { Capabilities, PlayerSummary } from "@/shared/contracts/game";
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

type ViewerKey = "masha" | "petya" | "vanya" | "sasha";

const VIEWER_ORDER: readonly ViewerKey[] = ["masha", "petya", "vanya", "sasha"];
const ALL_VIEWERS: ReadonlySet<ViewerKey> = new Set(VIEWER_ORDER);

const NAMES: Record<ViewerKey, string> = {
  masha: "Маша",
  petya: "Петя",
  vanya: "Ваня",
  sasha: "Саша",
};

// Канарейки уникальны для каждого автора: сравнение идёт с сериализованным
// JSON всего ответа, поэтому секрет виден в любом поле, куда он попал.
const SECRETS: Record<ViewerKey, string> = {
  masha: "SECRET_MASHA_01",
  petya: "SECRET_PETYA_02",
  vanya: "SECRET_VANYA_03",
  sasha: "SECRET_SASHA_04",
};
const ALL_SECRETS: readonly string[] = VIEWER_ORDER.map((key) => SECRETS[key]);

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

type Room = {
  gameId: string;
  code: string;
  hostKey: ViewerKey;
  playerIds: Record<ViewerKey, string>;
};

async function createRoom(options?: { ready?: readonly ViewerKey[]; hideTargetNames?: boolean }): Promise<Room> {
  const created = await createGame({ definition, name: NAMES.masha });
  const playerIds = { masha: created.playerId } as Record<ViewerKey, string>;
  for (const key of VIEWER_ORDER.slice(1)) {
    const joined = await joinGame({
      definition,
      code: created.code,
      name: NAMES[key],
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });
    playerIds[key] = joined.value.playerId;
  }
  if (options?.hideTargetNames) {
    await updateSettings({
      definition,
      code: created.code,
      playerId: created.playerId,
      settings: { hideTargetNamesDuringSetup: true },
      realtime: createSpyRealtime().realtime,
    });
  }
  for (const key of options?.ready ?? []) {
    await setReadiness({
      code: created.code,
      playerId: playerIds[key],
      ready: true,
      realtime: createSpyRealtime().realtime,
    });
  }
  return { gameId: created.gameId, code: created.code, hostKey: "masha", playerIds };
}

async function startAssigning(room: Room): Promise<void> {
  await startWordChain({
    code: room.code,
    playerId: room.playerIds[room.hostKey],
    realtime: createSpyRealtime().realtime,
  });
}

async function submitWords(room: Room, keys: readonly ViewerKey[]): Promise<void> {
  for (const key of keys) {
    await submitWord({
      code: room.code,
      playerId: room.playerIds[key],
      word: SECRETS[key],
      realtime: createSpyRealtime().realtime,
    });
  }
}

type Cycle = {
  assignments: WordAssignment[];
  targetOfAuthor: Record<ViewerKey, ViewerKey>;
  authorOfTarget: Record<ViewerKey, ViewerKey>;
};

async function loadCycle(room: Room): Promise<Cycle> {
  const rows = await prisma.wordAssignment.findMany({ where: { gameId: room.gameId } });
  const keyById = new Map<string, ViewerKey>(Object.entries(room.playerIds).map(([key, id]) => [id, key as ViewerKey]));
  const targetOfAuthor = {} as Record<ViewerKey, ViewerKey>;
  const authorOfTarget = {} as Record<ViewerKey, ViewerKey>;
  for (const row of rows) {
    const author = keyById.get(row.authorPlayerId);
    const target = keyById.get(row.targetPlayerId);
    if (!author || !target) throw new Error("FIXTURE_BROKEN");
    targetOfAuthor[author] = target;
    authorOfTarget[target] = author;
  }
  return { assignments: rows, targetOfAuthor, authorOfTarget };
}

function keyByPlayerId(room: Room): Map<string, ViewerKey> {
  return new Map<string, ViewerKey>(Object.entries(room.playerIds).map(([key, id]) => [id, key as ViewerKey]));
}

async function orderedPlayerIds(gameId: string): Promise<string[]> {
  const players = await prisma.player.findMany({
    where: { gameId },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
  });
  return players.map((player) => player.id);
}

function expectedPlayers(input: {
  room: Room;
  orderedIds: string[];
  ready: ReadonlySet<ViewerKey>;
  submitted: ReadonlySet<ViewerKey>;
  guessed: ReadonlySet<ViewerKey>;
}): PlayerSummary[] {
  const keyById = keyByPlayerId(input.room);
  return input.orderedIds.map((id) => {
    const key = keyById.get(id);
    if (!key) throw new Error("FIXTURE_BROKEN");
    return {
      id,
      name: NAMES[key],
      isHost: key === input.room.hostKey,
      isReady: input.ready.has(key),
      hasSubmittedWord: input.submitted.has(key),
      hasGuessed: input.guessed.has(key),
    };
  });
}

function capabilities(partial: Partial<Capabilities>): Capabilities {
  return {
    canEditSettings: false,
    canManagePlayers: false,
    canStart: false,
    canSubmitWord: false,
    canMarkGuessed: false,
    canFinish: false,
    canCancel: false,
    canLeave: false,
    ...partial,
  };
}

function expectSecretsAbsent(serialized: string, secrets: readonly string[]): void {
  for (const secret of secrets) expect(serialized).not.toContain(secret);
}

function expectSecretsPresent(serialized: string, secrets: readonly string[]): void {
  for (const secret of secrets) expect(serialized).toContain(secret);
}

function byCreatedAtId(a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }): number {
  const diff = a.createdAt.getTime() - b.createdAt.getTime();
  if (diff !== 0) return diff;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

describe("getGameState: доступ", () => {
  test("неизвестная комната — GAME_NOT_FOUND 404", async () => {
    const room = await createRoom();
    await expectGameError(getGameState("ZZZZZZ", room.playerIds.masha), "GAME_NOT_FOUND", 404);
  });

  test("несуществующий зритель — UNAUTHENTICATED 401", async () => {
    const room = await createRoom();
    await expectGameError(getGameState(room.code, randomUUID()), "UNAUTHENTICATED", 401);
  });

  test("зритель из другой комнаты — FORBIDDEN 403", async () => {
    const room = await createRoom();
    const other = await createRoom();
    await expectGameError(getGameState(room.code, other.playerIds.masha), "FORBIDDEN", 403);
  });

  test("некорректный код комнаты — VALIDATION_ERROR 400", async () => {
    const room = await createRoom();
    await expectGameError(getGameState("AB", room.playerIds.masha), "VALIDATION_ERROR", 400);
  });

  test("код нормализуется: строчный код возвращает ту же комнату", async () => {
    const room = await createRoom();
    const state = await getGameState(room.code.toLowerCase(), room.playerIds.vanya);
    expect(state.game.code).toBe(room.code);
    expect(state.viewer.playerId).toBe(room.playerIds.vanya);
  });
});

describe("getGameState: LOBBY", () => {
  test("для каждого зрителя: общие поля, ростер по (joinedAt, id), права хоста и гостя, секретов нет", async () => {
    const room = await createRoom({ ready: VIEWER_ORDER });
    const orderedIds = await orderedPlayerIds(room.gameId);
    const game = await prisma.game.findUniqueOrThrow({ where: { id: room.gameId } });

    for (const key of VIEWER_ORDER) {
      const state = await getGameState(room.code, room.playerIds[key]);
      const serialized = JSON.stringify(state);
      const isHost = key === room.hostKey;

      expect(state).toEqual({
        game: {
          code: room.code,
          type: "WORD_CHAIN",
          phase: "LOBBY",
          revision: game.revision,
          minPlayers: 3,
          maxPlayers: 12,
          settings: { hideTargetNamesDuringSetup: false },
          startedAt: null,
          playingStartedAt: null,
          finishedAt: null,
        },
        viewer: { playerId: room.playerIds[key] },
        players: expectedPlayers({
          room,
          orderedIds,
          ready: ALL_VIEWERS,
          submitted: new Set(),
          guessed: new Set(),
        }),
        setup: null,
        hints: null,
        results: null,
        capabilities: capabilities(
          isHost
            ? { canEditSettings: true, canManagePlayers: true, canStart: true, canLeave: true }
            : { canLeave: true },
        ),
      });
      expectSecretsAbsent(serialized, ALL_SECRETS);
    }
  });

  test("не все готовы — canStart=false даже у хоста", async () => {
    const room = await createRoom({ ready: ["masha", "petya", "vanya"] });

    const host = await getGameState(room.code, room.playerIds.masha);
    expect(host.capabilities).toEqual(
      capabilities({ canEditSettings: true, canManagePlayers: true, canLeave: true }),
    );
  });

  test("меньше трёх участников — canStart=false даже когда все готовы", async () => {
    const created = await createGame({ definition, name: NAMES.masha });
    await joinGame({
      definition,
      code: created.code,
      name: NAMES.petya,
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });
    await setReadiness({
      code: created.code,
      playerId: created.playerId,
      ready: true,
      realtime: createSpyRealtime().realtime,
    });

    const state = await getGameState(created.code, created.playerId);
    expect(state.capabilities.canStart).toBe(false);
    expect(state.capabilities.canEditSettings).toBe(true);
  });

  test("настройка hideTargetNamesDuringSetup видна в лобби", async () => {
    const room = await createRoom({ hideTargetNames: true });

    const state = await getGameState(room.code, room.playerIds.masha);
    expect(state.game.settings).toEqual({ hideTargetNamesDuringSetup: true });
    expect(state.setup).toBeNull();
    expect(state.hints).toBeNull();
    expect(state.results).toBeNull();
  });
});

describe("getGameState: ASSIGNING_WORDS без скрытия адресата", () => {
  test("часть слов введена: собственный setup, флаги submitted, чужих слов нет", async () => {
    const room = await createRoom({ ready: VIEWER_ORDER });
    await startAssigning(room);
    await submitWords(room, ["masha", "petya"]);

    const cycle = await loadCycle(room);
    const orderedIds = await orderedPlayerIds(room.gameId);
    const game = await prisma.game.findUniqueOrThrow({ where: { id: room.gameId } });
    const submitted = new Set<ViewerKey>(["masha", "petya"]);

    for (const key of VIEWER_ORDER) {
      const state = await getGameState(room.code, room.playerIds[key]);
      const targetKey = cycle.targetOfAuthor[key];
      const ownWord = submitted.has(key) ? SECRETS[key] : null;

      expect(state).toEqual({
        game: {
          code: room.code,
          type: "WORD_CHAIN",
          phase: "ASSIGNING_WORDS",
          revision: game.revision,
          minPlayers: 3,
          maxPlayers: 12,
          settings: { hideTargetNamesDuringSetup: false },
          startedAt: game.startedAt!.toISOString(),
          playingStartedAt: null,
          finishedAt: null,
        },
        viewer: { playerId: room.playerIds[key] },
        players: expectedPlayers({ room, orderedIds, ready: ALL_VIEWERS, submitted, guessed: new Set() }),
        setup: {
          target: { id: room.playerIds[targetKey], name: NAMES[targetKey] },
          targetHidden: false,
          word: ownWord,
        },
        hints: null,
        results: null,
        capabilities: capabilities({ canSubmitWord: true }),
      });

      const serialized = JSON.stringify(state);
      const allowed = ownWord === null ? [] : [ownWord];
      expectSecretsPresent(serialized, allowed);
      expectSecretsAbsent(
        serialized,
        ALL_SECRETS.filter((secret) => !allowed.includes(secret)),
      );
    }
  });

  test("сохранённое слово можно редактировать до PLAYING: canSubmitWord остаётся true", async () => {
    const room = await createRoom({ ready: VIEWER_ORDER });
    await startAssigning(room);
    await submitWord({
      code: room.code,
      playerId: room.playerIds.masha,
      word: SECRETS.masha,
      realtime: createSpyRealtime().realtime,
    });
    await submitWord({
      code: room.code,
      playerId: room.playerIds.masha,
      word: "SECRET_MASHA_01_EDITED",
      realtime: createSpyRealtime().realtime,
    });

    const own = await getGameState(room.code, room.playerIds.masha);
    expect(own.setup?.word).toBe("SECRET_MASHA_01_EDITED");
    expect(own.capabilities.canSubmitWord).toBe(true);

    const other = await getGameState(room.code, room.playerIds.petya);
    expect(other.setup?.word).toBeNull();
    expectSecretsAbsent(JSON.stringify(other), ["SECRET_MASHA_01_EDITED", SECRETS.masha]);
  });
});

describe("getGameState: ASSIGNING_WORDS со скрытием адресата", () => {
  test("setup.target=null, targetHidden=true; id и имя адресата отсутствуют в setup; ростер сохранён", async () => {
    const room = await createRoom({ ready: VIEWER_ORDER, hideTargetNames: true });
    await startAssigning(room);
    await submitWords(room, ["masha"]);

    const cycle = await loadCycle(room);

    for (const key of VIEWER_ORDER) {
      const state = await getGameState(room.code, room.playerIds[key]);
      expect(state.game.settings).toEqual({ hideTargetNamesDuringSetup: true });
      expect(state.setup).toEqual({
        target: null,
        targetHidden: true,
        word: key === "masha" ? SECRETS.masha : null,
      });
      expect(state.hints).toBeNull();
      expect(state.results).toBeNull();
      expect(state.capabilities).toEqual(capabilities({ canSubmitWord: true }));

      const targetKey = cycle.targetOfAuthor[key];
      const setupSerialized = JSON.stringify(state.setup);
      expect(setupSerialized).not.toContain(room.playerIds[targetKey]);
      expect(setupSerialized).not.toContain(NAMES[targetKey]);

      // Общий ростер при этом сохраняется полностью.
      expect(state.players).toHaveLength(4);
      expect(JSON.stringify(state.players)).toContain(NAMES[targetKey]);
      expect(JSON.stringify(state.players)).toContain(room.playerIds[targetKey]);

      const serialized = JSON.stringify(state);
      const allowed = key === "masha" ? [SECRETS.masha] : [];
      expectSecretsPresent(serialized, allowed);
      expectSecretsAbsent(serialized, ALL_SECRETS.filter((secret) => !allowed.includes(secret)));
    }
  });
});

describe("getGameState: PLAYING", () => {
  test("после всех слов и одной отгадки: скрыто ровно собственное слово, флаги и права корректны", async () => {
    const room = await createRoom({ ready: VIEWER_ORDER });
    await startAssigning(room);
    await submitWords(room, VIEWER_ORDER);

    const wordChain = await prisma.wordChainGame.findUniqueOrThrow({ where: { gameId: room.gameId } });
    const playingStartedAt = wordChain.playingStartedAt!;
    // Петя отгадал первым (place=1); команды угадывания — Task 7, результат посеян напрямую.
    await prisma.gameResult.create({
      data: {
        gameId: room.gameId,
        playerId: room.playerIds.petya,
        place: 1,
        score: 4,
        finishedAt: new Date(playingStartedAt.getTime() + 90_000),
      },
    });

    const cycle = await loadCycle(room);
    const orderedIds = await orderedPlayerIds(room.gameId);
    const game = await prisma.game.findUniqueOrThrow({ where: { id: room.gameId } });
    const keyById = keyByPlayerId(room);
    const guessed = new Set<ViewerKey>(["petya"]);

    for (const key of VIEWER_ORDER) {
      const state = await getGameState(room.code, room.playerIds[key]);
      const hiddenAuthorKey = cycle.authorOfTarget[key];
      const targetedSecret = SECRETS[hiddenAuthorKey];

      expect(state.game.phase).toBe("PLAYING");
      expect(state.game.revision).toBe(game.revision);
      expect(state.game.startedAt).toBe(game.startedAt!.toISOString());
      expect(state.game.playingStartedAt).toBe(playingStartedAt.toISOString());
      expect(state.game.finishedAt).toBeNull();
      expect(state.setup).toBeNull();
      expect(state.results).toBeNull();

      // Ровно одно скрытое слово — назначение, адресатом которого является зритель.
      const hints = state.hints ?? [];
      expect(hints).toHaveLength(4);
      const hidden = hints.filter((hint) => hint.wordHidden);
      expect(hidden).toHaveLength(1);
      expect(hidden[0]!.target.id).toBe(room.playerIds[key]);
      expect(hidden[0]!.author.id).toBe(room.playerIds[hiddenAuthorKey]);
      expect(hidden[0]!.word).toBeNull();

      for (const hint of hints) {
        const authorKey = keyById.get(hint.author.id);
        if (!authorKey) throw new Error("FIXTURE_BROKEN");
        const targetKey = cycle.targetOfAuthor[authorKey];
        expect(hint.author).toEqual({ id: room.playerIds[authorKey], name: NAMES[authorKey] });
        expect(hint.target).toEqual({ id: room.playerIds[targetKey], name: NAMES[targetKey] });
        if (authorKey === hiddenAuthorKey) {
          expect(hint.word).toBeNull();
          expect(hint.wordHidden).toBe(true);
        } else {
          expect(hint.word).toBe(SECRETS[authorKey]);
          expect(hint.wordHidden).toBe(false);
        }
      }

      // Порядок hints — детерминированный (createdAt, id).
      const expectedOrder = [...cycle.assignments].sort(byCreatedAtId).map((assignment) => assignment.id);
      expect(hints.map((hint) => hint.assignmentId)).toEqual(expectedOrder);

      expect(state.players).toEqual(
        expectedPlayers({ room, orderedIds, ready: ALL_VIEWERS, submitted: ALL_VIEWERS, guessed }),
      );

      const isHost = key === room.hostKey;
      expect(state.capabilities).toEqual(
        capabilities({ canMarkGuessed: key !== "petya", canFinish: isHost }),
      );

      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain(targetedSecret);
      expectSecretsPresent(
        serialized,
        ALL_SECRETS.filter((secret) => secret !== targetedSecret),
      );
    }
  });
});

describe("getGameState: FINISHED", () => {
  test("все отгадали: рейтинг с местами, очками и длительностями, все слова раскрыты", async () => {
    const room = await createRoom({ ready: VIEWER_ORDER });
    await startAssigning(room);
    await submitWords(room, VIEWER_ORDER);

    const wordChain = await prisma.wordChainGame.findUniqueOrThrow({ where: { gameId: room.gameId } });
    const base = wordChain.playingStartedAt!;
    const seeded = [
      { key: "petya" as ViewerKey, place: 1, durationMs: 90_000 },
      { key: "masha" as ViewerKey, place: 2, durationMs: 120_000 },
      { key: "vanya" as ViewerKey, place: 3, durationMs: 150_000 },
      { key: "sasha" as ViewerKey, place: 4, durationMs: 180_000 },
    ];
    for (const item of seeded) {
      await prisma.gameResult.create({
        data: {
          gameId: room.gameId,
          playerId: room.playerIds[item.key],
          place: item.place,
          score: 4 - item.place + 1,
          finishedAt: new Date(base.getTime() + item.durationMs),
        },
      });
    }
    const finishedAt = new Date(base.getTime() + 200_000);
    await prisma.game.update({ where: { id: room.gameId }, data: { status: "FINISHED", finishedAt } });

    const orderedIds = await orderedPlayerIds(room.gameId);
    const game = await prisma.game.findUniqueOrThrow({ where: { id: room.gameId } });

    for (const key of VIEWER_ORDER) {
      const state = await getGameState(room.code, room.playerIds[key]);

      expect(state.game.phase).toBe("FINISHED");
      expect(state.game.revision).toBe(game.revision);
      expect(state.game.playingStartedAt).toBe(base.toISOString());
      expect(state.game.finishedAt).toBe(finishedAt.toISOString());
      expect(state.setup).toBeNull();

      const hints = state.hints ?? [];
      expect(hints).toHaveLength(4);
      expect(hints.every((hint) => hint.wordHidden === false && hint.word !== null)).toBe(true);

      expect(state.results).toEqual([
        { playerId: room.playerIds.petya, name: NAMES.petya, place: 1, score: 4, durationMs: 90_000 },
        { playerId: room.playerIds.masha, name: NAMES.masha, place: 2, score: 3, durationMs: 120_000 },
        { playerId: room.playerIds.vanya, name: NAMES.vanya, place: 3, score: 2, durationMs: 150_000 },
        { playerId: room.playerIds.sasha, name: NAMES.sasha, place: 4, score: 1, durationMs: 180_000 },
      ]);

      expect(state.players).toEqual(
        expectedPlayers({ room, orderedIds, ready: ALL_VIEWERS, submitted: ALL_VIEWERS, guessed: ALL_VIEWERS }),
      );
      expect(state.capabilities).toEqual(capabilities({}));
      expectSecretsPresent(JSON.stringify(state), ALL_SECRETS);
    }
  });

  test("досрочное завершение: не угадавшие без места и очков, durationMs=null, порядок по имени", async () => {
    const room = await createRoom({ ready: VIEWER_ORDER });
    await startAssigning(room);
    await submitWords(room, VIEWER_ORDER);

    const wordChain = await prisma.wordChainGame.findUniqueOrThrow({ where: { gameId: room.gameId } });
    const base = wordChain.playingStartedAt!;
    await prisma.gameResult.create({
      data: {
        gameId: room.gameId,
        playerId: room.playerIds.petya,
        place: 1,
        score: 4,
        finishedAt: new Date(base.getTime() + 90_000),
      },
    });
    await prisma.gameResult.create({
      data: {
        gameId: room.gameId,
        playerId: room.playerIds.masha,
        place: 2,
        score: 3,
        finishedAt: new Date(base.getTime() + 120_000),
      },
    });
    // Ваня остался с результатом без места; у Саши результата нет совсем.
    await prisma.gameResult.create({
      data: { gameId: room.gameId, playerId: room.playerIds.vanya, place: null, score: 0 },
    });
    await prisma.game.update({
      where: { id: room.gameId },
      data: { status: "FINISHED", finishedAt: new Date(base.getTime() + 200_000) },
    });

    const orderedIds = await orderedPlayerIds(room.gameId);
    const guessed = new Set<ViewerKey>(["petya", "masha"]);

    for (const key of VIEWER_ORDER) {
      const state = await getGameState(room.code, room.playerIds[key]);

      expect(state.game.phase).toBe("FINISHED");
      expect(state.results).toEqual([
        { playerId: room.playerIds.petya, name: NAMES.petya, place: 1, score: 4, durationMs: 90_000 },
        { playerId: room.playerIds.masha, name: NAMES.masha, place: 2, score: 3, durationMs: 120_000 },
        { playerId: room.playerIds.vanya, name: NAMES.vanya, place: null, score: 0, durationMs: null },
        { playerId: room.playerIds.sasha, name: NAMES.sasha, place: null, score: 0, durationMs: null },
      ]);

      const hints = state.hints ?? [];
      expect(hints).toHaveLength(4);
      expect(hints.every((hint) => hint.wordHidden === false && hint.word !== null)).toBe(true);

      // hasGuessed считается только по результату с местом.
      expect(state.players).toEqual(
        expectedPlayers({ room, orderedIds, ready: ALL_VIEWERS, submitted: ALL_VIEWERS, guessed }),
      );
      expect(state.capabilities).toEqual(capabilities({}));
      expectSecretsPresent(JSON.stringify(state), ALL_SECRETS);
    }
  });
});
