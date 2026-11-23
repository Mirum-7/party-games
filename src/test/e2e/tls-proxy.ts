// Тест-only TLS-терминатор для браузерного E2E. Production-сервер (Next)
// остаётся на plain http задним портом 127.0.0.1:<E2E_BACKEND_PORT>, а этот
// прокси слушает https://localhost:<E2E_PORT> и передаёт трафик дальше без
// буферизации, включая долгоживущий SSE-поток. Причина: сессионная cookie
// production-режима Secure, а WebKit не отправляет Secure-cookie по http даже
// на localhost — без реального TLS WebKit-прогоны невозможны. Сертификат
// самоподписанный и генерируется локально через openssl; браузерные контексты
// Playwright доверяют ему через ignoreHTTPSErrors (только в этом конфиге),
// поэтому семантика Secure-cookie и production Next остаются неизменными.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { env } from "node:process";
import { readFileSync } from "node:fs";

const externalPort = Number(env.E2E_PORT ?? "3100");
const backendPort = Number(env.E2E_BACKEND_PORT);
if (!Number.isInteger(backendPort) || backendPort <= 0) {
  throw new Error("E2E_BACKEND_PORT environment variable is required");
}

// Кэш в node_modules (не попадает в git): сертификат один на все прогоны,
// SAN покрывает localhost и 127.0.0.1.
const certDir = join(process.cwd(), "node_modules", ".cache", "words-game-e2e-tls");
const certPath = join(certDir, "cert.pem");
const keyPath = join(certDir, "key.pem");

function ensureCertificate(): void {
  if (existsSync(certPath) && existsSync(keyPath)) return;
  mkdirSync(certDir, { recursive: true });
  const tmpDir = join(certDir, `gen-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  const result = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(tmpDir, "key.pem"),
      "-out", join(tmpDir, "cert.pem"),
      "-days", "3650",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`openssl failed to generate the E2E TLS certificate (exit ${result.status})`);
  }
  // Атомарная публикация: параллельные прогоны генерируют в разные tmpDir,
  // последний rename выигрывает — оба сертификата валидны.
  renameSync(join(tmpDir, "cert.pem"), certPath);
  renameSync(join(tmpDir, "key.pem"), keyPath);
}

async function waitForBackend(): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${backendPort}/`);
      if (response.status > 0) return;
    } catch {
      // Сервер ещё не поднялся — продолжаем опрос.
    }
    if (Date.now() > deadline) {
      throw new Error(`E2E backend did not start on 127.0.0.1:${backendPort} within 120s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function startProxy(): void {
  const server = createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (req, res) => {
      const proxy = httpRequest(
        {
          host: "127.0.0.1",
          port: backendPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
        },
        (upstream) => {
          const headers = { ...upstream.headers };
          // Transfer-Encoding выставит Node сам по мере потоковой записи;
          // остальные заголовки (включая connection и x-accel-buffering)
          // проходят как есть, чтобы SSE-заголовки проверялись по реальным.
          delete headers["transfer-encoding"];
          res.writeHead(upstream.statusCode ?? 502, headers);
          upstream.pipe(res);
        },
      );
      proxy.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(proxy);
    },
  );
  // SSE-подключения живут дольше любых серверных таймаутов.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.listen(externalPort, () => {
    console.log(`[e2e-tls] https://localhost:${externalPort} -> http://127.0.0.1:${backendPort}`);
  });
}

async function main(): Promise<void> {
  ensureCertificate();
  const backend = spawn("bun", ["run", "start", "--port", String(backendPort)], {
    stdio: "inherit",
    env: { ...env },
  });
  const shutdown = (signal: NodeJS.Signals): void => {
    backend.kill(signal);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  backend.on("exit", (code) => {
    console.error(`[e2e-tls] backend exited (code ${code})`);
    process.exit(code ?? 1);
  });
  await waitForBackend();
  startProxy();
}

await main();
