import { describe, expect, test } from "bun:test";

import {
  ApiClientError,
  createGame,
  getGameState,
  joinGame,
  leaveGame,
  sendGameMutation,
  type SyncFetch,
} from "@/components/game/api-client";
import type { GameStateResponse } from "@/shared/contracts/game";

type FetchCall = { input: string; init?: RequestInit };

function createFakeFetch() {
  const calls: FetchCall[] = [];
  const pending: Array<{
    resolve: (response: Response) => void;
    reject: (error: unknown) => void;
    promise: Promise<Response>;
  }> = [];
  const fetcher: SyncFetch = (input, init) => {
    calls.push({ input, init });
    let resolve!: (response: Response) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pending.push({ resolve, reject, promise });
    return promise;
  };
  return { calls, fetcher, pending };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeGameState(revision: number): GameStateResponse {
  return {
    game: {
      code: "K7Q2",
      type: "WORD_CHAIN",
      phase: "PLAYING",
      revision,
      minPlayers: 3,
      maxPlayers: 12,
      settings: { hideTargetNamesDuringSetup: true },
      startedAt: "2026-11-22T10:00:00.000Z",
      playingStartedAt: "2026-11-22T10:05:00.000Z",
      finishedAt: null,
    },
    viewer: { playerId: "player-1" },
    players: [
      {
        id: "player-1",
        name: "Маша",
        isHost: true,
        isReady: true,
        hasSubmittedWord: true,
        hasGuessed: false,
      },
    ],
    setup: null,
    hints: [
      {
        assignmentId: "assignment-1",
        author: { id: "player-2", name: "Петя" },
        target: { id: "player-1", name: "Маша" },
        word: "компас",
        wordHidden: false,
      },
    ],
    results: null,
    capabilities: {
      canEditSettings: false,
      canManagePlayers: false,
      canStart: false,
      canSubmitWord: false,
      canMarkGuessed: true,
      canFinish: false,
      canCancel: false,
      canLeave: true,
    },
  };
}

describe("getGameState", () => {
  test("выполняет GET /state с cache:no-store и переданным AbortSignal", async () => {
    const { calls, fetcher, pending } = createFakeFetch();
    const request = getGameState("k7q2", { fetcher, signal: new AbortController().signal });
    const dto = makeGameState(7);
    pending[0]!.resolve(jsonResponse(200, dto));

    await expect(request).resolves.toEqual(dto);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe("/api/v1/games/k7q2/state");
    expect(calls[0]!.init?.method ?? "GET").toBe("GET");
    expect(calls[0]!.init?.cache).toBe("no-store");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init?.credentials).toBe("same-origin");
    expect((calls[0]!.init?.headers as Headers).has("Content-Type")).toBe(false);
  });

  test("ошибка HTTP с телом error превращается в ApiClientError с code, message и fieldErrors", async () => {
    const { fetcher, pending } = createFakeFetch();
    const request = getGameState("k7q2", { fetcher });
    pending[0]!.resolve(
      jsonResponse(409, {
        error: {
          code: "INVALID_GAME_STATE",
          message: "Действие недоступно в текущей фазе",
          fieldErrors: { word: ["Слово уже зафиксировано"] },
        },
      }),
    );

    const error = await request.then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ApiClientError);
    const apiError = error as ApiClientError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe("INVALID_GAME_STATE");
    expect(apiError.message).toBe("Действие недоступно в текущей фазе");
    expect(apiError.fieldErrors).toEqual({ word: ["Слово уже зафиксировано"] });
  });

  test("ошибка HTTP с некорректным телом даёт стабильный код REQUEST_FAILED и русское сообщение", async () => {
    const { fetcher, pending } = createFakeFetch();
    const request = getGameState("k7q2", { fetcher });
    pending[0]!.resolve(new Response("<html>bad gateway</html>", { status: 502 }));

    const error = (await request.catch((cause: unknown) => cause)) as ApiClientError;
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.status).toBe(502);
    expect(error.code).toBe("REQUEST_FAILED");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("успешный ответ с некорректным DTO отклоняется ошибкой INVALID_RESPONSE", async () => {
    const { fetcher, pending } = createFakeFetch();
    const request = getGameState("k7q2", { fetcher });
    pending[0]!.resolve(jsonResponse(200, { game: { code: "K7Q2" } }));

    const error = (await request.catch((cause: unknown) => cause)) as ApiClientError;
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.status).toBe(200);
    expect(error.code).toBe("INVALID_RESPONSE");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("сетевой сбой даёт NETWORK_ERROR с русским сообщением", async () => {
    const { fetcher, pending } = createFakeFetch();
    const request = getGameState("k7q2", { fetcher });
    pending[0]!.reject(new TypeError("connection reset"));

    const error = (await request.catch((cause: unknown) => cause)) as ApiClientError;
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.status).toBeNull();
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("прерывание по AbortSignal пробрасывает AbortError без обёртки", async () => {
    const { fetcher, pending } = createFakeFetch();
    const request = getGameState("k7q2", { fetcher });
    pending[0]!.reject(new DOMException("Aborted", "AbortError"));

    const error = await request.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

describe("sendGameMutation", () => {
  test("команда с телом шлёт JSON и Content-Type: application/json", async () => {
    const { calls, fetcher, pending } = createFakeFetch();
    const request = sendGameMutation("k7q2", "PUT", "/word", { word: "молния" }, { fetcher });
    const dto = makeGameState(8);
    pending[0]!.resolve(jsonResponse(200, dto));

    await expect(request).resolves.toEqual(dto);
    expect(calls[0]!.input).toBe("/api/v1/games/k7q2/word");
    expect(calls[0]!.init?.method).toBe("PUT");
    const headers = calls[0]!.init?.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ word: "молния" }));
    expect(calls[0]!.init?.credentials).toBe("same-origin");
  });

  test("команда без тела не отправляет Content-Type и body", async () => {
    const { calls, fetcher, pending } = createFakeFetch();
    const request = sendGameMutation("k7q2", "POST", "/guessed", undefined, { fetcher });
    pending[0]!.resolve(jsonResponse(200, makeGameState(9)));

    await request;
    expect(calls[0]!.input).toBe("/api/v1/games/k7q2/guessed");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Headers;
    expect(headers.has("Content-Type")).toBe(false);
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  test("не-2xx ответ сохраняет серверный code и русское message", async () => {
    const { fetcher, pending } = createFakeFetch();
    const request = sendGameMutation("k7q2", "POST", "/guessed", undefined, { fetcher });
    pending[0]!.resolve(
      jsonResponse(401, { error: { code: "UNAUTHENTICATED", message: "Сессия истекла" } }),
    );

    const error = (await request.catch((cause: unknown) => cause)) as ApiClientError;
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.status).toBe(401);
    expect(error.code).toBe("UNAUTHENTICATED");
    expect(error.message).toBe("Сессия истекла");
  });
});

describe("leaveGame", () => {
  test("POST /leave с ответом 204 завершается без DTO", async () => {
    const { calls, fetcher, pending } = createFakeFetch();
    const request = leaveGame("k7q2", { fetcher });
    pending[0]!.resolve(new Response(null, { status: 204 }));

    await expect(request).resolves.toBeUndefined();
    expect(calls[0]!.input).toBe("/api/v1/games/k7q2/leave");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Headers;
    expect(headers.has("Content-Type")).toBe(false);
  });

  test("не-204/не-2xx ответ отклоняется ApiClientError", async () => {
    const { fetcher, pending } = createFakeFetch();
    const request = leaveGame("k7q2", { fetcher });
    pending[0]!.resolve(jsonResponse(404, { error: { code: "GAME_NOT_FOUND", message: "Комната не найдена" } }));

    const error = (await request.catch((cause: unknown) => cause)) as ApiClientError;
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.code).toBe("GAME_NOT_FOUND");
    expect(error.status).toBe(404);
  });
});

describe("createGame / joinGame", () => {
  test("createGame шлёт POST /games с именем и WORD_CHAIN по умолчанию", async () => {
    const { calls, fetcher, pending } = createFakeFetch();
    const request = createGame("Маша", { fetcher });
    pending[0]!.resolve(jsonResponse(201, makeGameState(1)));

    await expect(request).resolves.toBe("K7Q2");
    expect(calls[0]!.input).toBe("/api/v1/games");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ name: "Маша", gameType: "WORD_CHAIN" });
  });

  test("createGame маппит серверные fieldErrors в ApiClientError", async () => {
    const { fetcher, pending } = createFakeFetch();
    const request = createGame("", { fetcher });
    pending[0]!.resolve(
      jsonResponse(422, {
        error: { code: "VALIDATION_FAILED", message: "Проверьте поля", fieldErrors: { name: ["Введите имя"] } },
      }),
    );

    const error = (await request.catch((cause: unknown) => cause)) as ApiClientError;
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.fieldErrors?.name).toEqual(["Введите имя"]);
  });

  test("joinGame шлёт POST /games/{code}/join, нормализуя код, не теряя имя", async () => {
    const { calls, fetcher, pending } = createFakeFetch();
    const request = joinGame(" k7 q2mn ", "Петя", { fetcher });
    pending[0]!.resolve(jsonResponse(200, makeGameState(2)));

    await expect(request).resolves.toBeUndefined();
    expect(calls[0]!.input).toBe("/api/v1/games/K7Q2MN/join");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ name: "Петя" });
  });
});
