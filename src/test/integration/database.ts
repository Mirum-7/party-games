import { fileURLToPath } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

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

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));

let migrateDeployPromise: Promise<void> | null = null;

export function applyMigrationsOnce(): Promise<void> {
  migrateDeployPromise ??= runMigrateDeploy();
  return migrateDeployPromise;
}

async function runMigrateDeploy(): Promise<void> {
  const databaseUrl = getTestDatabaseUrl();
  const result = Bun.spawnSync(["bunx", "prisma", "migrate", "deploy"], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stderr.toString()}`);
  }
}

export function createTestPrismaClient(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: getTestDatabaseUrl() }) });
}

const cleanupOrder = ["word_assignments", "game_results", "word_chain_games", "games", "players"] as const;

export async function cleanTables(prisma: PrismaClient): Promise<void> {
  for (const table of cleanupOrder) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  }
}
