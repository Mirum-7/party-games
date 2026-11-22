import { describe, expect, test } from "bun:test";

import {
  API_ERROR_STATUS,
  ApiError,
  type ApiErrorCode,
  errorBody,
  handleApi,
  newCorrelationId,
} from "@/server/http/errors";
import { createMutationLogger, logInternalError } from "@/server/http/logging";

// Документированное соответствие HTTP-статусов и кодов из docs/api.md §6.
const DOCUMENTED_STATUS: Array<[ApiErrorCode, number]> = [
  ["VALIDATION_ERROR", 400],
  ["ORIGIN_REJECTED", 400],
  ["UNAUTHENTICATED", 401],
  ["FORBIDDEN", 403],
  ["GAME_NOT_FOUND", 404],
  ["PLAYER_NOT_FOUND", 404],
  ["GAME_FULL", 409],
  ["NAME_TAKEN", 409],
  ["INVALID_GAME_STATE", 409],
  ["NOT_ENOUGH_PLAYERS", 409],
  ["NOT_ALL_READY", 409],
  ["RATE_LIMITED", 429],
  ["INTERNAL_ERROR", 500],
];

describe("ApiError", () => {
  test("HTTP-статус выводится из документированного кода", () => {
    for (const [code, status] of DOCUMENTED_STATUS) {
      expect(API_ERROR_STATUS[code]).toBe(status);
      expect(new ApiError(code, "msg").status).toBe(status);
    }
  });

  test("хранит код, сообщение и fieldErrors", () => {
    const error = new ApiError("NAME_TAKEN", "Это имя уже занято в комнате", { name: ["Выберите другое имя"] });
    expect(error.code).toBe("NAME_TAKEN");
    expect(error.message).toBe("Это имя уже занято в комнате");
    expect(error.fieldErrors).toEqual({ name: ["Выберите другое имя"] });
  });
});

describe("errorBody", () => {
  test("формирует единый формат ошибки без fieldErrors по умолчанию", () => {
    expect(errorBody(new ApiError("GAME_NOT_FOUND", "Комната не найдена"))).toEqual({
      error: { code: "GAME_NOT_FOUND", message: "Комната не найдена" },
    });
  });

  test("включает fieldErrors только когда они заданы", () => {
    const withFields = errorBody(new ApiError("VALIDATION_ERROR", "Проверьте данные", { word: ["Слово слишком длинное"] }));
    expect(withFields.error.fieldErrors).toEqual({ word: ["Слово слишком длинное"] });
    const withoutFields = errorBody(new ApiError("FORBIDDEN", "Нет доступа"));
    expect("fieldErrors" in withoutFields.error).toBe(false);
  });

  test("correlation ID передаётся только для внутренней ошибки", () => {
    const internal = errorBody(new ApiError("INTERNAL_ERROR", "Внутренняя ошибка сервера"), "corr-1");
    expect(internal.error.correlationId).toBe("corr-1");
    const clientError = errorBody(new ApiError("FORBIDDEN", "Нет доступа"), "corr-2");
    expect("correlationId" in clientError.error).toBe(false);
  });
});

describe("handleApi", () => {
  test("успешный ответ получает Cache-Control: no-store", async () => {
    const response = await handleApi(async () => Response.json({ ok: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  test("ApiError превращается в документированный статус и формат без утечки internals", async () => {
    const response = await handleApi(async () => {
      throw new ApiError("UNAUTHENTICATED", "Сессия истекла");
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(body.error.message).toBe("Сессия истекла");
    expect("correlationId" in body.error).toBe(false);
    expect(JSON.stringify(body)).not.toContain("at ");
  });

  test("непредвиденная ошибка становится 500 INTERNAL_ERROR с correlation ID и без stack/body", async () => {
    const secretPayload = "секретное-слово-которое-нельзя-утекать";
    const response = await handleApi(
      async () => {
        throw new Error(`boom: ${secretPayload}\n    at handler (/srv/src/server/games/secret.ts:42:7)`);
      },
      { correlationId: "corr-test-1" },
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const raw = await response.text();
    const body = JSON.parse(raw);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.correlationId).toBe("corr-test-1");
    expect(raw).not.toContain(secretPayload);
    expect(raw).not.toContain("at handler");
    expect(raw).not.toContain("secret.ts");
  });
});

describe("newCorrelationId", () => {
  test("выдаёт уникальные непустые идентификаторы", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe("логирование", () => {
  test("logMutation сериализует только разрешённые поля", () => {
    const lines: string[] = [];
    const logMutation = createMutationLogger((line) => lines.push(line));
    logMutation({
      action: "submitWord",
      gameId: "game-1",
      playerId: "player-1",
      outcome: "ok",
      revision: 7,
      correlationId: "corr-9",
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(Object.keys(parsed).sort()).toEqual(
      ["action", "correlationId", "gameId", "outcome", "playerId", "revision"].sort(),
    );
    expect(parsed).toEqual({
      action: "submitWord",
      gameId: "game-1",
      playerId: "player-1",
      outcome: "ok",
      revision: 7,
      correlationId: "corr-9",
    });
  });

  test("строка лога mutation не содержит слов, тела запроса и cookie", () => {
    const lines: string[] = [];
    const logMutation = createMutationLogger((line) => lines.push(line));
    logMutation({
      action: "submitWord",
      gameId: "g",
      playerId: "p",
      outcome: "ok",
      revision: 1,
      correlationId: "c",
    });
    const line = lines[0] ?? "";
    expect(line).not.toContain("самолёт");
    expect(line).not.toContain("cookie");
    expect(line).not.toContain("wg_session");
  });

  test("logInternalError пишет correlation ID и имя ошибки, но не сообщение со stack", () => {
    const lines: string[] = [];
    const secret = "DATABASE_URL=postgresql://words:secret@db/words_game";
    logInternalError("corr-5", new Error(`connect failed ${secret}\n at x`), (line) => lines.push(line));
    const line = lines[0] ?? "";
    expect(line).toContain("corr-5");
    expect(line).not.toContain(secret);
    expect(line).not.toContain("at x");
  });
});
