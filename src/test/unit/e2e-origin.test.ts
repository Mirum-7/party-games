import { describe, expect, test } from "bun:test";

import config from "../../../playwright.config";
import { APP_ORIGIN } from "@/test/e2e/helpers";

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
});
