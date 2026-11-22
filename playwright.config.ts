import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src/test/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.APP_ORIGIN ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
});
