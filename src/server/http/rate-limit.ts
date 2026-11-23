import { ApiError } from "./errors";

export type RateLimitCategory = "create" | "join" | "mutation";

export type RateLimitRule = {
  windowMs: number;
  max: number;
};

export type Clock = () => number;

export type RateLimitRules = Record<RateLimitCategory, RateLimitRule>;

// Лимиты зафиксированы в docs/api.md: создание и вход — 30 запросов в минуту,
// остальные mutation — 120 запросов в минуту; окно фиксированное, ключ (route, IP).
export const RATE_LIMIT_RULES: RateLimitRules = {
  create: { windowMs: 60_000, max: 30 },
  join: { windowMs: 60_000, max: 30 },
  mutation: { windowMs: 60_000, max: 120 },
};

type WindowEntry = {
  startedAt: number;
  expiresAt: number;
  count: number;
};

export class RateLimiter {
  private readonly rules: RateLimitRules;
  private readonly windows = new Map<string, WindowEntry>();
  private readonly sweepIntervalMs: number;
  private nextSweepAt: number;

  constructor(rules: Partial<RateLimitRules> = {}, now: Clock = () => Date.now()) {
    this.rules = { ...RATE_LIMIT_RULES, ...rules };
    this.now = now;
    this.sweepIntervalMs = Math.min(...Object.values(this.rules).map((rule) => rule.windowMs));
    this.nextSweepAt = 0;
  }

  private readonly now: Clock;

  // Процесс живёт долго, а ключи (route, IP) создавались бы бесконечно.
  // Поэтому раз в sweepIntervalMs выметаются окна с истекшим сроком; интервал
  // равен минимальному окну правил, так ни одно живое окно не теряет счётчик.
  private sweepExpired(nowMs: number): void {
    for (const [key, entry] of this.windows) {
      if (entry.expiresAt <= nowMs) {
        this.windows.delete(key);
      }
    }
    this.nextSweepAt = nowMs + this.sweepIntervalMs;
  }

  check(category: RateLimitCategory, route: string, ip: string): void {
    const nowMs = this.now();
    if (nowMs >= this.nextSweepAt) {
      this.sweepExpired(nowMs);
    }
    const rule = this.rules[category];
    const windowStart = Math.floor(nowMs / rule.windowMs) * rule.windowMs;
    const key = `${category}:${route}:${ip}`;
    const current = this.windows.get(key);
    if (current === undefined || current.startedAt !== windowStart) {
      this.windows.set(key, {
        startedAt: windowStart,
        expiresAt: windowStart + rule.windowMs,
        count: 1,
      });
      return;
    }
    current.count += 1;
    if (current.count > rule.max) {
      throw new ApiError("RATE_LIMITED", "Слишком много запросов, повторите позже");
    }
  }

  reset(): void {
    this.windows.clear();
    this.nextSweepAt = 0;
  }
}

const defaultRateLimiter = new RateLimiter();

export function checkRateLimit(
  category: RateLimitCategory,
  route: string,
  ip: string,
  limiter: RateLimiter = defaultRateLimiter,
): void {
  limiter.check(category, route, ip);
}
