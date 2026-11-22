import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getIronSession, sealData, unsealData, webCookies, type CookieJar } from "iron-session";

import { requireMembership } from "@/server/core/auth/auth";
import {
  buildSessionOptions,
  getOptionalPlayerId,
  getSessionOptions,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  writeGuestPlayer,
  type GuestSession,
} from "@/server/core/auth/session";
import { ApiError, type ApiErrorCode } from "@/server/http/errors";
import { applyMigrationsOnce, cleanTables, createTestPrismaClient } from "@/test/integration/database";

const TEST_PASSWORD = "test-session-password-with-32plus-chars!";
const APP_URL = "http://localhost:3000";

const prisma = createTestPrismaClient();

// process.env в @types/node имеет readonly-индекс; в тестах допустимо менять
// окружение через изменяемый каст, всегда с восстановлением в afterAll.
function setEnv(key: string, value: string | undefined): void {
  const env = process.env as unknown as Record<string, string | undefined>;
  if (value === undefined) delete env[key];
  else env[key] = value;
}

let originalPassword: string | undefined;
let originalNodeEnv: string | undefined;

beforeAll(async () => {
  originalPassword = process.env.SESSION_PASSWORD;
  originalNodeEnv = process.env.NODE_ENV;
  setEnv("SESSION_PASSWORD", TEST_PASSWORD);
  await applyMigrationsOnce();
});

beforeEach(async () => {
  await cleanTables(prisma);
});

afterAll(async () => {
  setEnv("SESSION_PASSWORD", originalPassword);
  setEnv("NODE_ENV", originalNodeEnv);
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

async function sealFor(playerId: string, ttlSeconds = SESSION_TTL_SECONDS): Promise<string> {
  return sealData({ playerId }, { password: TEST_PASSWORD, ttl: ttlSeconds });
}

// CookieJar поверх web Request/Response — тот же механизм, что использует
// getIronSession в Route Handlers, но без Next runtime.
function jarWithSessionCookie(seal?: string): { jar: CookieJar; responseHeaders: Headers } {
  const requestHeaders = new Headers();
  if (seal !== undefined) requestHeaders.set("cookie", `${SESSION_COOKIE_NAME}=${seal}`);
  const request = new Request(`${APP_URL}/api/v1/games`, { headers: requestHeaders });
  const responseHeaders = new Headers();
  return { jar: webCookies(request, responseHeaders), responseHeaders };
}

function readSetCookie(responseHeaders: Headers): string {
  const line = responseHeaders.get("set-cookie");
  if (line === null) throw new Error("Set-Cookie header is missing");
  return line;
}

async function expectApiError(promise: Promise<unknown>, status: number, code: ApiErrorCode): Promise<void> {
  try {
    await promise;
    expect.unreachable(`ожидалась ошибка ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    expect((error as ApiError).code).toBe(code);
  }
}

describe("параметры гостевой сессии", () => {
  test("cookie wg_session, HttpOnly, SameSite=Lax, path=/, ttl и maxAge = 604800", () => {
    const options = getSessionOptions();
    expect(options.cookieName).toBe("wg_session");
    expect(options.ttl).toBe(604800);
    expect(options.cookieOptions).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 604800,
    });
  });

  test("secure зависит от NODE_ENV: false вне production, true в production", () => {
    setEnv("NODE_ENV", "test");
    expect(getSessionOptions().cookieOptions?.secure).toBe(false);
    setEnv("NODE_ENV", "production");
    expect(getSessionOptions().cookieOptions?.secure).toBe(true);
  });

  test("SESSION_PASSWORD короче 32 символов отклоняется при первом использовании", () => {
    expect(() => buildSessionOptions("x".repeat(31), false)).toThrow();
    expect(() => buildSessionOptions("x".repeat(32), false)).not.toThrow();
    setEnv("SESSION_PASSWORD", "short");
    expect(() => getSessionOptions()).toThrow();
    setEnv("SESSION_PASSWORD", undefined);
    expect(() => getSessionOptions()).toThrow();
    setEnv("SESSION_PASSWORD", TEST_PASSWORD);
  });

  test("Set-Cookie при save содержит только заданные атрибуты cookie", async () => {
    const { jar, responseHeaders } = jarWithSessionCookie();
    await writeGuestPlayer(jar, "3f6f8bf8-7f9c-4f6b-9e8f-5f8f8f8f8f8f");
    const line = readSetCookie(responseHeaders);
    expect(line).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");
    expect(line).toContain("Path=/");
    expect(line).toContain("Max-Age=604800");
  });

  test("зашифрованная cookie содержит только playerId", async () => {
    const playerId = "3f6f8bf8-7f9c-4f6b-9e8f-5f8f8f8f8f8f";
    const { jar, responseHeaders } = jarWithSessionCookie();
    await writeGuestPlayer(jar, playerId);
    const line = readSetCookie(responseHeaders);
    const seal = line.slice(line.indexOf("=") + 1, line.indexOf(";"));
    const data = await unsealData<GuestSession>(seal, { password: TEST_PASSWORD });
    expect(data).toEqual({ playerId });
    expect(Object.keys(data as object).sort()).toEqual(["playerId"]);
  });
});

describe("getOptionalPlayerId", () => {
  test("без cookie возвращает null", async () => {
    const { jar } = jarWithSessionCookie();
    expect(await getOptionalPlayerId(jar)).toBeNull();
  });

  test("с валидной cookie возвращает playerId", async () => {
    const game = await seedGame();
    const player = await seedPlayer(game.id, "Маша");
    const { jar } = jarWithSessionCookie(await sealFor(player.id));
    expect(await getOptionalPlayerId(jar)).toBe(player.id);
  });

  test("повреждённая cookie даёт null", async () => {
    const { jar } = jarWithSessionCookie("forged-seal-value");
    expect(await getOptionalPlayerId(jar)).toBeNull();
  });

  test("истекшая cookie даёт null", async () => {
    const game = await seedGame();
    const player = await seedPlayer(game.id, "Маша");
    // iron-webcrypto допускает timestampSkewSec=60 с: seal старше двух минут точно просрочен.
    const expired = await sealFor(player.id, -120);
    const { jar } = jarWithSessionCookie(expired);
    expect(await getOptionalPlayerId(jar)).toBeNull();
  });
});

describe("requireMembership перезагружает Player и Game из БД", () => {
  test("участник своей комнаты получает player и game", async () => {
    const game = await seedGame();
    const player = await seedPlayer(game.id, "Маша");
    const { jar } = jarWithSessionCookie(await sealFor(player.id));
    const playerId = await getOptionalPlayerId(jar);
    const membership = await requireMembership(prisma, playerId, game.code);
    expect(membership.player.id).toBe(player.id);
    expect(membership.game.id).toBe(game.id);
  });

  test("код комнаты в path нечувствителен к регистру", async () => {
    const game = await seedGame();
    const player = await seedPlayer(game.id, "Маша");
    const membership = await requireMembership(prisma, player.id, game.code.toLowerCase());
    expect(membership.game.id).toBe(game.id);
  });

  test("отсутствующий playerId даёт 401 UNAUTHENTICATED", async () => {
    const game = await seedGame();
    await expectApiError(requireMembership(prisma, null, game.code), 401, "UNAUTHENTICATED");
  });

  test("не-UUID playerId даёт 401 без ошибки БД", async () => {
    const game = await seedGame();
    await expectApiError(requireMembership(prisma, "not-a-uuid", game.code), 401, "UNAUTHENTICATED");
  });

  test("playerId несуществующего игрока даёт 401 UNAUTHENTICATED", async () => {
    const game = await seedGame();
    await expectApiError(
      requireMembership(prisma, "3f6f8bf8-7f9c-4f6b-9e8f-5f8f8f8f8f8f", game.code),
      401,
      "UNAUTHENTICATED",
    );
  });

  test("удалённый игрок даёт 401 UNAUTHENTICATED", async () => {
    const game = await seedGame();
    const player = await seedPlayer(game.id, "Маша");
    await prisma.player.delete({ where: { id: player.id } });
    await expectApiError(requireMembership(prisma, player.id, game.code), 401, "UNAUTHENTICATED");
  });

  test("повреждённая cookie на всём пути auth даёт 401 UNAUTHENTICATED", async () => {
    const game = await seedGame();
    const { jar } = jarWithSessionCookie("forged");
    const playerId = await getOptionalPlayerId(jar);
    expect(playerId).toBeNull();
    await expectApiError(requireMembership(prisma, playerId, game.code), 401, "UNAUTHENTICATED");
  });

  test("игрок другой комнаты даёт 403 FORBIDDEN", async () => {
    const gameA = await seedGame();
    const gameB = await seedGame();
    const player = await seedPlayer(gameA.id, "Маша");
    await expectApiError(requireMembership(prisma, player.id, gameB.code), 403, "FORBIDDEN");
  });

  test("несуществующая комната даёт 404 GAME_NOT_FOUND", async () => {
    const game = await seedGame();
    const player = await seedPlayer(game.id, "Маша");
    await expectApiError(requireMembership(prisma, player.id, "ZZZZZZ"), 404, "GAME_NOT_FOUND");
  });

  test("сессия читается через getIronSession с опциями проекта", async () => {
    const game = await seedGame();
    const player = await seedPlayer(game.id, "Маша");
    const seal = await sealFor(player.id);
    const { jar } = jarWithSessionCookie(seal);
    const session = await getIronSession<GuestSession>(jar, getSessionOptions());
    expect(session.playerId).toBe(player.id);
    const membership = await requireMembership(prisma, session.playerId ?? null, game.code);
    expect(membership.player.id).toBe(player.id);
  });
});
