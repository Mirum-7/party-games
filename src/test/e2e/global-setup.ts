import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { Client } from "pg";

import { resolveE2eDatabaseUrl } from "./helpers";

// E2E работает только с одноразовой локальной БД, имя которой оканчивается
// на _e2e. Проверка дублирует src/test/integration/database.ts, чтобы не
// тянуть Prisma Client (путь "@/..." ) в окружение Playwright.
function assertDisposableE2eDatabaseUrl(raw: string): void {
  const url = new URL(raw);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || !url.pathname.slice(1).endsWith("_e2e")) {
    throw new Error("TEST_DATABASE_UNSAFE");
  }
}

// Playwright запускает команды из корня проекта.
const projectRoot = resolve(process.cwd(), ".");

const cleanupOrder = ["word_assignments", "game_results", "word_chain_games", "games", "players"] as const;

async function cleanDatabase(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const table of cleanupOrder) {
      await client.query(`DELETE FROM "${table}"`);
    }
  } finally {
    await client.end();
  }
}

function migrateDeploy(databaseUrl: string): void {
  const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed for E2E database (exit ${result.status})`);
  }
}

async function globalSetup(): Promise<void> {
  const databaseUrl = resolveE2eDatabaseUrl();
  assertDisposableE2eDatabaseUrl(databaseUrl);
  migrateDeploy(databaseUrl);
  await cleanDatabase(databaseUrl);
}

export default globalSetup;
