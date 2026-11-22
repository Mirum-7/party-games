import { describe, expect, test } from "bun:test";

import { cn } from "@/lib/utils";

describe("cn", () => {
  test("объединяет условные классы и разрешает конфликты Tailwind", () => {
    expect(cn("px-2", false && "hidden", "px-4")).toBe("px-4");
  });
});
