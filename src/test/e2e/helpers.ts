import { expect, request, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { request as httpsRequest } from "node:https";

import type { GameStateResponse } from "../../shared/contracts/game";

// Тот же порт, что и в playwright.config.ts (E2E_PORT, по умолчанию 3100):
// baseURL контекстов и Origin mutation должны совпадать с APP_ORIGIN сервера.
// Origin единый источник — здесь; config и sse.e2e импортируют его отсюда.
// Схема https: production-cookie сессии Secure, а WebKit не отправляет
// Secure-cookie по http даже на localhost. Весь браузерный трафик идёт через
// тест-only TLS-прокси (tls-proxy.ts) на https://localhost:<E2E_PORT>;
// контексты Playwright доверяют его самоподписанному сертификату через
// ignoreHTTPSErrors конфигурации (см. playwright.config.ts).
const e2ePort = process.env.E2E_PORT ?? "3100";
export const APP_ORIGIN = `https://localhost:${e2ePort}`;
export const API_PREFIX = "/api/v1/games";

export const originHeaders = { origin: APP_ORIGIN };

export type ErrorBody = {
  error: {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
    correlationId?: string;
  };
};

// Rate limit считает запросы по (route, IP). Тестовый сервер запущен с
// TRUST_PROXY=true, поэтому каждый сценарий получает уникальный IP через
// x-forwarded-for и лимиты тестов не складываются. Только rate-limit тест
// намеренно повторяет один IP. Счётчик держится на globalThis: Playwright
// перевычисляет модуль теста между тестами, и модульное состояние сбрасывалось
// бы, приводя к повторному использованию IP внутри одного прогона. Проекты
// (chromium/webkit) выполняются в разных worker-процессах с независимым
// globalThis, поэтому начальное значение сидируется часами и смещается по
// индексу проекта: диапазоны IP разных проектов не пересекаются в пределах
// окна лимита (без смещения часы дают пересекающиеся диапазоны, и чужой
// исчерпанный IP получает мгновенный 429). Расчёт на workers: 1 из
// playwright.config.ts.
type IpCounterGlobal = { __wordsGameE2eIpCounter?: number };

function projectOffset(): number {
  try {
    const info = test.info();
    const index = info.config.projects.findIndex((project) => project.name === info.project.name);
    return Math.max(index, 0) * 50_000;
  } catch {
    return 0;
  }
}

function nextIpValue(): number {
  const state = globalThis as IpCounterGlobal;
  if (state.__wordsGameE2eIpCounter === undefined) {
    state.__wordsGameE2eIpCounter = Math.floor(Date.now() / 1000) + projectOffset();
  }
  state.__wordsGameE2eIpCounter += 1;
  return state.__wordsGameE2eIpCounter;
}

export function nextScenarioIp(): string {
  const value = nextIpValue();
  return `10.213.${Math.floor(value / 254) % 250}.${(value % 254) + 1}`;
}

export function newScenarioContext(ip: string = nextScenarioIp()): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: APP_ORIGIN,
    extraHTTPHeaders: { "x-forwarded-for": ip },
    // Только для тестового самоподписанного сертификата TLS-прокси.
    ignoreHTTPSErrors: true,
  });
}

// --- Тест-only fetch поверх самоподписанного сертификата TLS-прокси ---------

// Глобальный fetch рантайма (и APIRequestContext вне опций) не доверяет
// самоподписанному сертификату прокси, а NODE_EXTRA_CA_CERTS читается рантаймом
// один раз при старте. Тесты, которым нужен "голый" HTTP (живой SSE-поток),
// используют эти обёртки: проверка сертификата отключена явно и только здесь.
export type E2eResponse = {
  status: number;
  headers: Headers;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

export type E2eStreamResponse = {
  status: number;
  headers: Headers;
  body: AsyncGenerator<Uint8Array, void, void>;
  cancel: () => void;
};

function responseHeaders(raw: Record<string, unknown>): Headers {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string") flat[name] = value;
  }
  return new Headers(flat);
}

export function e2eFetch(url: string, options: { headers?: Record<string, string> } = {}): Promise<E2eResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "GET", headers: options.headers, rejectUnauthorized: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: responseHeaders(res.headers),
          json: () => Promise.resolve(JSON.parse(body) as unknown),
          text: () => Promise.resolve(body),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

export function e2eFetchStream(url: string, options: { headers?: Record<string, string> } = {}): Promise<E2eStreamResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "GET", headers: options.headers, rejectUnauthorized: false }, (res) => {
      async function* iterate(): AsyncGenerator<Uint8Array, void, void> {
        try {
          for await (const chunk of res) {
            yield chunk as Uint8Array;
          }
        } finally {
          req.destroy();
        }
      }
      resolve({
        status: res.statusCode ?? 0,
        headers: responseHeaders(res.headers),
        body: iterate(),
        cancel: () => req.destroy(),
      });
    });
    req.on("error", reject);
    req.end();
  });
}

export function expectNoStore(response: APIResponse): void {
  expect(response.headers()["cache-control"]).toContain("no-store");
}

export function setCookieHeader(response: APIResponse): string {
  const setCookie = response.headers()["set-cookie"];
  expect(setCookie, "Set-Cookie header present").toBeTruthy();
  return setCookie as string;
}

export async function readError(response: APIResponse): Promise<ErrorBody> {
  return (await response.json()) as ErrorBody;
}

export async function expectApiError(
  response: APIResponse,
  status: number,
  code: string,
): Promise<ErrorBody> {
  expect(response.status(), `status ${status}`).toBe(status);
  expectNoStore(response);
  const body = await readError(response);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  expect(body.error.message.length).toBeGreaterThan(0);
  return body;
}

export async function createGameViaApi(
  ctx: APIRequestContext,
  name: string,
  options: { headers?: Record<string, string> } = {},
): Promise<{ response: APIResponse; state: GameStateResponse }> {
  const response = await ctx.post(API_PREFIX, {
    data: { name },
    headers: { ...originHeaders, ...options.headers },
  });
  const state = (await response.json()) as GameStateResponse;
  return { response, state };
}

export async function joinGameViaApi(
  ctx: APIRequestContext,
  code: string,
  name: string,
): Promise<{ response: APIResponse; state: GameStateResponse }> {
  const response = await ctx.post(`${API_PREFIX}/${code}/join`, {
    data: { name },
    headers: originHeaders,
  });
  const state = (await response.json()) as GameStateResponse;
  return { response, state };
}

export async function getStateViaApi(
  ctx: APIRequestContext,
  code: string,
  options: { headers?: Record<string, string> } = {},
): Promise<{ response: APIResponse; state: GameStateResponse }> {
  const response = await ctx.get(`${API_PREFIX}/${code}/state`, { headers: options.headers });
  const state = (await response.json()) as GameStateResponse;
  return { response, state };
}

// Комната из трёх игроков (минимум WORD_CHAIN) в LOBBY.
export async function createLobbyOfThree(): Promise<{
  host: APIRequestContext;
  second: APIRequestContext;
  third: APIRequestContext;
  code: string;
  hostId: string;
  secondId: string;
  thirdId: string;
}> {
  const host = await newScenarioContext();
  const created = await createGameViaApi(host, "Маша");
  expect(created.response.status()).toBe(201);
  const code = created.state.game.code;

  const second = await newScenarioContext();
  const joinedSecond = await joinGameViaApi(second, code, "Петя");
  expect(joinedSecond.response.status()).toBe(200);

  const third = await newScenarioContext();
  const joinedThird = await joinGameViaApi(third, code, "Ваня");
  expect(joinedThird.response.status()).toBe(200);

  return {
    host,
    second,
    third,
    code,
    hostId: created.state.viewer.playerId,
    secondId: joinedSecond.state.viewer.playerId,
    thirdId: joinedThird.state.viewer.playerId,
  };
}

// LOBBY → ASSIGNING_WORDS: все готовы, админ запускает.
export async function startAssigningWords(
  lobby: Awaited<ReturnType<typeof createLobbyOfThree>>,
): Promise<void> {
  for (const player of [lobby.host, lobby.second, lobby.third]) {
    const ready = await player.post(`${API_PREFIX}/${lobby.code}/readiness`, {
      data: { ready: true },
      headers: originHeaders,
    });
    expect(ready.status()).toBe(200);
  }
  const started = await lobby.host.post(`${API_PREFIX}/${lobby.code}/start`, {
    headers: originHeaders,
  });
  expect(started.status()).toBe(200);
  const state = (await started.json()) as GameStateResponse;
  expect(state.game.phase).toBe("ASSIGNING_WORDS");
}

// LOBBY → PLAYING: старт + слово от каждого участника.
export async function startPlaying(
  lobby: Awaited<ReturnType<typeof createLobbyOfThree>>,
  words: [string, string, string],
): Promise<void> {
  await startAssigningWords(lobby);
  const players: APIRequestContext[] = [lobby.host, lobby.second, lobby.third];
  for (let index = 0; index < players.length; index += 1) {
    const response = await players[index].put(`${API_PREFIX}/${lobby.code}/word`, {
      data: { word: words[index] },
      headers: originHeaders,
    });
    expect(response.status()).toBe(200);
    const state = (await response.json()) as GameStateResponse;
    expect(state.players[index].hasSubmittedWord).toBe(true);
    if (state.game.phase === "ASSIGNING_WORDS") {
      expect(state.setup?.word).toBe(words[index]);
    } else {
      // Последнее отсутствующее слово атомарно переводит игру в PLAYING:
      // собственный setup больше не показывается.
      expect(state.game.phase).toBe("PLAYING");
      expect(state.setup).toBeNull();
    }
  }
  const { state } = await getStateViaApi(lobby.host, lobby.code);
  expect(state.game.phase).toBe("PLAYING");
}
