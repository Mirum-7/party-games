import { expect, request, type APIRequestContext, type APIResponse } from "@playwright/test";

import type { GameStateResponse } from "../../shared/contracts/game";

// Тот же порт, что и в playwright.config.ts (E2E_PORT, по умолчанию 3100):
// baseURL контекстов и Origin mutation должны совпадать с APP_ORIGIN сервера.
const e2ePort = process.env.E2E_PORT ?? "3100";
export const APP_ORIGIN = `http://127.0.0.1:${e2ePort}`;
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
// бы, приводя к повторному использованию IP внутри одного прогона.
type IpCounterGlobal = { __wordsGameE2eIpCounter?: number };

function nextIpValue(): number {
  const state = globalThis as IpCounterGlobal;
  state.__wordsGameE2eIpCounter = (state.__wordsGameE2eIpCounter ?? 0) + 1;
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
