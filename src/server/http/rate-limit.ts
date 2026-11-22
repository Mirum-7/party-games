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
  count: number;
};

export class RateLimiter {
  private readonly rules: RateLimitRules;
  private readonly windows = new Map<string, WindowEntry>();

  constructor(rules: Partial<RateLimitRules> = {}, now: Clock = () => Date.now()) {
    this.rules = { ...RATE_LIMIT_RULES, ...rules };
    this.now = now;
  }

  private readonly now: Clock;

  check(category: RateLimitCategory, route: string, ip: string): void {
    const rule = this.rules[category];
    const windowStart = Math.floor(this.now() / rule.windowMs) * rule.windowMs;
    const key = `${category}:${route}:${ip}`;
    const current = this.windows.get(key);
    if (current === undefined || current.startedAt !== windowStart) {
      this.windows.set(key, { startedAt: windowStart, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > rule.max) {
      throw new ApiError("RATE_LIMITED", "Слишком много запросов, повторите позже");
    }
  }

  reset(): void {
    this.windows.clear();
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
