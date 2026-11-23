import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { GameCommandError } from "@/server/core/games/errors";
import type { GameErrorCode, GameErrorStatus } from "@/server/core/games/errors";
import {
  createGameSchema,
  joinGameSchema,
  readinessSchema,
  wordChainSettingsSchema,
} from "@/server/core/games/schemas";
import { createGame, joinGame, updateSettings } from "@/server/core/games/service";
import { leaveGame, removePlayer, setReadiness } from "@/server/core/players/service";
import type { GameRealtime } from "@/server/core/realtime/types";
import { prisma } from "@/server/db";
import { getGameDefinition } from "@/server/games/registry";
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

describe("входные Zod-схемы", () => {
  test("отклоняют неизвестные поля и не принимают личность вызывающего из тела", () => {
    expect(createGameSchema.safeParse({ name: "Маша" }).success).toBe(true);
    expect(createGameSchema.safeParse({ name: "Маша", gameType: "WORD_CHAIN" }).success).toBe(true);
    expect(createGameSchema.safeParse({ name: "Маша", extra: 1 }).success).toBe(false);
    expect(createGameSchema.safeParse({ name: "Маша", playerId: "x" }).success).toBe(false);
    expect(createGameSchema.safeParse({}).success).toBe(false);

    expect(joinGameSchema.safeParse({ name: "Петя" }).success).toBe(true);
    expect(joinGameSchema.safeParse({ name: "Петя", playerId: "x" }).success).toBe(false);
    expect(joinGameSchema.safeParse({}).success).toBe(false);

    expect(readinessSchema.safeParse({ ready: true }).success).toBe(true);
    expect(readinessSchema.safeParse({ ready: true, playerId: "x" }).success).toBe(false);
    expect(readinessSchema.safeParse({ ready: "yes" }).success).toBe(false);

    expect(wordChainSettingsSchema.safeParse({ hideTargetNamesDuringSetup: true }).success).toBe(true);
    expect(wordChainSettingsSchema.safeParse({ hideTargetNamesDuringSetup: true, x: 1 }).success).toBe(false);
  });
});

describe("createGame", () => {
  test("создатель становится админом, не готов, настройки по умолчанию", async () => {
    const created = await createGame({ definition, name: "  Маша  " });

    expect(created.code).toHaveLength(6);
    expect(created.revision).toBe(0);

    const game = await loadGame(created.gameId);
    expect(game.type).toBe("WORD_CHAIN");
    expect(game.status).toBe("LOBBY");
    expect(game.code).toBe(created.code);
    expect(game.hostPlayerId).toBe(created.playerId);
    expect(game.revision).toBe(0);
    expect(game.wordChain?.hideTargetNamesDuringSetup).toBe(false);
    expect(game.wordChain?.phase).toBeNull();

    expect(game.players).toHaveLength(1);
    const creator = game.players[0];
    expect(creator.id).toBe(created.playerId);
    expect(creator.name).toBe("Маша");
    expect(creator.normalizedName).toBe("маша");
    expect(creator.isReady).toBe(false);
  });

  test("отклоняет пустое и слишком длинное имя с fieldErrors", async () => {
    const empty = await expectGameError(
      Promise.resolve(createGame({ definition, name: "   " })),
      "VALIDATION_ERROR",
      400,
    );
    expect(empty.fieldErrors?.name).toBeDefined();

    await expectGameError(
      Promise.resolve(createGame({ definition, name: "ы".repeat(25) })),
      "VALIDATION_ERROR",
      400,
    );
  });

  test("при коллизии уникального кода генерация повторяется", async () => {
    await prisma.game.create({
      data: { code: "AAAAAA", type: "WORD_CHAIN", status: "LOBBY" },
    });
    const ints = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
    const created = await createGame({
      definition,
      name: "Маша",
      randomInt: () => ints.shift() ?? 0,
    });
    expect(created.code).toBe("BBBBBB");
    expect(await prisma.game.count()).toBe(2);
  });
});

describe("joinGame", () => {
  test("вход добавляет игрока, увеличивает ревизию и публикует её после commit", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const { realtime, published } = createSpyRealtime();

    const joined = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime,
    });

    expect(joined.gameId).toBe(created.gameId);
    expect(joined.changed).toBe(true);
    expect(joined.value.isNewPlayer).toBe(true);
    expect(joined.revision).toBe(1);

    const game = await loadGame(created.gameId);
    expect(game.revision).toBe(1);
    expect(game.players).toHaveLength(2);
    expect(published).toEqual([{ gameId: created.gameId, revision: 1 }]);
  });

  test("нормализует код: вход принимает нижний регистр и пробелы", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const lowered = created.code.toLowerCase();
    const spaced = `${lowered.slice(0, 3)} ${lowered.slice(3)}`;

    const joined = await joinGame({
      definition,
      code: spaced,
      name: "Петя",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });

    expect(joined.changed).toBe(true);
  });

  test("повторный вход с той же cookie — no-op без дубликата и без публикации", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const { realtime, published } = createSpyRealtime();

    const first = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime,
    });
    const again = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: first.value.playerId,
      realtime,
    });

    expect(again.changed).toBe(false);
    expect(again.value.isNewPlayer).toBe(false);
    expect(again.value.playerId).toBe(first.value.playerId);
    expect(again.revision).toBe(1);

    const game = await loadGame(created.gameId);
    expect(game.players).toHaveLength(2);
    expect(game.revision).toBe(1);
    expect(published).toEqual([{ gameId: created.gameId, revision: 1 }]);
  });

  test("существующий участник получает no-op в любой фазе без дубликата", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const { realtime, published } = createSpyRealtime();
    const first = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime,
    });

    await prisma.game.update({ where: { id: created.gameId }, data: { status: "ACTIVE" } });

    const again = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: first.value.playerId,
      realtime,
    });

    expect(again.changed).toBe(false);
    const game = await loadGame(created.gameId);
    expect(game.players).toHaveLength(2);
    expect(game.revision).toBe(1);
    expect(published).toEqual([{ gameId: created.gameId, revision: 1 }]);
  });

  test("новый игрок отклоняется после старта", async () => {
    const created = await createGame({ definition, name: "Маша" });
    await prisma.game.update({ where: { id: created.gameId }, data: { status: "ACTIVE" } });

    await expectGameError(
      Promise.resolve(
        joinGame({
          definition,
          code: created.code,
          name: "Петя",
          playerId: null,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );
  });

  test("тринадцатый игрок получает GAME_FULL", async () => {
    const created = await createGame({ definition, name: "Маша" });
    for (let i = 2; i <= 12; i += 1) {
      await prisma.player.create({
        data: {
          gameId: created.gameId,
          name: `Игрок${i}`,
          normalizedName: `игрок${i}`,
        },
      });
    }

    await expectGameError(
      Promise.resolve(
        joinGame({
          definition,
          code: created.code,
          name: "Лишний",
          playerId: null,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "GAME_FULL",
      409,
    );

    const game = await loadGame(created.gameId);
    expect(game.players).toHaveLength(12);
    expect(game.revision).toBe(0);
  });

  test("дубликат имени по NFKC и регистру получает NAME_TAKEN", async () => {
    const created = await createGame({ definition, name: "Маша" });
    await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });

    const error = await expectGameError(
      Promise.resolve(
        joinGame({
          definition,
          code: created.code,
          name: "  пЕтя ",
          playerId: null,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "NAME_TAKEN",
      409,
    );
    expect(error.fieldErrors?.name).toBeDefined();
  });

  test("вход по несуществующему коду — GAME_NOT_FOUND", async () => {
    await expectGameError(
      Promise.resolve(
        joinGame({
          definition,
          code: "ZZZZZZ",
          name: "Петя",
          playerId: null,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "GAME_NOT_FOUND",
      404,
    );
  });
});

describe("setReadiness", () => {
  test("игрок меняет только собственную готовность; публикация после commit", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const petya = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });
    const { realtime, published } = createSpyRealtime();

    const result = await setReadiness({
      code: created.code,
      playerId: petya.value.playerId,
      ready: true,
      realtime,
    });

    expect(result.changed).toBe(true);
    expect(result.value).toEqual({ playerId: petya.value.playerId, isReady: true });

    const game = await loadGame(created.gameId);
    const masha = game.players.find((p) => p.id === created.playerId)!;
    const petyaRow = game.players.find((p) => p.id === petya.value.playerId)!;
    expect(masha.isReady).toBe(false);
    expect(petyaRow.isReady).toBe(true);
    expect(game.revision).toBe(2);
    expect(published).toEqual([{ gameId: created.gameId, revision: 2 }]);
  });

  test("повторная установка той же готовности — no-op без публикации", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const { realtime, published } = createSpyRealtime();

    await setReadiness({ code: created.code, playerId: created.playerId, ready: true, realtime });
    const again = await setReadiness({
      code: created.code,
      playerId: created.playerId,
      ready: true,
      realtime,
    });

    expect(again.changed).toBe(false);
    expect(again.revision).toBe(1);
    const game = await loadGame(created.gameId);
    expect(game.revision).toBe(1);
    expect(published).toEqual([{ gameId: created.gameId, revision: 1 }]);
  });

  test("готовность недоступна вне LOBBY", async () => {
    const created = await createGame({ definition, name: "Маша" });
    await prisma.game.update({ where: { id: created.gameId }, data: { status: "ACTIVE" } });

    await expectGameError(
      Promise.resolve(
        setReadiness({
          code: created.code,
          playerId: created.playerId,
          ready: true,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );
  });

  test("незарегистрированный игрок получает FORBIDDEN", async () => {
    const created = await createGame({ definition, name: "Маша" });

    await expectGameError(
      Promise.resolve(
        setReadiness({
          code: created.code,
          playerId: randomUUID(),
          ready: true,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "FORBIDDEN",
      403,
    );
  });
});

describe("updateSettings", () => {
  test("админ меняет настройки в LOBBY; изменение публикуется", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const { realtime, published } = createSpyRealtime();

    const result = await updateSettings({
      definition,
      code: created.code,
      playerId: created.playerId,
      settings: { hideTargetNamesDuringSetup: true },
      realtime,
    });

    expect(result.changed).toBe(true);
    expect(result.value).toEqual({ hideTargetNamesDuringSetup: true });

    const game = await loadGame(created.gameId);
    expect(game.wordChain?.hideTargetNamesDuringSetup).toBe(true);
    expect(game.revision).toBe(1);
    expect(published).toEqual([{ gameId: created.gameId, revision: 1 }]);
  });

  test("повторная установка того же значения — no-op", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const { realtime, published } = createSpyRealtime();

    await updateSettings({
      definition,
      code: created.code,
      playerId: created.playerId,
      settings: { hideTargetNamesDuringSetup: true },
      realtime,
    });
    const again = await updateSettings({
      definition,
      code: created.code,
      playerId: created.playerId,
      settings: { hideTargetNamesDuringSetup: true },
      realtime,
    });

    expect(again.changed).toBe(false);
    expect(again.revision).toBe(1);
    const game = await loadGame(created.gameId);
    expect(game.revision).toBe(1);
    expect(published).toEqual([{ gameId: created.gameId, revision: 1 }]);
  });

  test("обычный игрок получает FORBIDDEN", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const petya = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });

    await expectGameError(
      Promise.resolve(
        updateSettings({
          definition,
          code: created.code,
          playerId: petya.value.playerId,
          settings: { hideTargetNamesDuringSetup: true },
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "FORBIDDEN",
      403,
    );
  });

  test("настройки недоступны вне LOBBY", async () => {
    const created = await createGame({ definition, name: "Маша" });
    await prisma.game.update({ where: { id: created.gameId }, data: { status: "ACTIVE" } });

    await expectGameError(
      Promise.resolve(
        updateSettings({
          definition,
          code: created.code,
          playerId: created.playerId,
          settings: { hideTargetNamesDuringSetup: true },
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );
  });

  test("некорректное тело настроек — VALIDATION_ERROR", async () => {
    const created = await createGame({ definition, name: "Маша" });

    await expectGameError(
      Promise.resolve(
        updateSettings({
          definition,
          code: created.code,
          playerId: created.playerId,
          settings: { hideTargetNamesDuringSetup: "yes" },
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "VALIDATION_ERROR",
      400,
    );
  });
});

describe("removePlayer", () => {
  test("админ удаляет другого игрока в LOBBY", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const petya = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });
    const { realtime, published } = createSpyRealtime();

    const result = await removePlayer({
      code: created.code,
      actorPlayerId: created.playerId,
      targetPlayerId: petya.value.playerId,
      realtime,
    });

    expect(result.changed).toBe(true);
    expect(result.value).toEqual({ removedPlayerId: petya.value.playerId });

    const game = await loadGame(created.gameId);
    expect(game.players).toHaveLength(1);
    expect(game.players[0].id).toBe(created.playerId);
    expect(game.revision).toBe(2);
    expect(published).toEqual([{ gameId: created.gameId, revision: 2 }]);
  });

  test("админ не может удалить сам себя", async () => {
    const created = await createGame({ definition, name: "Маша" });

    await expectGameError(
      Promise.resolve(
        removePlayer({
          code: created.code,
          actorPlayerId: created.playerId,
          targetPlayerId: created.playerId,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "FORBIDDEN",
      403,
    );
  });

  test("обычный игрок не может удалять участников", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const petya = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });

    await expectGameError(
      Promise.resolve(
        removePlayer({
          code: created.code,
          actorPlayerId: petya.value.playerId,
          targetPlayerId: created.playerId,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "FORBIDDEN",
      403,
    );
  });

  test("удаление недоступно вне LOBBY", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const petya = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });
    await prisma.game.update({ where: { id: created.gameId }, data: { status: "ACTIVE" } });

    await expectGameError(
      Promise.resolve(
        removePlayer({
          code: created.code,
          actorPlayerId: created.playerId,
          targetPlayerId: petya.value.playerId,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );
  });

  test("удаление отсутствующего участника — PLAYER_NOT_FOUND", async () => {
    const created = await createGame({ definition, name: "Маша" });

    await expectGameError(
      Promise.resolve(
        removePlayer({
          code: created.code,
          actorPlayerId: created.playerId,
          targetPlayerId: randomUUID(),
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "PLAYER_NOT_FOUND",
      404,
    );
  });

  test("malformed UUID удаляемого — PLAYER_NOT_FOUND без ревизии, изменений и публикации", async () => {
    const created = await createGame({ definition, name: "Маша" });
    await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });
    const { realtime, published } = createSpyRealtime();

    await expectGameError(
      Promise.resolve(
        removePlayer({
          code: created.code,
          actorPlayerId: created.playerId,
          targetPlayerId: "not-a-uuid",
          realtime,
        }),
      ),
      "PLAYER_NOT_FOUND",
      404,
    );

    const game = await loadGame(created.gameId);
    expect(game.players).toHaveLength(2);
    expect(game.revision).toBe(1);
    expect(published).toEqual([]);
  });
});

describe("leaveGame", () => {
  test("выход игрока удаляет его из комнаты", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const petya = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });
    const { realtime, published } = createSpyRealtime();

    const result = await leaveGame({
      code: created.code,
      playerId: petya.value.playerId,
      realtime,
    });

    expect(result.changed).toBe(true);
    expect(result.value.roomDeleted).toBe(false);
    const game = await loadGame(created.gameId);
    expect(game.players).toHaveLength(1);
    expect(game.players[0].id).toBe(created.playerId);
    expect(game.revision).toBe(2);
    expect(published).toEqual([{ gameId: created.gameId, revision: 2 }]);
  });

  test("выход админа передаёт роль по (joinedAt, id) до удаления", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const petya = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });
    const vanya = await joinGame({
      definition,
      code: created.code,
      name: "Ваня",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });

    await leaveGame({ code: created.code, playerId: created.playerId, realtime: createSpyRealtime().realtime });
    let game = await loadGame(created.gameId);
    expect(game.hostPlayerId).toBe(petya.value.playerId);
    expect(game.players).toHaveLength(2);

    await leaveGame({ code: created.code, playerId: petya.value.playerId, realtime: createSpyRealtime().realtime });
    game = await loadGame(created.gameId);
    expect(game.hostPlayerId).toBe(vanya.value.playerId);
    expect(game.players).toHaveLength(1);
  });

  test("выход последнего игрока удаляет комнату без публикации", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const { realtime, published } = createSpyRealtime();

    const result = await leaveGame({ code: created.code, playerId: created.playerId, realtime });

    expect(result.changed).toBe(true);
    expect(result.value.roomDeleted).toBe(true);
    expect(await prisma.game.findUnique({ where: { id: created.gameId } })).toBeNull();
    expect(await prisma.player.count({ where: { gameId: created.gameId } })).toBe(0);
    expect(published).toEqual([]);
  });

  test("выход недоступен вне LOBBY", async () => {
    const created = await createGame({ definition, name: "Маша" });
    await prisma.game.update({ where: { id: created.gameId }, data: { status: "ACTIVE" } });

    await expectGameError(
      Promise.resolve(
        leaveGame({
          code: created.code,
          playerId: created.playerId,
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "INVALID_GAME_STATE",
      409,
    );
  });

  test("незарегистрированный игрок получает FORBIDDEN", async () => {
    const created = await createGame({ definition, name: "Маша" });

    await expectGameError(
      Promise.resolve(
        leaveGame({
          code: created.code,
          playerId: randomUUID(),
          realtime: createSpyRealtime().realtime,
        }),
      ),
      "FORBIDDEN",
      403,
    );
  });
});

describe("транзакционность и публикация", () => {
  test("отклонённая команда ничего не меняет и не публикует", async () => {
    const created = await createGame({ definition, name: "Маша" });
    const petya = await joinGame({
      definition,
      code: created.code,
      name: "Петя",
      playerId: null,
      realtime: createSpyRealtime().realtime,
    });
    const { realtime, published } = createSpyRealtime();

    await expectGameError(
      Promise.resolve(
        updateSettings({
          definition,
          code: created.code,
          playerId: petya.value.playerId,
          settings: { hideTargetNamesDuringSetup: true },
          realtime,
        }),
      ),
      "FORBIDDEN",
      403,
    );

    const game = await loadGame(created.gameId);
    expect(game.revision).toBe(1);
    expect(game.wordChain?.hideTargetNamesDuringSetup).toBe(false);
    expect(published).toEqual([]);
  });

  test("одновременные входы сериализуются: уникальные ревизии и места без гонки", async () => {
    const created = await createGame({ definition, name: "Маша" });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        joinGame({
          definition,
          code: created.code,
          name: `Игрок${i + 2}`,
          playerId: null,
          realtime: createSpyRealtime().realtime,
        }),
      ),
    );

    const revisions = results.map((r) => r.revision).sort((a, b) => a - b);
    expect(revisions).toEqual([1, 2, 3, 4, 5]);
    const game = await loadGame(created.gameId);
    expect(game.players).toHaveLength(6);
    expect(game.revision).toBe(5);
  });
});
