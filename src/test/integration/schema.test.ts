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

// PrismaPromise is a thenable, not a native Promise, so bun:test's
// expect(...).rejects does not adopt it; wrapping keeps the same assertion.
async function expectConstraintViolation(promise: PromiseLike<unknown>): Promise<void> {
  await expect(Promise.resolve(promise)).rejects.toThrow();
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
    );
  });

  test("rejects duplicate player normalizedName in the same game", async () => {
    const game = await createGame();
    await createPlayer(game.id, "Маша");
    await expectConstraintViolation(createPlayer(game.id, "МАША"));
  });

  test("rejects duplicate assignment author in the same game", async () => {
    const game = await createGame();
    const author = await createPlayer(game.id, "Маша");
    const firstTarget = await createPlayer(game.id, "Петя");
    const secondTarget = await createPlayer(game.id, "Ваня");
    await createAssignment(game.id, author.id, firstTarget.id);
    await expectConstraintViolation(createAssignment(game.id, author.id, secondTarget.id));
  });

  test("rejects duplicate assignment target in the same game", async () => {
    const game = await createGame();
    const firstAuthor = await createPlayer(game.id, "Маша");
    const secondAuthor = await createPlayer(game.id, "Петя");
    const target = await createPlayer(game.id, "Ваня");
    await createAssignment(game.id, firstAuthor.id, target.id);
    await expectConstraintViolation(createAssignment(game.id, secondAuthor.id, target.id));
  });

  test("rejects self-assignment", async () => {
    const game = await createGame();
    const player = await createPlayer(game.id, "Маша");
    await expectConstraintViolation(
      prisma.wordAssignment.create({
        data: { gameId: game.id, authorPlayerId: player.id, targetPlayerId: player.id },
      }),
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
    );
  });

  test("rejects place without finishedAt", async () => {
    const game = await createGame();
    const player = await createPlayer(game.id, "Маша");
    await expectConstraintViolation(
      prisma.gameResult.create({
        data: { gameId: game.id, playerId: player.id, place: 1, score: 1 },
      }),
    );
  });

  test("rejects finishedAt without place", async () => {
    const game = await createGame();
    const player = await createPlayer(game.id, "Маша");
    await expectConstraintViolation(
      prisma.gameResult.create({
        data: { gameId: game.id, playerId: player.id, score: 0, finishedAt: new Date() },
      }),
    );
  });

  test("rejects place with zero score", async () => {
    const game = await createGame();
    const player = await createPlayer(game.id, "Маша");
    await expectConstraintViolation(
      prisma.gameResult.create({
        data: { gameId: game.id, playerId: player.id, place: 1, score: 0, finishedAt: new Date() },
      }),
    );
  });

  test("rejects positive score without place", async () => {
    const game = await createGame();
    const player = await createPlayer(game.id, "Маша");
    await expectConstraintViolation(
      prisma.gameResult.create({
        data: { gameId: game.id, playerId: player.id, score: 1 },
      }),
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
    );
  });

  test("rejects deleting a player who is still the host", async () => {
    const game = await createGame();
    const host = await createPlayer(game.id, "Маша");
    await prisma.game.update({ where: { id: game.id }, data: { hostPlayerId: host.id } });
    await expectConstraintViolation(prisma.player.delete({ where: { id: host.id } }));
  });

  test("rejects a second word chain game row for the same game", async () => {
    const game = await createGame();
    await prisma.wordChainGame.create({ data: { gameId: game.id } });
    await expectConstraintViolation(prisma.wordChainGame.create({ data: { gameId: game.id } }));
  });
});
