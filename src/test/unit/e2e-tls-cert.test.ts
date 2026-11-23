import { createServer, get as httpsGet, type Server } from "node:https";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { E2E_TLS_PEM_FILE, ensureE2eTlsCertificate } from "@/test/e2e/tls-cert";

const certDirs: string[] = [];

function tempCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "words-game-e2e-cert-"));
  certDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (certDirs.length > 0) {
    rmSync(certDirs.pop()!, { recursive: true, force: true });
  }
});

describe("ensureE2eTlsCertificate", () => {
  test("публикует сертификат+ключ одним PEM-файлом и не пересоздаёт его повторным вызовом", () => {
    const dir = tempCacheDir();
    const pemPath = ensureE2eTlsCertificate(dir, { stdio: "pipe" });

    expect(pemPath).toBe(join(dir, E2E_TLS_PEM_FILE));
    const pem = readFileSync(pemPath, "utf8");
    expect(pem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(pem).toContain("-----BEGIN CERTIFICATE-----");
    // Публикация атомарна: временных файлов и каталогов генерации не осталось.
    expect(readdirSync(dir).sort()).toEqual([E2E_TLS_PEM_FILE]);

    const mtimeMs = statSync(pemPath).mtimeMs;
    const again = ensureE2eTlsCertificate(dir, { stdio: "pipe" });
    expect(again).toBe(pemPath);
    expect(statSync(pemPath).mtimeMs).toBe(mtimeMs);
  });

  test("повреждённый PEM перегенерируется (самовосстановление кэша)", () => {
    const dir = tempCacheDir();
    const pemPath = ensureE2eTlsCertificate(dir, { stdio: "pipe" });
    writeFileSync(pemPath, "garbage without key and certificate");

    const restored = ensureE2eTlsCertificate(dir, { stdio: "pipe" });
    const pem = readFileSync(restored, "utf8");
    expect(pem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(pem).toContain("-----BEGIN CERTIFICATE-----");
  });

  test("комбинированный PEM реально работает с node:https на loopback", async () => {
    const dir = tempCacheDir();
    const pemPath = ensureE2eTlsCertificate(dir, { stdio: "pipe" });
    const pem = readFileSync(pemPath, "utf8");

    const server: Server = createServer({ key: pem, cert: pem }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("tls-ok");
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("server did not bind to a TCP port");
      }
      const body = await new Promise<string>((resolve, reject) => {
        httpsGet({ host: "127.0.0.1", port: address.port, rejectUnauthorized: false }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        }).on("error", reject);
      });
      expect(body).toBe("tls-ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("удаляет устаревшие gen-* каталоги прошлых прогонов", () => {
    const dir = tempCacheDir();
    const stale = join(dir, "gen-12345");
    mkdirSync(stale);
    writeFileSync(join(stale, "cert.pem"), "stale");
    expect(existsSync(stale)).toBe(true);

    ensureE2eTlsCertificate(dir, { stdio: "pipe" });

    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual([E2E_TLS_PEM_FILE]);
  });
});
