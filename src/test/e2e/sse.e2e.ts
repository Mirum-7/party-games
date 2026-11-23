import { expect, request, test, type APIRequestContext, type APIResponse } from "@playwright/test";

import type { GameStateResponse } from "../../shared/contracts/game";
import {
  API_PREFIX,
  createGameViaApi,
  getStateViaApi,
  joinGameViaApi,
  nextScenarioIp,
  setCookieHeader,
  startPlaying,
  type ErrorBody,
} from "./helpers";

// Тот же источник порта, что и в playwright.config.ts (E2E_PORT, по умолчанию
// 3100). Производственный сервер стартует на этом порту, поэтому живой поток
// открывается именно здесь: если конфигурация порта сломана, поток не
// откроется и тест упадёт, а не «пройдёт» против неправильного сервера.
const e2ePort = process.env.E2E_PORT ?? "3100";
const appOrigin = `http://127.0.0.1:${e2ePort}`;
const originHeaders = { origin: appOrigin };

const REVISION_DATA_PATTERN = /^\{"revision":\d+\}$/;
const REVISION_FRAME_PATTERN = /^id: (\d+)\nevent: game\.changed\ndata: \{"revision":(\1)\}$/;

type SseFrame = {
  raw: string;
  id: string | null;
  event: string | null;
  data: string | null;
  comment: string | null;
  retry: string | null;
};

type EventStream = {
  response: Response;
  readFrame: (timeoutMs?: number) => Promise<SseFrame>;
  readRawText: () => string;
  close: () => Promise<void>;
};

// Playwright APIRequestContext не отдаёт инкрементальное тело потока, поэтому
// живой SSE читается нативным fetch: реальные байты, точные заголовки, abort
// для чистого закрытия. Cookie передаём вручную из Set-Cookie ответа создания.
function scenarioContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: appOrigin,
    extraHTTPHeaders: { "x-forwarded-for": nextScenarioIp() },
  });
}

function sessionCookieFrom(response: APIResponse): string {
  const setCookie = setCookieHeader(response);
  const match = /wg_session=([^;]+)/.exec(setCookie);
  expect(match, "wg_session присутствует в Set-Cookie").not.toBeNull();
  return match === null ? "" : match[1];
}

function parseSseFrame(raw: string): SseFrame {
  const frame: SseFrame = { raw, id: null, event: null, data: null, comment: null, retry: null };
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      frame.comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") frame.id = value;
    else if (field === "event") frame.event = value;
    else if (field === "data") frame.data = frame.data === null ? value : `${frame.data}\n${value}`;
    else if (field === "retry") frame.retry = value;
  }
  return frame;
}

type FrameWaiter = {
  resolve: (frame: SseFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

async function openEventStream(code: string, sessionCookie: string): Promise<EventStream> {
  const controller = new AbortController();
  const response = await fetch(`${appOrigin}${API_PREFIX}/${code}/events`, {
    headers: { cookie: `wg_session=${sessionCookie}`, accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (response.status !== 200 || response.body === null) {
    throw new Error(`SSE-поток не открылся: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const queue: SseFrame[] = [];
  const waiters: FrameWaiter[] = [];
  let buffer = "";
  let rawText = "";
  let streamEnded: Error | null = null;

  const notify = (): void => {
    while (queue.length > 0 && waiters.length > 0) {
      const waiter = waiters.shift();
      const frame = queue.shift();
      if (waiter === undefined || frame === undefined) break;
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  };

  const failWaiters = (error: Error): void => {
    streamEnded = error;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  const pump = (async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          failWaiters(new Error("SSE-поток закрыт сервером"));
          return;
        }
        const chunk = decoder.decode(value, { stream: true });
        rawText += chunk;
        buffer += chunk;
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (raw.length > 0) queue.push(parseSseFrame(raw));
          boundary = buffer.indexOf("\n\n");
        }
        notify();
      }
    } catch (error) {
      if (streamEnded === null) {
        failWaiters(error instanceof Error ? error : new Error(String(error)));
      }
    }
  })();

  return {
    response,
    readFrame: (timeoutMs = 10_000) =>
      new Promise<SseFrame>((resolve, reject) => {
        const frame = queue.shift();
        if (frame !== undefined) {
          resolve(frame);
          return;
        }
        if (streamEnded !== null) {
          reject(streamEnded);
          return;
        }
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`таймаут ожидания SSE-фрейма (${timeoutMs} мс)`));
        }, timeoutMs);
        waiters.push({ resolve, reject, timer });
      }),
    readRawText: () => rawText,
    close: async () => {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // Поток уже отменён abort — повторный cancel безопасен.
      }
      try {
        await pump;
      } catch {
        // Pump завершается AbortError при закрытии.
      }
    },
  };
}

function expectRevisionFrame(frame: SseFrame, revision: number): void {
  expect(frame.event).toBe("game.changed");
  expect(frame.id).toBe(String(revision));
  expect(frame.data).toBe(`{"revision":${revision}}`);
  expect(REVISION_DATA_PATTERN.test(frame.data ?? "")).toBe(true);
  expect(REVISION_FRAME_PATTERN.test(frame.raw)).toBe(true);
}

async function createLobbyWithStreamCookie(): Promise<{
  host: APIRequestContext;
  second: APIRequestContext;
  third: APIRequestContext;
  code: string;
  hostId: string;
  secondId: string;
  thirdId: string;
  cookie: string;
}> {
  const host = await scenarioContext();
  const created = await createGameViaApi(host, "Маша");
  expect(created.response.status()).toBe(201);
  const code = created.state.game.code;
  const cookie = sessionCookieFrom(created.response);

  const second = await scenarioContext();
  const joinedSecond = await joinGameViaApi(second, code, "Петя");
  expect(joinedSecond.response.status()).toBe(200);

  const third = await scenarioContext();
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
    cookie,
  };
}

test("авторизованный поток: точные SSE-заголовки, retry: 3000 и начальная ревизия из /state", async () => {
  const ctx = await scenarioContext();
  const created = await createGameViaApi(ctx, "Маша");
  const code = created.state.game.code;
  const cookie = sessionCookieFrom(created.response);

  const { state } = await getStateViaApi(ctx, code);
  const revision = state.game.revision;

  const stream = await openEventStream(code, cookie);
  try {
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toBe("text/event-stream");
    expect(stream.response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(stream.response.headers.get("connection")).toBe("keep-alive");
    expect(stream.response.headers.get("x-accel-buffering")).toBe("no");

    const retry = await stream.readFrame();
    expect(retry.raw).toBe("retry: 3000");
    expect(retry.retry).toBe("3000");

    const initial = await stream.readFrame();
    expectRevisionFrame(initial, revision);
  } finally {
    await stream.close();
  }
});

test("GET /events без членства: обычный JSON 401/403 с no-store до открытия потока", async () => {
  const ctx = await scenarioContext();
  const created = await createGameViaApi(ctx, "Маша");
  const code = created.state.game.code;

  const anonymous = await fetch(`${appOrigin}${API_PREFIX}/${code}/events`);
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get("content-type")).toContain("application/json");
  expect(anonymous.headers.get("cache-control")).toContain("no-store");
  expect(anonymous.headers.get("content-type")).not.toBe("text/event-stream");
  const anonymousBody = (await anonymous.json()) as ErrorBody;
  expect(anonymousBody.error.code).toBe("UNAUTHENTICATED");
  expect(anonymousBody.error.message.length).toBeGreaterThan(0);

  const outsider = await scenarioContext();
  const outsiderCreated = await createGameViaApi(outsider, "Петя");
  const forbidden = await fetch(`${appOrigin}${API_PREFIX}/${code}/events`, {
    headers: { cookie: `wg_session=${sessionCookieFrom(outsiderCreated.response)}` },
  });
  expect(forbidden.status).toBe(403);
  expect(forbidden.headers.get("content-type")).toContain("application/json");
  expect(forbidden.headers.get("cache-control")).toContain("no-store");
  const forbiddenBody = (await forbidden.json()) as ErrorBody;
  expect(forbiddenBody.error.code).toBe("FORBIDDEN");
  expect(forbiddenBody.error.message.length).toBeGreaterThan(0);

  const missing = await fetch(`${appOrigin}${API_PREFIX}/ZZZZZZ/events`, {
    headers: { cookie: `wg_session=${sessionCookieFrom(created.response)}` },
  });
  expect(missing.status).toBe(404);
  expect(missing.headers.get("content-type")).toContain("application/json");
  expect(missing.headers.get("cache-control")).toContain("no-store");
  const missingBody = (await missing.json()) as ErrorBody;
  expect(missingBody.error.code).toBe("GAME_NOT_FOUND");
});

test("mutation во время чтения: ревизия фрейма равна ревизии committed-ответа; no-op без фрейма", async () => {
  const lobby = await createLobbyWithStreamCookie();

  const stream = await openEventStream(lobby.code, lobby.cookie);
  try {
    const retry = await stream.readFrame();
    expect(retry.raw).toBe("retry: 3000");
    const initial = await stream.readFrame();
    expect(initial.id).not.toBeNull();
    const initialRevision = Number(initial.id);

    const ready = await lobby.second.post(`${API_PREFIX}/${lobby.code}/readiness`, {
      data: { ready: true },
      headers: originHeaders,
    });
    expect(ready.status()).toBe(200);
    const readyState = (await ready.json()) as GameStateResponse;
    expect(readyState.game.revision).toBe(initialRevision + 1);

    const frame = await stream.readFrame();
    expectRevisionFrame(frame, readyState.game.revision);

    const readyThird = await lobby.third.post(`${API_PREFIX}/${lobby.code}/readiness`, {
      data: { ready: true },
      headers: originHeaders,
    });
    expect(readyThird.status()).toBe(200);
    const readyThirdState = (await readyThird.json()) as GameStateResponse;
    const frameThird = await stream.readFrame();
    expectRevisionFrame(frameThird, readyThirdState.game.revision);

    // Идемпотентный повтор без изменения ревизии не публикует событие.
    const repeat = await lobby.second.post(`${API_PREFIX}/${lobby.code}/readiness`, {
      data: { ready: true },
      headers: originHeaders,
    });
    expect(repeat.status()).toBe(200);
    expect(((await repeat.json()) as GameStateResponse).game.revision).toBe(
      readyThirdState.game.revision,
    );
    await expect(stream.readFrame(2_500)).rejects.toThrow(/таймаут ожидания SSE-фрейма/);
  } finally {
    await stream.close();
  }
});

test("поток несёт только {\"revision\":N}: нет кода, имён, слов, результатов, id игроков и cookie", async () => {
  const lobby = await createLobbyWithStreamCookie();
  await startPlaying(lobby, ["самолёт", "поезд", "корабль"]);

  const stream = await openEventStream(lobby.code, lobby.cookie);
  try {
    const retry = await stream.readFrame();
    expect(retry.raw).toBe("retry: 3000");
    const initial = await stream.readFrame();
    expect(initial.event).toBe("game.changed");

    const frames: SseFrame[] = [initial];
    for (const player of [lobby.second, lobby.host, lobby.third]) {
      const guessed = await player.post(`${API_PREFIX}/${lobby.code}/guessed`, {
        headers: originHeaders,
      });
      expect(guessed.status()).toBe(200);
      frames.push(await stream.readFrame());
    }

    for (const frame of frames) {
      expectRevisionFrame(frame, Number(frame.id));
    }

    const raw = stream.readRawText();
    const secrets = [
      lobby.code,
      "Маша",
      "Петя",
      "Ваня",
      "самолёт",
      "поезд",
      "корабль",
      lobby.hostId,
      lobby.secondId,
      lobby.thirdId,
      lobby.cookie,
      "wg_session",
    ];
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThan(0);
      expect(raw).not.toContain(secret);
    }
  } finally {
    await stream.close();
  }
});

test("heartbeat : ping на реальном 15-секундном интервале и чистое закрытие потока", async () => {
  test.setTimeout(45_000);
  const ctx = await scenarioContext();
  const created = await createGameViaApi(ctx, "Маша");
  const code = created.state.game.code;
  const cookie = sessionCookieFrom(created.response);

  const stream = await openEventStream(code, cookie);
  let openedAt = 0;
  try {
    const retry = await stream.readFrame();
    expect(retry.raw).toBe("retry: 3000");
    await stream.readFrame();
    openedAt = Date.now();

    const ping = await stream.readFrame(35_000);
    const elapsed = Date.now() - openedAt;
    expect(ping.raw).toBe(": ping");
    expect(ping.comment).toBe("ping");
    expect(elapsed, "heartbeat не сокращён: первый ping не раньше 15 с").toBeGreaterThanOrEqual(
      14_000,
    );
    expect(elapsed, "первый ping в разумном окне после 15 с").toBeLessThan(30_000);
  } finally {
    await stream.close();
  }

  // Чистое закрытие: сессия жива, авторизованный запрос состояния работает.
  const after = await getStateViaApi(ctx, code);
  expect(after.response.status()).toBe(200);
  expect(after.state.game.code).toBe(code);
});
