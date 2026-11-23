import { defineConfig, devices } from "@playwright/test";

import { APP_ORIGIN } from "./src/test/e2e/helpers";

// E2E работает только против production-сервера на выделенном порту и
// одноразовой БД с суффиксом _e2e (проверка в global-setup.ts). Порт
// выделяется через E2E_PORT: параллельные агенты используют разные порты,
// поведение по умолчанию (3100) не меняется.
//
// Браузерный трафик идёт через https://localhost:<E2E_PORT>: сессионная
// cookie production-режима Secure, а WebKit не отправляет Secure-cookie по
// http даже на localhost, поэтому без реального TLS WebKit-прогоны невозможны.
// Тест-only TLS-прокси (src/test/e2e/tls-proxy.ts) терминирует TLS
// самоподписанным сертификатом и передаёт трафик production-серверу Next на
// заднем порту 127.0.0.1:<E2E_BACKEND_PORT>. APP_ORIGIN сервера — видимый
// браузеру origin, он единый в helpers (источник), config и Origin-заголовках.
// ignoreHTTPSErrors включён только в этой конфигурации и относится только к
// самоподписанному сертификату прокси; Secure-семантика cookie не меняется.
const e2ePort = process.env.E2E_PORT ?? "3100";
const e2eBackendPort = String(Number(e2ePort) + 100);
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
    baseURL: APP_ORIGIN,
    trace: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: `bun run build && bun src/test/e2e/tls-proxy.ts`,
    url: APP_ORIGIN,
    reuseExistingServer: false,
    timeout: 300_000,
    ignoreHTTPSErrors: true,
    env: {
      DATABASE_URL: e2eDatabaseUrl,
      APP_ORIGIN,
      SESSION_PASSWORD: testSessionPassword,
      TRUST_PROXY: "true",
      E2E_BACKEND_PORT: e2eBackendPort,
    },
  },
});
