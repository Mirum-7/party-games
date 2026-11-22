import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { ApiError } from "@/server/http/errors";
import { getClientAddress, isTrustedProxy, parseJson, requireEmptyBody, requireOrigin } from "@/server/http/request";

const APP_ORIGIN = "https://words.example.com";

function postRequest(body: string | undefined, contentType?: string): Request {
  const headers = new Headers();
  if (contentType !== undefined) headers.set("content-type", contentType);
  return new Request("https://words.example.com/api/v1/games", {
    method: "POST",
    headers,
    body,
  });
}

describe("requireOrigin", () => {
  function requestWithOrigin(origin?: string): Request {
    const headers = new Headers();
    if (origin !== undefined) headers.set("origin", origin);
    return new Request("https://words.example.com/api/v1/games", { method: "POST", headers });
  }

  test("отсутствующий Origin отклоняется с ORIGIN_REJECTED", () => {
    try {
      requireOrigin(requestWithOrigin(), APP_ORIGIN);
      expect.unreachable("Origin должен быть отклонён");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("ORIGIN_REJECTED");
      expect((error as ApiError).status).toBe(400);
    }
  });

  test("точное совпадение с APP_ORIGIN разрешено", () => {
    expect(() => requireOrigin(requestWithOrigin(APP_ORIGIN), APP_ORIGIN)).not.toThrow();
  });

  test.each([
    ["другой хост", "https://evil.example.com"],
    ["другой порт", "https://words.example.com:3000"],
    ["другая схема", "http://words.example.com"],
    ["trailing slash", `${APP_ORIGIN}/`],
    ["префикс домена", "https://sub.words.example.com"],
  ])("несовпадение: %s", (_title, origin) => {
    try {
      requireOrigin(requestWithOrigin(origin), APP_ORIGIN);
      expect.unreachable("Origin должен быть отклонён");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("ORIGIN_REJECTED");
      expect((error as ApiError).status).toBe(400);
    }
  });
});

describe("parseJson", () => {
  const schema = z.object({ name: z.string().min(1), ready: z.boolean().optional() });

  test("принимает application/json и возвращает распарсенные данные", async () => {
    const request = postRequest(JSON.stringify({ name: "Маша", ready: true }), "application/json");
    await expect(parseJson(request, schema)).resolves.toEqual({ name: "Маша", ready: true });
  });

  test("принимает application/json с charset", async () => {
    const request = postRequest(JSON.stringify({ name: "Маша" }), "application/json; charset=utf-8");
    await expect(parseJson(request, schema)).resolves.toEqual({ name: "Маша" });
  });

  test("отклоняет не-JSON content-type с VALIDATION_ERROR", async () => {
    const request = postRequest(JSON.stringify({ name: "Маша" }), "text/plain");
    try {
      await parseJson(request, schema);
      expect.unreachable("должна быть ошибка валидации");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("VALIDATION_ERROR");
      expect((error as ApiError).status).toBe(400);
    }
  });

  test("отклоняет отсутствующий content-type", async () => {
    const request = postRequest(JSON.stringify({ name: "Маша" }));
    await expect(parseJson(request, schema)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("некорректный JSON даёт VALIDATION_ERROR без возврата тела в ошибку", async () => {
    const rawBody = '{"name": "секретное-слово", ';
    const request = postRequest(rawBody, "application/json");
    try {
      await parseJson(request, schema);
      expect.unreachable("должна быть ошибка валидации");
    } catch (error) {
      expect((error as ApiError).code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify((error as ApiError).fieldErrors ?? {})).not.toContain("секретное-слово");
      expect((error as ApiError).message).not.toContain("секретное-слово");
    }
  });

  test("пустое тело даёт VALIDATION_ERROR", async () => {
    const request = postRequest("", "application/json");
    await expect(parseJson(request, schema)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("неизвестные поля отклоняются strict-режимом с fieldErrors по этим полям", async () => {
    const request = postRequest(JSON.stringify({ name: "Маша", isAdmin: true }), "application/json");
    try {
      await parseJson(request, schema);
      expect.unreachable("неизвестные поля должны отклоняться");
    } catch (error) {
      expect((error as ApiError).code).toBe("VALIDATION_ERROR");
      const fieldErrors = (error as ApiError).fieldErrors ?? {};
      expect(Object.keys(fieldErrors)).toContain("isAdmin");
    }
  });

  test("невалидное поле даёт fieldErrors с сообщением для этого поля", async () => {
    const request = postRequest(JSON.stringify({ name: 42 }), "application/json");
    try {
      await parseJson(request, schema);
      expect.unreachable("невалидные данные должны отклоняться");
    } catch (error) {
      expect((error as ApiError).code).toBe("VALIDATION_ERROR");
      expect((error as ApiError).fieldErrors?.name?.length).toBeGreaterThan(0);
      expect(Object.keys((error as ApiError).fieldErrors ?? {})).not.toContain("ready");
    }
  });

  test("JSON не-объект на корне отклоняется", async () => {
    for (const raw of ['["name"]', '"name"', "42"]) {
      const request = postRequest(raw, "application/json");
      await expect(parseJson(request, schema)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });
});

describe("requireEmptyBody", () => {
  test("запрос без тела проходит", async () => {
    await expect(requireEmptyBody(postRequest(undefined))).resolves.toBeUndefined();
  });

  test("пустая строка тела проходит", async () => {
    await expect(requireEmptyBody(postRequest(""))).resolves.toBeUndefined();
  });

  test.each([
    ["JSON-объект", "{}"],
    ["произвольный текст", "hello"],
    ["только whitespace", "  \n "],
  ])("тело у empty-body mutation отклоняется: %s", async (_title, body) => {
    try {
      await requireEmptyBody(postRequest(body, "application/json"));
      expect.unreachable("тело должно отклоняться");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("VALIDATION_ERROR");
      expect((error as ApiError).status).toBe(400);
    }
  });
});

describe("getClientAddress и доверие к прокси", () => {
  test("по умолчанию X-Forwarded-For не доверяется, используется локальный fallback", () => {
    const request = new Request("http://localhost/api", {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(getClientAddress(request, { trustProxy: false })).toBe("local");
  });

  test("при trustProxy берётся первый адрес X-Forwarded-For", () => {
    const request = new Request("http://localhost/api", {
      headers: { "x-forwarded-for": " 203.0.113.10 , 10.0.0.1" },
    });
    expect(getClientAddress(request, { trustProxy: true })).toBe("203.0.113.10");
  });

  test("при trustProxy без заголовка используется fallback", () => {
    const request = new Request("http://localhost/api");
    expect(getClientAddress(request, { trustProxy: true, fallbackIp: "edge-1" })).toBe("edge-1");
  });

  test("fallback-адрес можно задать явно", () => {
    const request = new Request("http://localhost/api", {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(getClientAddress(request, { trustProxy: false, fallbackIp: "internal" })).toBe("internal");
  });

  test("isTrustedProxy реагирует только на явный TRUST_PROXY=true", () => {
    const original = process.env.TRUST_PROXY;
    try {
      process.env.TRUST_PROXY = "true";
      expect(isTrustedProxy()).toBe(true);
      process.env.TRUST_PROXY = "1";
      expect(isTrustedProxy()).toBe(false);
      process.env.TRUST_PROXY = "false";
      expect(isTrustedProxy()).toBe(false);
      delete process.env.TRUST_PROXY;
      expect(isTrustedProxy()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = original;
    }
  });
});
