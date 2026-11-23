// Тест-only TLS-терминатор для браузерного E2E. Production-сервер (Next)
// остаётся на plain http задним портом 127.0.0.1:<E2E_BACKEND_PORT>, а этот
// прокси слушает https://localhost:<E2E_PORT> (bind только на loopback
// 127.0.0.1: клиенты, у которых localhost резолвится в ::1, быстро делают
// fallback на IPv4) и передаёт трафик дальше без буферизации, включая
// долгоживущий SSE-поток. Причина: сессионная cookie production-режима Secure,
// а WebKit не отправляет Secure-cookie по http даже на localhost — без
// реального TLS WebKit-прогоны невозможны. Сертификат самоподписанный и
// публикуется кэшем из tls-cert.ts (один комбинированный PEM, атомарный
// rename, самовосстановление); требуется openssl. Браузерные контексты
// Playwright доверяют ему через ignoreHTTPSErrors (только в этом конфиге),
// поэтому семантика Secure-cookie и production Next остаются неизменными.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { env } from "node:process";

import { ensureE2eTlsCertificate } from "./tls-cert";

const externalPort = Number(env.E2E_PORT ?? "3100");
const backendPort = Number(env.E2E_BACKEND_PORT);
if (!Number.isInteger(backendPort) || backendPort <= 0) {
  throw new Error("E2E_BACKEND_PORT environment variable is required");
}

async function waitForBackend(): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${backendPort}/`);
      if (response.status > 0) {
        // Тело ответа не нужно, но сокет надо освободить: непрочитанный до
        // конца ответ держит keep-alive соединение открытым и мешает прокси
        // завершиться чисто сразу после прогона.
        await response.body?.cancel().catch(() => {});
        return;
      }
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
  const pem = readFileSync(ensureE2eTlsCertificate());
  const server = createServer({ key: pem, cert: pem }, (req, res) => {
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
        // Клиент ушёл (навигация/перезагрузка закрывают SSE): прекращаем
        // чтение upstream, чтобы backend освободил поток сразу, а не по таймауту.
        res.on("close", () => {
          if (!res.writableEnded) upstream.destroy();
        });
      },
    );
    proxy.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(proxy);
    // Обрыв клиентского запроса (abort) обязан дойти до backend: иначе
    // mutation могла бы выполниться для уже ушедшего клиента незаметно.
    req.on("close", () => {
      if (!req.complete) proxy.destroy();
    });
    res.on("close", () => {
      if (!res.writableEnded) proxy.destroy();
    });
  });
  // SSE-подключения живут дольше любых серверных таймаутов.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.listen(externalPort, "127.0.0.1", () => {
    console.log(`[e2e-tls] https://localhost:${externalPort} -> http://127.0.0.1:${backendPort}`);
  });
}

async function main(): Promise<void> {
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
