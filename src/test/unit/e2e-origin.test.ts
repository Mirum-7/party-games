import { describe, expect, test } from "bun:test";

import config from "../../../playwright.config";
import { APP_ORIGIN, DEFAULT_E2E_DATABASE_URL, resolveE2eDatabaseUrl } from "@/test/e2e/helpers";

// Регрессия окружения WebKit E2E: production-cookie сессии Secure, а WebKit
// (в отличие от Chromium) не отправляет Secure-cookie по http даже на
// localhost. Поэтому весь браузерный E2E обязан идти через локальный
// TLS-прокси (src/test/e2e/tls-proxy.ts): origin единый для конфигурации
// Playwright, helpers и webServer, и схема обязана быть https.
describe("E2E origin для браузерных тестов", () => {
  test("APP_ORIGIN единый источник и использует https", () => {
    const url = new URL(APP_ORIGIN);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("localhost");
  });

  test("playwright.config использует тот же origin для baseURL и webServer", () => {
    const use = config.use as { baseURL?: string; ignoreHTTPSErrors?: boolean };
    expect(use.baseURL).toBe(APP_ORIGIN);
    expect(use.ignoreHTTPSErrors).toBe(true);
    const webServer = config.webServer as { url?: string; ignoreHTTPSErrors?: boolean };
    expect(webServer.url).toBe(APP_ORIGIN);
    expect(webServer.ignoreHTTPSErrors).toBe(true);
  });

  test("workers=1: партиционирование scenario IP в helpers рассчитано на одного worker", () => {
    expect(config.workers).toBe(1);
  });
});

describe("E2E disposable database", () => {
  test("default — одноразовая words_game_browser_e2e на 127.0.0.1:55432", () => {
    const url = new URL(DEFAULT_E2E_DATABASE_URL);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("55432");
    expect(url.pathname).toBe("/words_game_browser_e2e");
    expect(url.pathname.endsWith("_e2e")).toBe(true);
  });

  test("playwright webServer использует тот же resolver URL, что и global-setup", () => {
    const webServer = config.webServer as { env?: Record<string, string> };
    expect(webServer.env?.DATABASE_URL).toBe(resolveE2eDatabaseUrl());
  });

  test("resolveE2eDatabaseUrl: env override побеждает default", () => {
    const original = process.env.E2E_DATABASE_URL;
    try {
      process.env.E2E_DATABASE_URL = "postgresql://words:words@127.0.0.1:55432/parallel_agent_e2e";
      expect(resolveE2eDatabaseUrl()).toBe(
        "postgresql://words:words@127.0.0.1:55432/parallel_agent_e2e",
      );
    } finally {
      if (original === undefined) {
        delete process.env.E2E_DATABASE_URL;
      } else {
        process.env.E2E_DATABASE_URL = original;
      }
    }
    expect(resolveE2eDatabaseUrl()).toBe(DEFAULT_E2E_DATABASE_URL);
  });
});
