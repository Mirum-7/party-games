import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sealData } from "iron-session";

import { GET } from "@/app/api/v1/games/[code]/events/route";
import { SESSION_COOKIE_NAME } from "@/server/core/auth/session";
import { getProcessGameRealtime, InMemoryGameRealtime } from "@/server/core/realtime/in-memory";
import { applyMigrationsOnce, cleanTables, createTestPrismaClient } from "@/test/integration/database";

describe("InMemoryGameRealtime", () => {
  test("доставляет ревизию только подписчикам этой комнаты", () => {
    const realtime = new InMemoryGameRealtime();
    const callsA: number[] = [];
    const callsB: number[] = [];
    realtime.subscribe("game-a", (revision) => callsA.push(revision));
    realtime.subscribe("game-b", (revision) => callsB.push(revision));

    realtime.publish("game-a", 7);

    expect(callsA).toEqual([7]);
    expect(callsB).toEqual([]);
  });

  test("subscribe возвращает cleanup, который отключает слушателя", () => {
    const realtime = new InMemoryGameRealtime();
    const calls: number[] = [];
    const cleanup = realtime.subscribe("game-a", (revision) => calls.push(revision));

    realtime.publish("game-a", 1);
    cleanup();
    realtime.publish("game-a", 2);

    expect(calls).toEqual([1]);
  });

  test("несколько слушателей получают одну ревизию; cleanup работает на каждого", () => {
    const realtime = new InMemoryGameRealtime();
    const first: number[] = [];
    const second: number[] = [];
    const cleanupFirst = realtime.subscribe("game-a", (revision) => first.push(revision));
    realtime.subscribe("game-a", (revision) => second.push(revision));

    realtime.publish("game-a", 3);
    cleanupFirst();
    realtime.publish("game-a", 4);

    expect(first).toEqual([3]);
    expect(second).toEqual([3, 4]);
  });

  test("publish без подписчиков не падает", () => {
    const realtime = new InMemoryGameRealtime();
    expect(() => realtime.publish("nobody", 1)).not.toThrow();
  });

  test("падающий слушатель не мешает остальным и не вылетает из publish после commit", () => {
    const lines: string[] = [];
    const realtime = new InMemoryGameRealtime((line) => lines.push(line));
    const secretMessage = "самолёт-секретное-слово";
    const received: number[] = [];
    realtime.subscribe("game-a", () => {
      throw new Error(secretMessage);
    });
    realtime.subscribe("game-a", (revision) => received.push(revision));

    expect(() => realtime.publish("game-a", 7)).not.toThrow();
    realtime.publish("game-a", 8);

    expect(received).toEqual([7, 8]);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["action", "errorName", "event", "gameId"].sort());
      expect(parsed.event).toBe("game.realtime.listenerError");
      expect(parsed.action).toBe("publish");
      expect(parsed.gameId).toBe("game-a");
      expect(parsed.errorName).toBe("Error");
      expect(line).not.toContain(secretMessage);
    }
  });

  test("слушатель, упавший после отмены другого слушателя, не ломает publish", () => {
    const realtime = new InMemoryGameRealtime(() => {});
    const received: number[] = [];
    const cleanup = realtime.subscribe("game-a", () => {
      cleanup();
    });
    realtime.subscribe("game-a", (revision) => received.push(revision));

    expect(() => realtime.publish("game-a", 5)).not.toThrow();
    expect(received).toEqual([5]);
  });

  test("process-global singleton возвращает один экземпляр на процесс", () => {
    const first = getProcessGameRealtime();
    const second = getProcessGameRealtime();
    expect(first).toBe(second);
    expect(first).toBeInstanceOf(InMemoryGameRealtime);
  });
});

describe("GET /api/v1/games/{code}/events", () => {
  const TEST_PASSWORD = "test-session-password-with-32plus-chars!";
  const prisma = createTestPrismaClient();
  const realtime = getProcessGameRealtime();

  function setEnv(key: string, value: string | undefined): void {
    const env = process.env as unknown as Record<string, string | undefined>;
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  let originalPassword: string | undefined;

  beforeAll(async () => {
    originalPassword = process.env.SESSION_PASSWORD;
    setEnv("SESSION_PASSWORD", TEST_PASSWORD);
    await applyMigrationsOnce();
  });

  beforeEach(async () => {
    await cleanTables(prisma);
  });

  afterAll(async () => {
    setEnv("SESSION_PASSWORD", originalPassword);
    await prisma.$disconnect();
  });

  function uniqueCode(): string {
    return Math.random().toString(36).slice(2, 8).padEnd(6, "x").toUpperCase();
  }

  async function seedGame(code = uniqueCode()) {
    return prisma.game.create({ data: { code, type: "WORD_CHAIN", status: "LOBBY" } });
  }

  async function seedPlayer(gameId: string, name: string) {
    return prisma.player.create({ data: { gameId, name, normalizedName: name.toLowerCase() } });
  }

  async function cookieFor(playerId: string): Promise<string> {
    const seal = await sealData({ playerId }, { password: TEST_PASSWORD, ttl: 604800 });
    return `${SESSION_COOKIE_NAME}=${seal}`;
  }

  function eventsRequest(code: string, cookie?: string): Request {
    const headers = new Headers();
    if (cookie !== undefined) headers.set("cookie", cookie);
    return new Request(`http://localhost/api/v1/games/${code}/events`, { headers });
  }

  async function expectJsonError(response: Response, status: number, code: string): Promise<void> {
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(response.status).toBe(status);
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe("string");
  }

  function streamReader(response: Response): {
    next: (timeoutMs?: number) => Promise<string>;
    cancel: () => Promise<void>;
  } {
    if (response.body === null) throw new Error("тело SSE-ответа отсутствует");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    return {
      next: async (timeoutMs = 1000): Promise<string> => {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("таймаут ожидания SSE chunk")), timeoutMs),
          ),
        ]);
        if (result.done) throw new Error("SSE-поток закрылся раньше chunk");
        return decoder.decode(result.value, { stream: true });
      },
      cancel: () => reader.cancel(),
    };
  }

  test("без cookie до открытия потока — 401 UNAUTHENTICATED в обычном JSON", async () => {
    const game = await seedGame();
    const response = await GET(eventsRequest(game.code), { params: Promise.resolve({ code: game.code }) });
    await expectJsonError(response, 401, "UNAUTHENTICATED");
  });

  test("участник несуществующей комнаты — 404 GAME_NOT_FOUND", async () => {
    const game = await seedGame();
    const player = await seedPlayer(game.id, "Маша");
    const response = await GET(eventsRequest("ZZZZZZ", await cookieFor(player.id)), {
      params: Promise.resolve({ code: "ZZZZZZ" }),
    });
    await expectJsonError(response, 404, "GAME_NOT_FOUND");
  });

  test("игрок другой комнаты — 403 FORBIDDEN", async () => {
    const gameA = await seedGame();
    const gameB = await seedGame();
    const player = await seedPlayer(gameA.id, "Маша");
    const response = await GET(eventsRequest(gameB.code, await cookieFor(player.id)), {
      params: Promise.resolve({ code: gameB.code }),
    });
    await expectJsonError(response, 403, "FORBIDDEN");
  });

  test("участник получает SSE: точные заголовки, retry, текущая и следующая ревизии", async () => {
    const game = await seedGame();
    const player = await seedPlayer(game.id, "Маша");
    await prisma.game.update({ where: { id: game.id }, data: { revision: 4 } });

    const response = await GET(eventsRequest(game.code, await cookieFor(player.id)), {
      params: Promise.resolve({ code: game.code }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("Connection")).toBe("keep-alive");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");

    const { next } = streamReader(response);
    expect(await next()).toBe("retry: 3000\n\n");
    expect(await next()).toBe('id: 4\nevent: game.changed\ndata: {"revision":4}\n\n');

    realtime.publish(game.id, 5);
    expect(await next()).toBe('id: 5\nevent: game.changed\ndata: {"revision":5}\n\n');
  });

  test("SSE-поток не содержит имён, кодов и слов комнаты", async () => {
    const secretName = "самолёт-Маша-секрет";
    const game = await seedGame("SECR42");
    const player = await seedPlayer(game.id, secretName);
    await prisma.game.update({ where: { id: game.id }, data: { revision: 1 } });

    const response = await GET(eventsRequest(game.code, await cookieFor(player.id)), {
      params: Promise.resolve({ code: game.code }),
    });
    const { next, cancel } = streamReader(response);

    const chunks = [await next(), await next()];
    realtime.publish(game.id, 2);
    chunks.push(await next());
    await cancel();

    const serialized = JSON.stringify(chunks);
    expect(serialized).not.toContain(secretName);
    expect(serialized).not.toContain("самолёт");
    expect(serialized).not.toContain(game.code);
  });

  test("отмена тела ответа завершает поток, поздняя публикация не падает", async () => {
    const game = await seedGame();
    const player = await seedPlayer(game.id, "Маша");

    const response = await GET(eventsRequest(game.code, await cookieFor(player.id)), {
      params: Promise.resolve({ code: game.code }),
    });
    const { next, cancel } = streamReader(response);
    expect(await next()).toBe("retry: 3000\n\n");

    await cancel();
    expect(() => realtime.publish(game.id, 42)).not.toThrow();
  });
});
