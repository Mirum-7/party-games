import { defineConfig, devices } from "@playwright/test";

// E2E работает только против production-сервера на выделенном порту и
// одноразовой БД с суффиксом _e2e (проверка в global-setup.ts). Порт
// выделяется через E2E_PORT: параллельные агенты используют разные порты,
// поведение по умолчанию (3100) не меняется.
const e2ePort = process.env.E2E_PORT ?? "3100";
const appOrigin = `http://127.0.0.1:${e2ePort}`;
const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ?? "postgresql://words:words@127.0.0.1:55432/words_game_api_e2e";

// Отдельный тестовый секрет: ни production-, ни development-значение не
// используются и в репозиторий не попадают.
const testSessionPassword = "e2e-test-only-session-password-9c41f7b26d8503ae";

export default defineConfig({
  testDir: "./src/test/e2e",
  testMatch: "**/*.e2e.ts",
  workers: 1,
  timeout: 60_000,
  retries: 0,
  globalSetup: "./src/test/e2e/global-setup.ts",
  use: {
    baseURL: appOrigin,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: `bun run build && bun run start --port ${e2ePort}`,
    url: appOrigin,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      DATABASE_URL: e2eDatabaseUrl,
      APP_ORIGIN: appOrigin,
      SESSION_PASSWORD: testSessionPassword,
      TRUST_PROXY: "true",
    },
  },
});
