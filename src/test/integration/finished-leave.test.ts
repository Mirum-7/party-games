import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { GameType } from "@/generated/prisma/client";
import { GameCommandError } from "@/server/core/games/errors";
import type { GameErrorCode, GameErrorStatus } from "@/server/core/games/errors";
import { createGame, joinGame, updateSettings } from "@/server/core/games/service";
import type { GameDefinition } from "@/server/core/games/types";
import { leaveGame, setReadiness } from "@/server/core/players/service";
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
  return prisma.game.findUniqueOrThrow({
    where: { id: gameId },
    include: { players: true, wordChain: true },
  });
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
// пережить сброс попытки при выходе.
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

function sortedIds(ids: string[]): string[] {
  return [...ids].sort();
}

describe("leaveGame из FINISHED", () => {
  test("выход не-админа сбрасывает попытку: LOBBY, удалены назначения/результаты, готовность сброшена, одна публикация", async () => {
    const room = await createFinishedRoom(["Маша", "Петя", "Ваня"]);
    const guestId = room.playerIds[1]!;
    const before = await loadGame(room.gameId);
    const { realtime, published } = createSpyRealtime();

    const result = await leaveGame({
      code: room.code,
      playerId: guestId,
      realtime,
      resolveDefinition: getGameDefinition,
    });

    expect(result.changed).toBe(true);
    expect(result.value.roomDeleted).toBe(false);
    const game = await prisma.game.findUniqueOrThrow({
      where: { id: room.gameId },
      include: { players: true, wordChain: true },
    });
    expect(game.status).toBe("LOBBY");
    expect(game.startedAt).toBeNull();
    expect(game.finishedAt).toBeNull();
    expect(game.wordChain?.phase).toBeNull();
    expect(game.wordChain?.hideTargetNamesDuringSetup).toBe(true);
    expect(game.players.map((player) => player.id)).not.toContain(guestId);
    expect(game.players.every((player) => !player.isReady)).toBe(true);
    expect(await prisma.wordAssignment.count({ where: { gameId: room.gameId } })).toBe(0);
    expect(await prisma.gameResult.count({ where: { gameId: room.gameId } })).toBe(0);
    for (const playerId of [room.hostId, room.playerIds[2]!]) {
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
    expect(game.revision).toBe(before.revision + 1);
    expect(published).toEqual([{ gameId: room.gameId, revision: before.revision + 1 }]);
  });

  test("выход админа передаёт роль самому раннему оставшемуся по (joinedAt, id)", async () => {
    const room = await createFinishedRoom(["Маша", "Петя", "Ваня"]);
    const { realtime, published } = createSpyRealtime();

    const result = await leaveGame({
      code: room.code,
      playerId: room.hostId,
      realtime,
      resolveDefinition: getGameDefinition,
    });

    expect(result.value.roomDeleted).toBe(false);
    const game = await loadGame(room.gameId);
    expect(game.status).toBe("LOBBY");
    expect(game.hostPlayerId).toBe(room.playerIds[1]);
    expect(sortedIds(game.players.map((player) => player.id))).toEqual(
      sortedIds([room.playerIds[1]!, room.playerIds[2]!]),
    );
    expect(game.players.every((player) => !player.isReady)).toBe(true);
    expect(await prisma.wordAssignment.count({ where: { gameId: room.gameId } })).toBe(0);
    expect(await prisma.gameResult.count({ where: { gameId: room.gameId } })).toBe(0);
    expect(published).toHaveLength(1);
  });

  test("выход последнего игрока после FINISHED удаляет комнату без публикации", async () => {
    const room = await createFinishedRoom(["Маша", "Петя", "Ваня"]);

    await leaveGame({
      code: room.code,
      playerId: room.playerIds[2]!,
      realtime: createSpyRealtime().realtime,
      resolveDefinition: getGameDefinition,
    });
    await leaveGame({
      code: room.code,
      playerId: room.playerIds[1]!,
      realtime: createSpyRealtime().realtime,
      resolveDefinition: getGameDefinition,
    });

    const { realtime, published } = createSpyRealtime();
    const result = await leaveGame({
      code: room.code,
      playerId: room.hostId,
      realtime,
      resolveDefinition: getGameDefinition,
    });

    expect(result.changed).toBe(true);
    expect(result.value.roomDeleted).toBe(true);
    expect(await prisma.game.findUnique({ where: { id: room.gameId } })).toBeNull();
    expect(await prisma.player.count({ where: { gameId: room.gameId } })).toBe(0);
    expect(await prisma.wordAssignment.count()).toBe(0);
    expect(await prisma.gameResult.count()).toBe(0);
    expect(published).toEqual([]);
  });

  test("новый вход после выхода из FINISHED создаёт игрока с новым id и isReady=false", async () => {
    const room = await createFinishedRoom(["Маша", "Петя", "Ваня"]);
    const guestId = room.playerIds[1]!;

    await leaveGame({
      code: room.code,
      playerId: guestId,
      realtime: createSpyRealtime().realtime,
      resolveDefinition: getGameDefinition,
    });

    const { realtime, published } = createSpyRealtime();
    const rejoined = await joinGame({
      definition,
      code: room.code,
      name: "Петя",
      playerId: null,
      realtime,
    });

    expect(rejoined.changed).toBe(true);
    expect(rejoined.value.isNewPlayer).toBe(true);
    expect(rejoined.value.playerId).not.toBe(guestId);

    const game = await loadGame(room.gameId);
    expect(game.status).toBe("LOBBY");
    expect(game.players).toHaveLength(3);
    const newcomer = game.players.find((player) => player.id === rejoined.value.playerId)!;
    expect(newcomer.isReady).toBe(false);
    expect(game.players.every((player) => !player.isReady)).toBe(true);
    expect(published).toEqual([{ gameId: room.gameId, revision: rejoined.revision }]);
  });

  test("выход в ACTIVE (ASSIGNING_WORDS и PLAYING) отклоняется с 409 без изменений", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });
    const { realtime, published } = createSpyRealtime();

    await expectGameError(
      leaveGame({
        code: room.code,
        playerId: room.playerIds[1]!,
        realtime,
        resolveDefinition: getGameDefinition,
      }),
      "INVALID_GAME_STATE",
      409,
    );

    for (const [index, playerId] of room.playerIds.entries()) {
      await submitWord({
        code: room.code,
        playerId,
        word: `слово-${index}`,
        realtime: createSpyRealtime().realtime,
      });
    }
    await expectGameError(
      leaveGame({
        code: room.code,
        playerId: room.playerIds[1]!,
        realtime,
        resolveDefinition: getGameDefinition,
      }),
      "INVALID_GAME_STATE",
      409,
    );

    const game = await loadGame(room.gameId);
    expect(game.status).toBe("ACTIVE");
    expect(game.wordChain?.phase).toBe("PLAYING");
    expect(await prisma.wordAssignment.count({ where: { gameId: room.gameId } })).toBe(3);
    expect(await prisma.gameResult.count({ where: { gameId: room.gameId } })).toBe(0);
    expect(published).toEqual([]);
  });

  test("одновременные restart и leave сериализуются в одно согласованное финальное состояние", async () => {
    const room = await createFinishedRoom(["Маша", "Петя", "Ваня"]);
    const before = await loadGame(room.gameId);
    const { realtime, published } = createSpyRealtime();

    const [restartOutcome, leaveOutcome] = await Promise.all([
      restartWordChain({ code: room.code, playerId: room.hostId, realtime }),
      leaveGame({
        code: room.code,
        playerId: room.playerIds[1]!,
        realtime,
        resolveDefinition: getGameDefinition,
      }),
    ]);

    const changedCount = [restartOutcome, leaveOutcome].filter((outcome) => outcome.changed).length;
    const after = await loadGame(room.gameId);
    expect(after.status).toBe("LOBBY");
    expect(after.hostPlayerId).toBe(room.hostId);
    expect(sortedIds(after.players.map((player) => player.id))).toEqual(
      sortedIds([room.hostId, room.playerIds[2]!]),
    );
    expect(after.players.every((player) => !player.isReady)).toBe(true);
    expect(after.revision).toBe(before.revision + changedCount);
    expect(await prisma.wordAssignment.count({ where: { gameId: room.gameId } })).toBe(0);
    expect(await prisma.gameResult.count({ where: { gameId: room.gameId } })).toBe(0);
    expect(published).toHaveLength(changedCount);
    expect(published.map((item) => item.revision)).toEqual(
      Array.from({ length: changedCount }, (_, index) => before.revision + 1 + index),
    );
    expect(published.every((item) => item.gameId === room.gameId)).toBe(true);
  });

  test("resetAttempt, оставляющий записи других участников, даёт доменный 409 и полный откат", async () => {
    const room = await createFinishedRoom(["Маша", "Петя", "Ваня"]);
    const guestId = room.playerIds[1]!;
    const before = await loadGame(room.gameId);

    // Некорректная реализация модуля: выполняет полный сброс, но затем вновь
    // оставляет запись попытки другого участника. Post-condition Core проверяет
    // записи по всему gameId, а не только выходящего, поэтому такой модуль
    // обязан получить INVALID_GAME_STATE 409, а транзакция — откатиться.
    const definitionLeavingRecords: GameDefinition = {
      ...definition,
      resetAttempt: async (tx, gameId) => {
        await definition.resetAttempt(tx, gameId);
        await tx.wordAssignment.create({
          data: {
            gameId,
            authorPlayerId: room.playerIds[2]!,
            targetPlayerId: room.hostId,
            word: "остаток",
            submittedAt: new Date("2026-11-23T12:00:00.000Z"),
            createdAt: new Date("2026-11-23T12:00:00.000Z"),
          },
        });
      },
    };
    const resolveLeavingRecords = (type: GameType): GameDefinition => {
      expect(type).toBe("WORD_CHAIN");
      return definitionLeavingRecords;
    };

    const error = await expectGameError(
      leaveGame({
        code: room.code,
        playerId: guestId,
        realtime: createSpyRealtime().realtime,
        resolveDefinition: resolveLeavingRecords,
      }),
      "INVALID_GAME_STATE",
      409,
    );
    expect(error.message).toContain("игровые записи");

    const game = await loadGame(room.gameId);
    expect(game.status).toBe("FINISHED");
    expect(game.revision).toBe(before.revision);
    expect(game.players.map((player) => player.id)).toContain(guestId);
    expect(game.players.every((player) => player.isReady)).toBe(true);
    expect(await prisma.wordAssignment.count({ where: { gameId: room.gameId } })).toBe(3);
    expect(await prisma.gameResult.count({ where: { gameId: room.gameId } })).toBe(3);
  });
});
