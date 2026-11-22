import { randomUUID } from "node:crypto";

import { logInternalError } from "./logging";

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "ORIGIN_REJECTED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "GAME_NOT_FOUND"
  | "PLAYER_NOT_FOUND"
  | "GAME_FULL"
  | "NAME_TAKEN"
  | "INVALID_GAME_STATE"
  | "NOT_ENOUGH_PLAYERS"
  | "NOT_ALL_READY"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

// Соответствие HTTP-статусов и кодов зафиксировано в docs/api.md §6.
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  ORIGIN_REJECTED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  GAME_NOT_FOUND: 404,
  PLAYER_NOT_FOUND: 404,
  GAME_FULL: 409,
  NAME_TAKEN: 409,
  INVALID_GAME_STATE: 409,
  NOT_ENOUGH_PLAYERS: 409,
  NOT_ALL_READY: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
    fieldErrors?: Record<string, string[]>;
    correlationId?: string;
  };
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(code: ApiErrorCode, message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = API_ERROR_STATUS[code];
    this.fieldErrors = fieldErrors;
  }
}

export function newCorrelationId(): string {
  return randomUUID();
}

export function errorBody(error: ApiError, correlationId?: string): ApiErrorBody {
  const errorFields: ApiErrorBody["error"] = { code: error.code, message: error.message };
  if (error.fieldErrors !== undefined) {
    errorFields.fieldErrors = error.fieldErrors;
  }
  if (error.code === "INTERNAL_ERROR" && correlationId !== undefined) {
    errorFields.correlationId = correlationId;
  }
  return { error: errorFields };
}

export function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function apiErrorResponse(error: ApiError): Response {
  return jsonResponse(error.status, errorBody(error));
}

export function internalErrorResponse(correlationId: string): Response {
  return jsonResponse(500, errorBody(new ApiError("INTERNAL_ERROR", "Внутренняя ошибка сервера"), correlationId));
}

type ApiHandler = () => Promise<Response>;

export async function handleApi(handler: ApiHandler, options: { correlationId?: string } = {}): Promise<Response> {
  const correlationId = options.correlationId ?? newCorrelationId();
  try {
    const response = await handler();
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof ApiError) {
      return apiErrorResponse(error);
    }
    logInternalError(correlationId, error);
    return internalErrorResponse(correlationId);
  }
}
