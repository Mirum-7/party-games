import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrationsOnce,
  assertDisposableDatabaseUrl,
  cleanTables,
  createTestPrismaClient,
} from "@/test/integration/database";

const prisma = createTestPrismaClient();

beforeAll(async () => {
  await applyMigrationsOnce();
});

beforeEach(async () => {
  await cleanTables(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Имена ограничений — часть контракта (docs/data-model.md, раздел про
// сохранение raw CHECK при будущих migrate dev): тесты фиксируют конкретное
// имя и SQLSTATE, а не «любую ошибку», чтобы случайное переименование или
// потеря ограничения ловились сразу.
const CONSTRAINT_KINDS = {
  unique: { prismaCode: "P2002", sqlstate: "23505" },
  check: { prismaCode: "P2039", sqlstate: "23514" },
  restrict: { prismaCode: "P2003", sqlstate: "23001" },
  // VARCHAR(80) срабатывает раньше CHECK: тип колонки — первая линия защиты.
  tooLong: { prismaCode: "P2000", sqlstate: "22001" },
} as const;
type ConstraintKind = keyof typeof CONSTRAINT_KINDS;

type PrismaConstraintError = {
  name?: string;
  code?: string;
  meta?: {
    driverAdapterError?: {
      cause?: {
        originalCode?: string;
        originalMessage?: string;
        constraint?: { index?: string };
      };
    };
  };
};

async function expectConstraintViolation(
  promise: PromiseLike<unknown>,
  kind: ConstraintKind,
  constraint: string,
): Promise<void> {
  // PrismaPromise is a thenable, not a native Promise, so bun:test's
  // expect(...).rejects does not adopt it; wrapping keeps the same assertion.
  const error: unknown = await Promise.resolve(promise).then(
    () => {
      throw new Error(`Expected constraint violation "${constraint}", but the promise resolved`);
    },
    (cause) => cause,
  );
  const expected = CONSTRAINT_KINDS[kind];
  const prismaError = error as PrismaConstraintError;
  expect(prismaError.name).toBe("PrismaClientKnownRequestError");
  expect(prismaError.code).toBe(expected.prismaCode);
  const cause = prismaError.meta?.driverAdapterError?.cause ?? {};
  expect(cause.originalCode).toBe(expected.sqlstate);
  if (kind === "check") {
    expect(cause.originalMessage).toContain(`violates check constraint "${constraint}"`);
  } else if (kind === "tooLong") {
    expect(cause.originalMessage).toContain("character varying(80)");
  } else {
    expect(cause.constraint?.index).toBe(constraint);
  }
}

function uniqueCode(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "x");
}

async function createGame() {
  return prisma.game.create({
    data: { code: uniqueCode(), type: "WORD_CHAIN", status: "LOBBY" },
  });
}

async function createPlayer(gameId: string, name: string) {
  return prisma.player.create({
    data: { gameId, name, normalizedName: name.toLowerCase() },
  });
}

async function createAssignment(gameId: string, authorPlayerId: string, targetPlayerId: string) {
  return prisma.wordAssignment.create({
    data: { gameId, authorPlayerId, targetPlayerId },
  });
}

describe("words game database constraints", () => {
  test("refuses to run against a database without the _test suffix", () => {
    expect(() =>
      assertDisposableDatabaseUrl("postgresql://words:words@127.0.0.1:55432/words_game", "_test"),
    ).toThrow("TEST_DATABASE_UNSAFE");
  });

  test("rejects duplicate game code", async () => {
    const game = await createGame();
    await expectConstraintViolation(
      prisma.game.create({ data: { code: game.code, type: "WORD_CHAIN", status: "LOBBY" } }),
      "unique",
      "games_code_key",
    );
  });

  test("rejects duplicate player normalizedName in the same game", async () => {
    const game = await createGame();
    await createPlayer(game.id, "Маша");
    await expectConstraintViolation(createPlayer(game.id, "МАША"), "unique", "players_gameId_normalizedName_key");
  });

  test("rejects duplicate assignment author in the same game", async () => {
    const game = await createGame();
    const author = await createPlayer(game.id, "Маша");
    const firstTarget = await createPlayer(game.id, "Петя");
    const secondTarget = await createPlayer(game.id, "Ваня");
    await createAssignment(game.id, author.id, firstTarget.id);
    // Глобальный @unique по authorPlayerId создан раньше составного
    // (gameId, authorPlayerId) и Postgres стабильно отчитывается о нём;
    // оба ограничения из миграции при этом сохраняются.
    await expectConstraintViolation(
      createAssignment(game.id, author.id, secondTarget.id),
      "unique",
      "word_assignments_authorPlayerId_key",
    );
  });

  test("rejects duplicate assignment target in the same game", async () => {
    const game = await createGame();
    const firstAuthor = await createPlayer(game.id, "Маша");
    const secondAuthor = await createPlayer(game.id, "Петя");
    const target = await createPlayer(game.id, "Ваня");
    await createAssignment(game.id, firstAuthor.id, target.id);
    await expectConstraintViolation(
      createAssignment(game.id, secondAuthor.id, target.id),
      "unique",
      "word_assignments_targetPlayerId_key",
    );
  });

  test("rejects self-assignment", async () => {
    const game = await createGame();
    const player = await createPlayer(game.id, "Маша");
    await expectConstraintViolation(
      prisma.wordAssignment.create({
        data: { gameId: game.id, authorPlayerId: player.id, targetPlayerId: player.id },
      }),
      "check",
      "word_assignments_no_self_target",
    );
  });

  test("rejects duplicate place in the same game", async () => {
    const game = await createGame();
    const first = await createPlayer(game.id, "Маша");
    const second = await createPlayer(game.id, "Петя");
    await prisma.gameResult.create({
      data: { gameId: game.id, playerId: first.id, place: 1, score: 2, finishedAt: new Date() },
    });
    await expectConstraintViolation(
      prisma.gameResult.create({
        data: { gameId: game.id, playerId: second.id, place: 1, score: 2, finishedAt: new Date() },
      }),
      "unique",
      "game_results_gameId_place_key",
    );
  });

  test("allows multiple results with null place", async () => {
    const game = await createGame();
    const first = await createPlayer(game.id, "Маша");
    const second = await createPlayer(game.id, "Петя");
    await prisma.gameResult.create({ data: { gameId: game.id, playerId: first.id } });
    await prisma.gameResult.create({ data: { gameId: game.id, playerId: second.id } });
    const count = await prisma.gameResult.count({ where: { gameId: game.id } });
    expect(count).toBe(2);
  });

  test("rejects place below 1", async () => {
    const game = await createGame();
    const player = await createPlayer(game.id, "Маша");
    await expectConstraintViolation(
      prisma.gameResult.create({
        data: { gameId: game.id, playerId: player.id, place: 0, score: 1, finishedAt: new Date() },
      }),
      "check",
      "game_results_place_positive",
    );
  });

  test("rejects place without finishedAt", async () => {
    const game = await createGame();
    const player = await createPlayer(game.id, "Маша");
    await expectConstraintViolation(
      prisma.gameResult.create({
        data: { gameId: game.id, playerId: player.id, place: 1, score: 1 },
      }),
      "check",
      "game_results_place_time_pair",
    );
  });

  test("rejects finishedAt without place", async () => {
    const game = await createGame();
    const player = await createPlayer(game.id, "Маша");
    await expectConstraintViolation(
      prisma.gameResult.create({
        data: { gameId: game.id, playerId: player.id, score: 0, finishedAt: new Date() },
      }),
      "check",
      "game_results_place_time_pair",
    );
  });

  test("rejects place with zero score", async () => {
    const game = await createGame();
    const player = await createPlayer(game.id, "Маша");
    await expectConstraintViolation(
      prisma.gameResult.create({
        data: { gameId: game.id, playerId: player.id, place: 1, score: 0, finishedAt: new Date() },
      }),
      "check",
      "game_results_score_place_pair",
    );
  });

  test("rejects positive score without place", async () => {
    const game = await createGame();
    const player = await createPlayer(game.id, "Маша");
    await expectConstraintViolation(
      prisma.gameResult.create({
        data: { gameId: game.id, playerId: player.id, score: 1 },
      }),
      "check",
      "game_results_score_place_pair",
    );
  });

  test("rejects word without submittedAt", async () => {
    const game = await createGame();
    const author = await createPlayer(game.id, "Маша");
    const target = await createPlayer(game.id, "Петя");
    await expectConstraintViolation(
      prisma.wordAssignment.create({
        data: { gameId: game.id, authorPlayerId: author.id, targetPlayerId: target.id, word: "слово" },
      }),
      "check",
      "word_assignments_word_submission_pair",
    );
  });

  test("rejects submittedAt without word", async () => {
    const game = await createGame();
    const author = await createPlayer(game.id, "Маша");
    const target = await createPlayer(game.id, "Петя");
    await expectConstraintViolation(
      prisma.wordAssignment.create({
        data: {
          gameId: game.id,
          authorPlayerId: author.id,
          targetPlayerId: target.id,
          submittedAt: new Date(),
        },
      }),
      "check",
      "word_assignments_word_submission_pair",
    );
  });

  test("rejects blank word", async () => {
    const game = await createGame();
    const author = await createPlayer(game.id, "Маша");
    const target = await createPlayer(game.id, "Петя");
    await expectConstraintViolation(
      prisma.wordAssignment.create({
        data: {
          gameId: game.id,
          authorPlayerId: author.id,
          targetPlayerId: target.id,
          word: "   ",
          submittedAt: new Date(),
        },
      }),
      "check",
      "word_assignments_word_length",
    );
  });

  test("rejects word longer than 80 code points", async () => {
    const game = await createGame();
    const author = await createPlayer(game.id, "Маша");
    const target = await createPlayer(game.id, "Петя");
    await expectConstraintViolation(
      prisma.wordAssignment.create({
        data: {
          gameId: game.id,
          authorPlayerId: author.id,
          targetPlayerId: target.id,
          word: "ы".repeat(81),
          submittedAt: new Date(),
        },
      }),
      "tooLong",
      "word_assignments.word",
    );
  });

  test("rejects deleting a player who is still the host", async () => {
    const game = await createGame();
    const host = await createPlayer(game.id, "Маша");
    await prisma.game.update({ where: { id: game.id }, data: { hostPlayerId: host.id } });
    await expectConstraintViolation(prisma.player.delete({ where: { id: host.id } }), "restrict", "games_hostPlayerId_fkey");
  });

  test("rejects a second word chain game row for the same game", async () => {
    const game = await createGame();
    await prisma.wordChainGame.create({ data: { gameId: game.id } });
    await expectConstraintViolation(
      prisma.wordChainGame.create({ data: { gameId: game.id } }),
      "unique",
      "word_chain_games_pkey",
    );
  });

  test("deleting a populated room cascades to players, assignments, results and word chain settings", async () => {
    const game = await createGame();
    const host = await createPlayer(game.id, "Маша");
    const guest = await createPlayer(game.id, "Петя");
    await prisma.game.update({ where: { id: game.id }, data: { hostPlayerId: host.id } });
    await prisma.wordChainGame.create({ data: { gameId: game.id, phase: "PLAYING" } });
    await createAssignment(game.id, host.id, guest.id);
    await prisma.gameResult.create({
      data: { gameId: game.id, playerId: host.id, place: 1, score: 2, finishedAt: new Date() },
    });

    await prisma.game.delete({ where: { id: game.id } });

    expect(await prisma.player.count({ where: { gameId: game.id } })).toBe(0);
    expect(await prisma.wordAssignment.count({ where: { gameId: game.id } })).toBe(0);
    expect(await prisma.gameResult.count({ where: { gameId: game.id } })).toBe(0);
    expect(await prisma.wordChainGame.count({ where: { gameId: game.id } })).toBe(0);
  });
});
