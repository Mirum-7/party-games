// Доменные ошибки Core. Не зависят от Next.js/HTTP: Task 9 переводит code+status
// в HTTP-ответ единым обработчиком ошибок.
export type GameErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "GAME_NOT_FOUND"
  | "PLAYER_NOT_FOUND"
  | "GAME_FULL"
  | "NAME_TAKEN"
  | "INVALID_GAME_STATE";

export type GameErrorStatus = 400 | 401 | 403 | 404 | 409;

export class GameCommandError extends Error {
  readonly code: GameErrorCode;
  readonly status: GameErrorStatus;
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;

  constructor(
    code: GameErrorCode,
    status: GameErrorStatus,
    message: string,
    fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "GameCommandError";
    this.code = code;
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export function isGameCommandError(error: unknown): error is GameCommandError {
  return error instanceof GameCommandError;
}

export function invalidInput(field: string, message: string): GameCommandError {
  return new GameCommandError("VALIDATION_ERROR", 400, "Некорректные входные данные", {
    [field]: [message],
  });
}
