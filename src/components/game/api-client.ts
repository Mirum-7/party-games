import { z } from "zod";

import type { GameStateResponse } from "@/shared/contracts/game";

export type SyncFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ApiClientOptions = {
  fetcher?: SyncFetch;
  signal?: AbortSignal;
};

export type ApiClientErrorOptions = {
  status: number | null;
  code: string;
  fieldErrors?: Record<string, string[]>;
};

const NETWORK_ERROR_CODE = "NETWORK_ERROR";
const REQUEST_FAILED_CODE = "REQUEST_FAILED";
const INVALID_RESPONSE_CODE = "INVALID_RESPONSE";

const NETWORK_ERROR_MESSAGE = "Не удалось связаться с сервером. Проверьте подключение к сети.";
const REQUEST_FAILED_MESSAGE = "Запрос не выполнен. Попробуйте ещё раз.";
const INVALID_RESPONSE_MESSAGE = "Сервер вернул некорректный ответ. Обновите страницу.";

// Сообщение пользователя и код ошибки приходят с сервера; тела запросов,
// cookie и игровые данные никогда не попадают в ошибки и логи.
export class ApiClientError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(message: string, options: ApiClientErrorOptions) {
    super(message);
    this.name = "ApiClientError";
    this.status = options.status;
    this.code = options.code;
    this.fieldErrors = options.fieldErrors;
  }
}

const playerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  isHost: z.boolean(),
  isReady: z.boolean(),
  hasSubmittedWord: z.boolean(),
  hasGuessed: z.boolean(),
});

const playerRefSchema = z.object({ id: z.string(), name: z.string() });

const gameStateResponseSchema = z.object({
  game: z.object({
    code: z.string(),
    type: z.literal("WORD_CHAIN"),
    phase: z.enum(["LOBBY", "ASSIGNING_WORDS", "PLAYING", "FINISHED"]),
    revision: z.number(),
    minPlayers: z.literal(3),
    maxPlayers: z.literal(12),
    settings: z.object({ hideTargetNamesDuringSetup: z.boolean() }),
    startedAt: z.string().nullable(),
    playingStartedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  }),
  viewer: z.object({ playerId: z.string() }),
  players: z.array(playerSummarySchema),
  setup: z
    .object({
      target: playerRefSchema.nullable(),
      targetHidden: z.boolean(),
      word: z.string().nullable(),
    })
    .nullable(),
  hints: z
    .array(
      z.object({
        assignmentId: z.string(),
        author: playerRefSchema,
        target: playerRefSchema,
        word: z.string().nullable(),
        wordHidden: z.boolean(),
      }),
    )
    .nullable(),
  results: z
    .array(
      z.object({
        playerId: z.string(),
        name: z.string(),
        place: z.number().nullable(),
        score: z.number(),
        durationMs: z.number().nullable(),
      }),
    )
    .nullable(),
  capabilities: z.object({
    canEditSettings: z.boolean(),
    canManagePlayers: z.boolean(),
    canStart: z.boolean(),
    canSubmitWord: z.boolean(),
    canMarkGuessed: z.boolean(),
    canFinish: z.boolean(),
    canCancel: z.boolean(),
    canLeave: z.boolean(),
  }),
});

const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  }),
});

function gameUrl(code: string, path: string): string {
  return `/api/v1/games/${encodeURIComponent(code)}${path}`;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

async function parseErrorResponse(response: Response): Promise<ApiClientError> {
  try {
    const body: unknown = await response.json();
    const parsed = apiErrorBodySchema.safeParse(body);
    if (parsed.success) {
      const { code, message, fieldErrors } = parsed.data.error;
      return new ApiClientError(message, { status: response.status, code, fieldErrors });
    }
  } catch {
    // Тело ошибки не является JSON по контракту — используем общее сообщение.
  }
  return new ApiClientError(REQUEST_FAILED_MESSAGE, {
    status: response.status,
    code: REQUEST_FAILED_CODE,
  });
}

async function ensureOk(response: Response): Promise<void> {
  if (!response.ok) {
    throw await parseErrorResponse(response);
  }
}

async function parseGameState(response: Response): Promise<GameStateResponse> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiClientError(INVALID_RESPONSE_MESSAGE, {
      status: response.status,
      code: INVALID_RESPONSE_CODE,
    });
  }
  const parsed = gameStateResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiClientError(INVALID_RESPONSE_MESSAGE, {
      status: response.status,
      code: INVALID_RESPONSE_CODE,
    });
  }
  return parsed.data;
}

async function performFetch(
  fetcher: SyncFetch,
  input: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(input, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiClientError(NETWORK_ERROR_MESSAGE, {
      status: null,
      code: NETWORK_ERROR_CODE,
    });
  }
  return response;
}

function baseInit(method: string, options: ApiClientOptions): RequestInit {
  return {
    method,
    credentials: "same-origin",
    signal: options.signal,
  };
}

export async function getGameState(
  code: string,
  options: ApiClientOptions = {},
): Promise<GameStateResponse> {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const response = await performFetch(fetcher, gameUrl(code, "/state"), {
    ...baseInit("GET", options),
    cache: "no-store",
    headers: new Headers(),
  });
  await ensureOk(response);
  return parseGameState(response);
}

export type MutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export async function sendGameMutation(
  code: string,
  method: MutationMethod,
  path: string,
  body: unknown,
  options: ApiClientOptions = {},
): Promise<GameStateResponse> {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const headers = new Headers();
  let payload: string | undefined;
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  const response = await performFetch(fetcher, gameUrl(code, path), {
    ...baseInit(method, options),
    headers,
    body: payload,
  });
  await ensureOk(response);
  return parseGameState(response);
}

// Выход из комнаты возвращает 204 без тела; успех — просто отсутствие ошибки.
export async function leaveGame(code: string, options: ApiClientOptions = {}): Promise<void> {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const response = await performFetch(fetcher, gameUrl(code, "/leave"), {
    ...baseInit("POST", options),
    headers: new Headers(),
  });
  await ensureOk(response);
}
