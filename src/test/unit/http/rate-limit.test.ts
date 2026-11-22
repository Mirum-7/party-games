import { describe, expect, test } from "bun:test";

import { ApiError } from "@/server/http/errors";
import { checkRateLimit, RATE_LIMIT_RULES, RateLimiter } from "@/server/http/rate-limit";

const MINUTE_MS = 60_000;

function createClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("RATE_LIMIT_RULES", () => {
  test("create/join — 30 запросов за 60 секунд, остальные mutation — 120 за 60 секунд", () => {
    expect(RATE_LIMIT_RULES.create).toEqual({ windowMs: MINUTE_MS, max: 30 });
    expect(RATE_LIMIT_RULES.join).toEqual({ windowMs: MINUTE_MS, max: 30 });
    expect(RATE_LIMIT_RULES.mutation).toEqual({ windowMs: MINUTE_MS, max: 120 });
  });
});

describe("RateLimiter с injected clock", () => {
  test("первые N запросов проходят, N+1 даёт RATE_LIMITED", () => {
    const clock = createClock();
    const limiter = new RateLimiter({ mutation: { windowMs: MINUTE_MS, max: 3 } }, clock.now);
    limiter.check("mutation", "word", "ip-1");
    limiter.check("mutation", "word", "ip-1");
    limiter.check("mutation", "word", "ip-1");
    try {
      limiter.check("mutation", "word", "ip-1");
      expect.unreachable("четвёртый запрос должен быть отклонён");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("RATE_LIMITED");
      expect((error as ApiError).status).toBe(429);
    }
  });

  test("новое фиксированное окно снова разрешает запросы", () => {
    const clock = createClock();
    const limiter = new RateLimiter({ mutation: { windowMs: MINUTE_MS, max: 2 } }, clock.now);
    limiter.check("mutation", "word", "ip-1");
    limiter.check("mutation", "word", "ip-1");
    expect(() => limiter.check("mutation", "word", "ip-1")).toThrow(ApiError);
    clock.advance(MINUTE_MS);
    limiter.check("mutation", "word", "ip-1");
  });

  test("граница окна: до конца окна лимит исчерпан, в следующем окне — сброс", () => {
    const clock = createClock();
    const limiter = new RateLimiter({ mutation: { windowMs: MINUTE_MS, max: 1 } }, clock.now);
    limiter.check("mutation", "word", "ip-1");
    clock.advance(MINUTE_MS - 1);
    expect(() => limiter.check("mutation", "word", "ip-1")).toThrow(ApiError);
    clock.advance(1);
    limiter.check("mutation", "word", "ip-1");
  });

  test("ключи изолированы по route и IP", () => {
    const clock = createClock();
    const limiter = new RateLimiter({ mutation: { windowMs: MINUTE_MS, max: 1 } }, clock.now);
    limiter.check("mutation", "word", "ip-1");
    expect(() => limiter.check("mutation", "word", "ip-1")).toThrow(ApiError);
    limiter.check("mutation", "guessed", "ip-1");
    limiter.check("mutation", "word", "ip-2");
  });

  test("категории имеют независимые счётчики при тех же route+IP", () => {
    const clock = createClock();
    const limiter = new RateLimiter(
      {
        create: { windowMs: MINUTE_MS, max: 1 },
        join: { windowMs: MINUTE_MS, max: 1 },
        mutation: { windowMs: MINUTE_MS, max: 1 },
      },
      clock.now,
    );
    limiter.check("create", "games", "ip-1");
    expect(() => limiter.check("create", "games", "ip-1")).toThrow(ApiError);
    limiter.check("join", "games", "ip-1");
  });

  test("checkRateLimit делегирует переданному limiter", () => {
    const clock = createClock();
    const limiter = new RateLimiter({ mutation: { windowMs: MINUTE_MS, max: 1 } }, clock.now);
    checkRateLimit("mutation", "finish", "ip-9", limiter);
    try {
      checkRateLimit("mutation", "finish", "ip-9", limiter);
      expect.unreachable("второй запрос должен быть отклонён");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("RATE_LIMITED");
    }
  });
});
