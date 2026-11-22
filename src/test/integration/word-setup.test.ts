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
  cancelWordChain,
  startWordChain,
  submitWord,
} from "@/server/games/word-chain/service";
import { assertSingleCycle } from "@/server/games/word-chain/rules";
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

async function loadAssignments(gameId: string) {
  return prisma.wordAssignment.findMany({ where: { gameId } });
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

describe("startWordChain", () => {
  test("админ запускает игру: ACTIVE/ASSIGNING_WORDS, startedAt, N назначений, один цикл, revision+1, публикация", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    const { realtime, published } = createSpyRealtime();

    const result = await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime,
    });

    expect(result.changed).toBe(true);
    expect(result.revision).toBe(room.baseRevision + 1);
    expect(result.value.playerCount).toBe(3);

    const game = await loadGame(room.gameId);
    expect(game.status).toBe("ACTIVE");
    expect(game.startedAt).not.toBeNull();
    expect(game.revision).toBe(room.baseRevision + 1);
    expect(game.wordChain?.phase).toBe("ASSIGNING_WORDS");

    const assignments = await loadAssignments(room.gameId);
    expect(assignments).toHaveLength(3);
    assertSingleCycle(
      assignments.map((a) => ({
        authorPlayerId: a.authorPlayerId,
        targetPlayerId: a.targetPlayerId,
      })),
    );
    // Никакое слово ещё не введено.
    expect(assignments.every((a) => a.word === null && a.submittedAt === null)).toBe(true);

    expect(published).toEqual([{ gameId: room.gameId, revision: room.baseRevision + 1 }]);
  });

  test("запуск для каждого N=3..12 создаёт ровно N назначений одним циклом", async () => {
    for (let n = 3; n <= 12; n += 1) {
      const names = Array.from({ length: n }, (_, i) => `Игрок${i + 1}`);
      const room = await createReadyRoom(names);

      await startWordChain({
        code: room.code,
        playerId: room.hostId,
        realtime: createSpyRealtime().realtime,
      });

      const assignments = await loadAssignments(room.gameId);
      expect(assignments).toHaveLength(n);
      assertSingleCycle(
        assignments.map((a) => ({
          authorPlayerId: a.authorPlayerId,
          targetPlayerId: a.targetPlayerId,
        })),
      );
    }
  });

  test("не админ не может запустить игру", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);

    await expectGameError(
      Promise.resolve(
        startWordChain({
          code: room.code,
          playerId: room.playerIds[1]!,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "FORBIDDEN",
      403,
    );

    const game = await loadGame(room.gameId);
    expect(game.status).toBe("LOBBY");
    expect(game.revision).toBe(room.baseRevision);
    expect(await loadAssignments(room.gameId)).toHaveLength(0);
  });

  test("запуск с двумя участниками — NOT_ENOUGH_PLAYERS", async () => {
    const created = await createGame({ definition, name: "Маша" });
    await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });
    await setReadiness({
      code: created.code,
      playerId: created.playerId,
      ready: true,
      realtime: createSpyRealtime().realtime,
    });

    await expectGameError(
      Promise.resolve(
        startWordChain({
          code: created.code,
          playerId: created.playerId,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "NOT_ENOUGH_PLAYERS",
      409,
    );

    const game = await loadGame(created.gameId);
    expect(game.status).toBe("LOBBY");
    expect(await loadAssignments(created.gameId)).toHaveLength(0);
  });

  test("запуск с неготовым участником — NOT_ALL_READY", async () => {
    const created = await createGame({ definition, name: "Маша" });
    for (const name of ["Петя", "Ваня"]) {
      await joinGame({
        definition,
        code: created.code,
        name,
        playerId: null,
        realtime: createSpyRealtime().realtime,
      });
    }
    // Только админ готов.
    await setReadiness({
      code: created.code,
      playerId: created.playerId,
      ready: true,
      realtime: createSpyRealtime().realtime,
    });

    await expectGameError(
      Promise.resolve(
        startWordChain({
          code: created.code,
          playerId: created.playerId,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "NOT_ALL_READY",
      409,
    );

    const game = await loadGame(created.gameId);
    expect(game.status).toBe("LOBBY");
    expect(await loadAssignments(created.gameId)).toHaveLength(0);
  });

  test("повторный запуск вне LOBBY — INVALID_GAME_STATE", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });

    await expectGameError(
      Promise.resolve(
        startWordChain({
          code: room.code,
          playerId: room.hostId,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );

    const game = await loadGame(room.gameId);
    expect(await loadAssignments(room.gameId)).toHaveLength(3);
    expect(game.revision).toBe(room.baseRevision + 1);
  });

  test("два одновременных старта: один успех, без дубликатов и частичной записи", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);

    const [first, second] = await Promise.allSettled(
      [1, 2].map(() =>
        startWordChain({
          code: room.code,
          playerId: room.hostId,
          realtime: createSpyRealtime().realtime,
        }),
      ),
    );

    const outcomes = [first, second];
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]!.status === "rejected") {
      expect(rejected[0]!.reason).toBeInstanceOf(GameCommandError);
      expect((rejected[0]!.reason as GameCommandError).code).toBe("INVALID_GAME_STATE");
    }

    const game = await loadGame(room.gameId);
    expect(game.status).toBe("ACTIVE");
    expect(game.startedAt).not.toBeNull();
    expect(game.revision).toBe(room.baseRevision + 1);
    expect(game.wordChain?.phase).toBe("ASSIGNING_WORDS");

    const assignments = await loadAssignments(room.gameId);
    expect(assignments).toHaveLength(3);
    assertSingleCycle(
      assignments.map((a) => ({
        authorPlayerId: a.authorPlayerId,
        targetPlayerId: a.targetPlayerId,
      })),
    );
  });
});

describe("submitWord", () => {
  test("игрок сохраняет собственное слово: trim, submittedAt, revision+1, публикация", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });
    const { realtime, published } = createSpyRealtime();

    const result = await submitWord({
      code: room.code,
      playerId: room.playerIds[1]!,
      word: "  лесная  поляна  ",
      realtime,
    });

    expect(result.changed).toBe(true);
    expect(result.revision).toBe(room.baseRevision + 2);
    // В ответе — только собственное слово, без назначений и чужих слов.
    expect(result.value).toEqual({ word: "лесная  поляна", phase: "ASSIGNING_WORDS" });

    const assignments = await loadAssignments(room.gameId);
    const own = assignments.find((a) => a.authorPlayerId === room.playerIds[1]!)!;
    expect(own.word).toBe("лесная  поляна");
    expect(own.submittedAt).not.toBeNull();
    expect(assignments.filter((a) => a.word !== null)).toHaveLength(1);

    const game = await loadGame(room.gameId);
    expect(game.revision).toBe(room.baseRevision + 2);
    expect(game.wordChain?.phase).toBe("ASSIGNING_WORDS");
    expect(published).toEqual([{ gameId: room.gameId, revision: room.baseRevision + 2 }]);
  });

  test("отклоняет пустое слово и слово длиннее 80 code points с fieldErrors", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });

    const empty = await expectGameError(
      Promise.resolve(
        submitWord({
          code: room.code,
          playerId: room.playerIds[0]!,
          word: "   ",
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "VALIDATION_ERROR",
      400,
    );
    expect(empty.fieldErrors?.word).toBeDefined();

    await expectGameError(
      Promise.resolve(
        submitWord({
          code: room.code,
          playerId: room.playerIds[0]!,
          word: "ы".repeat(81),
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "VALIDATION_ERROR",
      400,
    );

    // Граница 80 code points принимается.
    const boundary = await submitWord({
      code: room.code,
      playerId: room.playerIds[0]!,
      word: "ы".repeat(80),
      realtime: createSpyRealtime().realtime,
    });
    expect(boundary.changed).toBe(true);

    const game = await loadGame(room.gameId);
    expect(game.revision).toBe(room.baseRevision + 2);
  });

  test("повтор того же нормализованного слова — no-op без ревизии и публикации", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });
    const { realtime, published } = createSpyRealtime();

    await submitWord({
      code: room.code,
      playerId: room.playerIds[0]!,
      word: "самолёт",
      realtime,
    });
    const again = await submitWord({
      code: room.code,
      playerId: room.playerIds[0]!,
      word: "  самолёт  ",
      realtime,
    });

    expect(again.changed).toBe(false);
    expect(again.revision).toBe(room.baseRevision + 2);
    const game = await loadGame(room.gameId);
    expect(game.revision).toBe(room.baseRevision + 2);
    expect(game.wordChain?.phase).toBe("ASSIGNING_WORDS");
    expect(published).toEqual([{ gameId: room.gameId, revision: room.baseRevision + 2 }]);
  });

  test("автор может редактировать слово до PLAYING", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });

    await submitWord({
      code: room.code,
      playerId: room.playerIds[0]!,
      word: "первый вариант",
      realtime: createSpyRealtime().realtime,
    });
    const edited = await submitWord({
      code: room.code,
      playerId: room.playerIds[0]!,
      word: "второй вариант",
      realtime: createSpyRealtime().realtime,
    });

    expect(edited.changed).toBe(true);
    expect(edited.revision).toBe(room.baseRevision + 3);
    const assignments = await loadAssignments(room.gameId);
    const own = assignments.find((a) => a.authorPlayerId === room.playerIds[0]!)!;
    expect(own.word).toBe("второй вариант");
  });

  test("последнее слово атомарно переводит в PLAYING с playingStartedAt и одним приращением ревизии", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });

    const first = await submitWord({
      code: room.code,
      playerId: room.playerIds[0]!,
      word: "альфа",
      realtime: createSpyRealtime().realtime,
    });
    const second = await submitWord({
      code: room.code,
      playerId: room.playerIds[1]!,
      word: "бета",
      realtime: createSpyRealtime().realtime,
    });
    expect(first.value.phase).toBe("ASSIGNING_WORDS");
    expect(second.value.phase).toBe("ASSIGNING_WORDS");

    const last = await submitWord({
      code: room.code,
      playerId: room.playerIds[2]!,
      word: "гамма",
      realtime: createSpyRealtime().realtime,
    });

    expect(last.changed).toBe(true);
    expect(last.value.phase).toBe("PLAYING");
    expect(last.revision).toBe(room.baseRevision + 4);

    const game = await loadGame(room.gameId);
    expect(game.revision).toBe(room.baseRevision + 4);
    expect(game.wordChain?.phase).toBe("PLAYING");
    expect(game.wordChain?.playingStartedAt).not.toBeNull();
    expect(game.status).toBe("ACTIVE");

    const assignments = await loadAssignments(room.gameId);
    expect(assignments.every((a) => a.word !== null && a.submittedAt !== null)).toBe(true);
  });

  test("одновременные слова разных авторов не оставляют частичное финальное состояние", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });

    const results = await Promise.all(
      room.playerIds.map((playerId, i) =>
        submitWord({
          code: room.code,
          playerId,
          word: `слово-${i}`,
          realtime: createSpyRealtime().realtime,
        }),
      ),
    );

    const revisions = results.map((r) => r.revision).sort((a, b) => a - b);
    expect(revisions).toEqual([
      room.baseRevision + 2,
      room.baseRevision + 3,
      room.baseRevision + 4,
    ]);

    const game = await loadGame(room.gameId);
    expect(game.revision).toBe(room.baseRevision + 4);
    expect(game.wordChain?.phase).toBe("PLAYING");
    expect(game.wordChain?.playingStartedAt).not.toBeNull();

    const assignments = await loadAssignments(room.gameId);
    expect(assignments).toHaveLength(3);
    expect(assignments.every((a) => a.word !== null && a.submittedAt !== null)).toBe(true);
  });

  test("ввод слова после PLAYING отклоняется", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });
    for (const playerId of room.playerIds) {
      await submitWord({
        code: room.code,
        playerId,
        word: "слово",
        realtime: createSpyRealtime().realtime,
      });
    }

    await expectGameError(
      Promise.resolve(
        submitWord({
          code: room.code,
          playerId: room.playerIds[0]!,
          word: "другое",
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );

    const game = await loadGame(room.gameId);
    expect(game.revision).toBe(room.baseRevision + 4);
  });

  test("ввод слова в LOBBY отклоняется", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);

    await expectGameError(
      Promise.resolve(
        submitWord({
          code: room.code,
          playerId: room.playerIds[0]!,
          word: "слово",
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );
  });

  test("незарегистрированный игрок получает FORBIDDEN", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });

    await expectGameError(
      Promise.resolve(
        submitWord({
          code: room.code,
          playerId: randomUUID(),
          word: "слово",
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "FORBIDDEN",
      403,
    );
  });
});

describe("cancelWordChain", () => {
  test("отмена возвращает в LOBBY: удаляет назначения/результаты, сбрасывает готовность и timestamps, сохраняет игроков/админа/настройки", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });
    await submitWord({
      code: room.code,
      playerId: room.playerIds[0]!,
      word: "слово",
      realtime: createSpyRealtime().realtime,
    });
    // Результат текущей попытки (оставшийся, например, от гонки) тоже удаляется.
    await prisma.gameResult.create({
      data: { gameId: room.gameId, playerId: room.playerIds[1]!, place: null, score: 0 },
    });
    const revisionBeforeCancel = (await loadGame(room.gameId)).revision;

    const result = await cancelWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });

    expect(result.changed).toBe(true);
    expect(result.revision).toBe(revisionBeforeCancel + 1);

    const game = await loadGame(room.gameId);
    expect(game.status).toBe("LOBBY");
    expect(game.startedAt).toBeNull();
    expect(game.finishedAt).toBeNull();
    expect(game.revision).toBe(revisionBeforeCancel + 1);
    expect(game.hostPlayerId).toBe(room.hostId);
    expect(game.players).toHaveLength(3);
    expect(game.players.every((p) => p.isReady === false)).toBe(true);
    expect(game.wordChain?.phase).toBeNull();
    expect(game.wordChain?.playingStartedAt).toBeNull();
    expect(game.wordChain?.hideTargetNamesDuringSetup).toBe(false);

    expect(await loadAssignments(room.gameId)).toHaveLength(0);
    expect(await prisma.gameResult.count({ where: { gameId: room.gameId } })).toBe(0);
  });

  test("не админ не может отменить ввод слов", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });

    await expectGameError(
      Promise.resolve(
        cancelWordChain({
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
    expect(await loadAssignments(room.gameId)).toHaveLength(3);
  });

  test("отмена вне ASSIGNING_WORDS отклоняется: в LOBBY и в PLAYING", async () => {
    const lobbyRoom = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await expectGameError(
      Promise.resolve(
        cancelWordChain({
          code: lobbyRoom.code,
          playerId: lobbyRoom.hostId,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );

    const playingRoom = await createReadyRoom(["Оля", "Гриша", "Дима"]);
    await startWordChain({
      code: playingRoom.code,
      playerId: playingRoom.hostId,
      realtime: createSpyRealtime().realtime,
    });
    for (const playerId of playingRoom.playerIds) {
      await submitWord({
        code: playingRoom.code,
        playerId,
        word: "слово",
        realtime: createSpyRealtime().realtime,
      });
    }
    await expectGameError(
      Promise.resolve(
        cancelWordChain({
          code: playingRoom.code,
          playerId: playingRoom.hostId,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );

    const game = await loadGame(playingRoom.gameId);
    expect(game.status).toBe("ACTIVE");
    expect(game.wordChain?.phase).toBe("PLAYING");
  });

  test("после отмены повторная готовность и запуск работают, ревизия монотонна", async () => {
    const room = await createReadyRoom(["Маша", "Петя", "Ваня"]);
    await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });
    await submitWord({
      code: room.code,
      playerId: room.playerIds[0]!,
      word: "слово",
      realtime: createSpyRealtime().realtime,
    });
    const cancelResult = await cancelWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });
    const revisionAfterCancel = cancelResult.revision;

    for (const playerId of room.playerIds) {
      await setReadiness({
        code: room.code,
        playerId,
        ready: true,
        realtime: createSpyRealtime().realtime,
      });
    }
    const restart = await startWordChain({
      code: room.code,
      playerId: room.hostId,
      realtime: createSpyRealtime().realtime,
    });

    expect(restart.changed).toBe(true);
    expect(restart.revision).toBe(revisionAfterCancel + room.playerIds.length + 1);

    const game = await loadGame(room.gameId);
    expect(game.status).toBe("ACTIVE");
    expect(game.startedAt).not.toBeNull();
    expect(game.revision).toBeGreaterThan(revisionAfterCancel);
    expect(game.wordChain?.phase).toBe("ASSIGNING_WORDS");

    const assignments = await loadAssignments(room.gameId);
    expect(assignments).toHaveLength(3);
    assertSingleCycle(
      assignments.map((a) => ({
        authorPlayerId: a.authorPlayerId,
        targetPlayerId: a.targetPlayerId,
      })),
    );
  });
});
