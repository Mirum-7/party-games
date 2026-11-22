import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Защита server-only существует на уровне сборки: в бандле Next.js клиентский
// импорт этих модулей падает ещё до выполнения. Под Bun-тестами пакет
// резолвится через preload-заглушку (src/test/preload.ts), поэтому удержание
// гарда проверяется статически: грязный импорт должен присутствовать в исходниках.
const SERVER_ONLY_MODULES = [
  "src/server/core/auth/session.ts",
  "src/server/core/auth/auth.ts",
  "src/server/db.ts",
];

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("server-only guard", () => {
  test.each(SERVER_ONLY_MODULES)("%s содержит import \"server-only\"", (relativePath) => {
    const source = readFileSync(`${projectRoot}${relativePath}`, "utf8");
    expect(source).toMatch(/^import "server-only";$/m);
  });
});
