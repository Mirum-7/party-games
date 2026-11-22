import { describe, expect, test } from "bun:test";
import { assertDisposableDatabaseUrl } from "@/test/integration/database";

describe("test database safety", () => {
  test("accepts only local disposable databases", () => {
    expect(() => assertDisposableDatabaseUrl("postgresql://u:p@127.0.0.1:55432/words_game_test", "_test")).not.toThrow();
    expect(() => assertDisposableDatabaseUrl("postgresql://u:p@127.0.0.1:55432/words_game", "_test")).toThrow("TEST_DATABASE_UNSAFE");
    expect(() => assertDisposableDatabaseUrl("postgresql://u:p@example.com/words_game_test", "_test")).toThrow("TEST_DATABASE_UNSAFE");
  });
});
