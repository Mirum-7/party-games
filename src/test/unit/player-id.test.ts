import { describe, expect, test } from "bun:test";

import { isValidPlayerId } from "@/server/core/players/id";

describe("isValidPlayerId", () => {
  test("принимает canonical UUID в нижнем и верхнем регистре", () => {
    expect(isValidPlayerId("9f2a4b1c-8d3e-4a5f-9b7c-1234567890ab")).toBe(true);
    expect(isValidPlayerId("9F2A4B1C-8D3E-4A5F-9B7C-1234567890AB")).toBe(true);
  });

  test("отклоняет malformed и граничные значения", () => {
    expect(isValidPlayerId("not-a-uuid")).toBe(false);
    expect(isValidPlayerId("")).toBe(false);
    expect(isValidPlayerId("9f2a4b1c8d3e4a5f9b7c1234567890ab")).toBe(false);
    expect(isValidPlayerId("9f2a4b1c-8d3e-4a5f-9b7c-1234567890abc")).toBe(false);
    expect(isValidPlayerId("9f2a4b1c-8d3e-4a5f-9b7c-1234567890a")).toBe(false);
    expect(isValidPlayerId("9f2a4b1c-8d3e-4a5f-9b7g-1234567890ab")).toBe(false);
  });
});
