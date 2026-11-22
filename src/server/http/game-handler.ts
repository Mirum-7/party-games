import "server-only";

import { webCookies, type CookieJar } from "iron-session";
import type { ZodObject, ZodRawShape } from "zod";
import type { infer as ZodInfer } from "zod";

import { getOptionalPlayerId } from "@/server/core/auth/session";
import { GameCommandError, isGameCommandError } from "@/server/core/games/errors";
import { getGameState } from "@/server/games/state";
import { ApiError, handleApi, jsonResponse } from "@/server/http/errors";
import { checkRateLimit, type RateLimitCategory } from "@/server/http/rate-limit";
import {
  getClientAddress,
  parseJson,
  requireEmptyBody,
  requireOrigin,
} from "@/server/http/request";

// Core не импортирует HTTP: доменные ошибки команд переводятся в HTTP-контракт
// на границе. code+status уже согласованы с docs/api.md §6.
function toApiError(error: GameCommandError): ApiError {
  const fieldErrors =
    error.fieldErrors === undefined
      ? undefined
      : Object.fromEntries(Object.entries(error.fieldErrors).map(([key, value]) => [key, [...value]]));
  return new ApiError(error.code, error.message, fieldErrors);
}

// Единый HTTP-обработчик игровых маршрутов: доменные ошибки переводятся в
// ApiError внутри handleApi, поэтому формат ответа остаётся прежним.
export async function handleGameApi(handler: () => Promise<Response>): Promise<Response> {
  return handleApi(async () => {
    try {
      return await handler();
    } catch (error) {
      if (isGameCommandError(error)) throw toApiError(error);
      throw error;
    }
  });
}

export function getAppOrigin(): string {
  const origin = process.env.APP_ORIGIN;
  if (origin === undefined || origin.length === 0) {
    throw new Error("APP_ORIGIN environment variable is required");
  }
  return origin;
}

export function limitGameRoute(request: Request, category: RateLimitCategory, route: string): void {
  checkRateLimit(category, route, getClientAddress(request));
}

// Контекст маршрута с сессионным jar: iron-session записывает Set-Cookie в
// responseHeaders при save/destroy, заголовки переносятся в финальный ответ.
export type SessionRouteContext = {
  jar: CookieJar;
  responseHeaders: Headers;
};

export function createSessionRouteContext(request: Request): SessionRouteContext {
  const responseHeaders = new Headers();
  return { jar: webCookies(request, responseHeaders), responseHeaders };
}

// Личность вызывающего — только из cookie; тело запроса её не содержит.
export async function requireCallerPlayerId(jar: CookieJar): Promise<string> {
  const playerId = await getOptionalPlayerId(jar);
  if (playerId === null) {
    throw new ApiError("UNAUTHENTICATED", "Сессия отсутствует или недействительна");
  }
  return playerId;
}

export function applySessionHeaders(response: Response, responseHeaders: Headers): Response {
  for (const cookie of responseHeaders.getSetCookie()) {
    response.headers.append("Set-Cookie", cookie);
  }
  return response;
}

// Общий конвейер команд существующей комнаты: rate limit → Origin → тело →
// личность из cookie → сервис → персональный DTO вызывающего. Сервис получает
// playerId вызывающего и возвращает playerId, чьё состояние отвечает (обычно
// тот же). Игровых правил здесь нет — только HTTP-граница.
export async function runGameMutation<S extends ZodObject<ZodRawShape> | null>(input: {
  request: Request;
  code: string;
  rateLimit: { category: RateLimitCategory; route: string };
  bodySchema: S;
  command: (args: {
    body: S extends null ? null : ZodInfer<NonNullable<S>>;
    playerId: string;
  }) => Promise<string>;
}): Promise<Response> {
  const { request, code } = input;
  return handleGameApi(async () => {
    limitGameRoute(request, input.rateLimit.category, input.rateLimit.route);
    requireOrigin(request, getAppOrigin());
    const body =
      input.bodySchema === null
        ? await requireNoBody(request)
        : await parseJson(request, input.bodySchema);
    const session = createSessionRouteContext(request);
    const playerId = await requireCallerPlayerId(session.jar);
    const callerPlayerId = await input.command({
      body: body as S extends null ? null : ZodInfer<NonNullable<S>>,
      playerId,
    });
    const state = await getGameState(code, callerPlayerId);
    return applySessionHeaders(jsonResponse(200, state), session.responseHeaders);
  });
}

async function requireNoBody(request: Request): Promise<null> {
  await requireEmptyBody(request);
  return null;
}
