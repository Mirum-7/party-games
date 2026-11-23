import { describe, expect, test } from "bun:test";

import { ApiError } from "@/server/http/errors";
import { checkRateLimit, RATE_LIMIT_RULES, RateLimiter } from "@/server/http/rate-limit";

const MINUTE_MS = 60_000;

// Белый доступ к внутренней карте: рост числа ключей — сам дефект, который
// фиксирует очистка, иначе поведенчески он не наблюдаем.
function liveKeyCount(limiter: RateLimiter): number {
  const internals = limiter as unknown as { windows: Map<string, unknown> };
  return internals.windows.size;
}

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

  test("истёкшие ключи выметаются: карта не растёт всю жизнь процесса", () => {
    const clock = createClock();
    const limiter = new RateLimiter({ mutation: { windowMs: MINUTE_MS, max: 10_000 } }, clock.now);
    for (let i = 0; i < 500; i += 1) {
      limiter.check("mutation", "word", `ip-${i}`);
    }
    expect(liveKeyCount(limiter)).toBe(500);

    // Все окна истекли: следующая проверка запускает очистку, карта сжимается.
    clock.advance(MINUTE_MS * 2);
    limiter.check("mutation", "word", "ip-new");
    expect(liveKeyCount(limiter)).toBe(1);
  });

  test("очистка удаляет только мёртвые окна; живые счётчики сохраняются", () => {
    const clock = createClock(MINUTE_MS - 1); // t=119999, окно 60000..120000
    const limiter = new RateLimiter({ mutation: { windowMs: MINUTE_MS, max: 1 } }, clock.now);
    limiter.check("mutation", "word", "ip-old"); // истечёт на t=120000
    clock.advance(1); // t=120000, новое окно 120000..180000
    limiter.check("mutation", "word", "ip-live"); // следующая очистка на t=179999
    expect(liveKeyCount(limiter)).toBe(2);

    // Окно ip-old истекло, ip-live ещё жив: очистка убирает ровно один ключ.
    clock.advance(MINUTE_MS - 1); // t=179999, граница следующей очистки
    limiter.check("mutation", "word", "ip-new");
    expect(liveKeyCount(limiter)).toBe(2);

    // Счётчик выжившего окна не сброшен: повторный запрос ip-live отклонён.
    expect(() => limiter.check("mutation", "word", "ip-live")).toThrow(ApiError);
    // Новый IP текущего окна лимит не исчерпал.
    limiter.check("mutation", "word", "ip-other");
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
