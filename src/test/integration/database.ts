export function assertDisposableDatabaseUrl(raw: string, suffix: "_test" | "_e2e"): void {
  const url = new URL(raw);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || !url.pathname.slice(1).endsWith(suffix)) throw new Error("TEST_DATABASE_UNSAFE");
}

export function getTestDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? "postgresql://words:words@127.0.0.1:55432/words_game_test";
  assertDisposableDatabaseUrl(raw, "_test");
  return raw;
}
