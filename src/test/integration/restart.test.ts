import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { GameCommandError } from "@/server/core/games/errors";
import type { GameErrorCode, GameErrorStatus } from "@/server/core/games/errors";
import { createGame, joinGame, updateSettings } from "@/server/core/games/service";
import { setReadiness } from "@/server/core/players/service";
import type { GameRealtime } from "@/server/core/realtime/types";
import { prisma } from "@/server/db";
import { getGameDefinition } from "@/server/games/registry";
import { getGameState } from "@/server/games/state";
import {
  finishWordChain,
  restartWordChain,
  startWordChain,
  submitWord,
} from "@/server/games/word-chain/service";
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
  const game = await prisma.game.findUniqueOrThrow({
    where: { id: gameId },
    include: { players: true, wordChain: true },
  });
  return game;
}

type ReadyRoom = {
  gameId: string;
  code: string;
  hostId: string;
  playerIds: string[];
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
  return { gameId: created.gameId, code: created.code, hostId: created.playerId, playerIds };
}

// Завершённая комната с включённым hideTargetNamesDuringSetup: настройки должны
// пережить сброс попытки.
async function createFinishedRoom(names: string[]): Promise<ReadyRoom> {
  const room = await createReadyRoom(names);
  await updateSettings({
    definition,
    code: room.code,
    playerId: room.hostId,
    settings: { hideTargetNamesDuringSetup: true },
    realtime: createSpyRealtime().realtime,
  });
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
  await finishWordChain({
    code: room.code,
    playerId: room.hostId,
    realtime: createSpyRealtime().realtime,
    now: () => new Date("2026-11-23T12:00:00.000Z"),
  });
  return room;
}

describe("restartWordChain", () => {
  test("админ в FINISHED сбрасывает попытку: LOBBY, очищены назначения/результаты/готовность/timestamps, настройки и состав сохранены, одна публикация", async () => {
    const room = await createFinishedRoom(["Маша", "Петя", "Ваня"]);
    const before = await prisma.game.findUniqueOrThrow({
      where: { id: room.gameId },
      include: { players: true, wordChain: true },
    });
    const { realtime, published } = createSpyRealtime();

    const result = await restartWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime,
    });

    expect(result.changed).toBe(true);
    expect(result.value).toEqual({ restarted: true });
    expect(result.revision).toBe(before.revision + 1);
    const after = await prisma.game.findUniqueOrThrow({
      where: { id: room.gameId },
      include: { players: true, wordChain: true },
    });
    expect(after.status).toBe("LOBBY");
    expect(after.startedAt).toBeNull();
    expect(after.finishedAt).toBeNull();
    expect(after.wordChain?.phase).toBeNull();
    expect(after.wordChain?.playingStartedAt).toBeNull();
    expect(after.wordChain?.hideTargetNamesDuringSetup).toBe(true);
    expect(after.players).toHaveLength(3);
    expect(after.players.every((player) => !player.isReady)).toBe(true);
    expect(await prisma.wordAssignment.count({ where: { gameId: room.gameId } })).toBe(0);
    expect(await prisma.gameResult.count({ where: { gameId: room.gameId } })).toBe(0);
    for (const playerId of room.playerIds) {
      const state = await getGameState(room.code, playerId);
      expect(state.game.phase).toBe("LOBBY");
      expect(state.setup).toBeNull();
      expect(state.hints).toBeNull();
      expect(state.results).toBeNull();
      for (const player of state.players) {
        expect(player.hasSubmittedWord).toBe(false);
        expect(player.hasGuessed).toBe(false);
      }
    }
    expect(published).toEqual([{ gameId: room.gameId, revision: result.revision }]);
  });

  test("не админ в FINISHED получает 403, состояние комнаты не меняется", async () => {
    const room = await createFinishedRoom(["Маша", "Петя", "Ваня"]);
    const before = await loadGame(room.gameId);

    await expectGameError(
      restartWordChain({
        code: room.code,
        playerId: room.playerIds[1]!,
        realtime: createSpyRealtime().realtime,
      }),
      "FORBIDDEN",
      403,
    );

    const after = await loadGame(room.gameId);
    expect(after.status).toBe("FINISHED");
    expect(after.revision).toBe(before.revision);
    expect(await prisma.wordAssignment.count({ where: { gameId: room.gameId } })).toBe(3);
    expect(await prisma.gameResult.count({ where: { gameId: room.gameId } })).toBe(3);
  });

  test("в ACTIVE (ASSIGNING_WORDS и PLAYING) — 409 INVALID_GAME_STATE", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);

    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });
    await expectGameError(
      restartWordChain({
        code: room.code,
        playerId: room.hostId,
        realtime: createSpyRealtime().realtime,
      }),
      "INVALID_GAME_STATE",
      409,
    );

    await startPlayingPhase(room);
    await expectGameError(
      restartWordChain({
        code: room.code,
        playerId: room.hostId,
        realtime: createSpyRealtime().realtime,
      }),
      "INVALID_GAME_STATE",
      409,
    );

    const game = await loadGame(room.gameId);
    expect(game.status).toBe("ACTIVE");
    expect(game.wordChain?.phase).toBe("PLAYING");
  });

  test("в LOBBY — no-op: ревизия не растёт, публикации нет, готовность сохранена", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    const before = await loadGame(room.gameId);
    const { realtime, published } = createSpyRealtime();

    const result = await restartWordChain({ code: room.code, playerId: room.hostId, realtime });

    expect(result.changed).toBe(false);
    expect(result.value).toEqual({ restarted: false });
    expect(result.revision).toBe(before.revision);
    const after = await loadGame(room.gameId);
    expect(after.revision).toBe(before.revision);
    expect(after.status).toBe("LOBBY");
    expect(after.players.every((player) => player.isReady)).toBe(true);
    expect(published).toEqual([]);
  });

  test("два одновременных restart сериализуются блокировкой: одно изменение, ревизия +1, одна публикация", async () => {
    const room = await createFinishedRoom(["Маша", "Петя", "Ваня"]);
    const before = await loadGame(room.gameId);
    const { realtime, published } = createSpyRealtime();

    const [first, second] = await Promise.all([
      restartWordChain({ code: room.code, playerId: room.hostId, realtime }),
      restartWordChain({ code: room.code, playerId: room.hostId, realtime }),
    ]);

    const changed = [first, second].filter((outcome) => outcome.changed);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.value).toEqual({ restarted: true });
    const after = await loadGame(room.gameId);
    expect(after.status).toBe("LOBBY");
    expect(after.revision).toBe(before.revision + 1);
    expect(published).toEqual([{ gameId: room.gameId, revision: before.revision + 1 }]);
  });
});

describe("restartWordChain: проекция capabilities", () => {
  test("в FINISHED canRestart=true и canLeave=true только у хоста", async () => {
    const room = await createFinishedRoom(["Маша", "Петя", "Ваня"]);

    for (const [index, playerId] of room.playerIds.entries()) {
      const state = await getGameState(room.code, playerId);
      expect(state.game.phase).toBe("FINISHED");
      expect(state.capabilities.canRestart).toBe(index === 0);
      expect(state.capabilities.canLeave).toBe(true);
    }
  });

  test("после рестарта в LOBBY у всех canRestart=false и canLeave=true", async () => {
    const room = await createFinishedRoom(["Маша", "Петя", "Ваня"]);
    await restartWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });

    for (const playerId of room.playerIds) {
      const state = await getGameState(room.code, playerId);
      expect(state.game.phase).toBe("LOBBY");
      expect(state.capabilities.canRestart).toBe(false);
      expect(state.capabilities.canLeave).toBe(true);
    }
  });

  test("в ASSIGNING_WORDS и PLAYING у хоста canRestart=false и canLeave=false", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });

    let state = await getGameState(room.code, room.hostId);
    expect(state.game.phase).toBe("ASSIGNING_WORDS");
    expect(state.capabilities.canRestart).toBe(false);
    expect(state.capabilities.canLeave).toBe(false);

    await startPlayingPhase(room);
    state = await getGameState(room.code, room.hostId);
    expect(state.game.phase).toBe("PLAYING");
    expect(state.capabilities.canRestart).toBe(false);
    expect(state.capabilities.canLeave).toBe(false);
  });
});

// Ввод всех слов после старта: переход ASSIGNING_WORDS → PLAYING.
async function startPlayingPhase(room: ReadyRoom): Promise<void> {
  for (const [index, playerId] of room.playerIds.entries()) {
    await submitWord({
      code: room.code,
      playerId,
      word: `слово-${index}`,
      realtime: createSpyRealtime().realtime,
    });
  }
}
