import { ZodError, type ZodObject, type ZodRawShape, type infer as ZodInfer } from "zod";

import { ApiError } from "./errors";

export function requireOrigin(request: Request, appOrigin: string): void {
  const origin = request.headers.get("origin");
  if (origin === null || origin !== appOrigin) {
    throw new ApiError("ORIGIN_REJECTED", "Недоверенный источник запроса");
  }
}

function bodyFieldError(message: string): Record<string, string[]> {
  return { body: [message] };
}

export async function parseJson<S extends ZodObject<ZodRawShape>>(request: Request, schema: S): Promise<ZodInfer<S>> {
  const contentType = request.headers.get("content-type");
  const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime !== "application/json") {
    const message = "Требуется Content-Type application/json";
    throw new ApiError("VALIDATION_ERROR", message, bodyFieldError(message));
  }
  const raw = await request.text();
  if (raw.trim().length === 0) {
    const message = "Тело запроса пустое";
    throw new ApiError("VALIDATION_ERROR", message, bodyFieldError(message));
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    const message = "Некорректный JSON";
    throw new ApiError("VALIDATION_ERROR", message, bodyFieldError(message));
  }
  const result = (schema.strict() as S).safeParse(data);
  if (!result.success) {
    throw new ApiError("VALIDATION_ERROR", "Проверьте введённые данные", toFieldErrors(result.error));
  }
  return result.data;
}

function toFieldErrors(error: ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        pushFieldError(fieldErrors, key, issue.message);
      }
    } else {
      pushFieldError(fieldErrors, issue.path.length > 0 ? issue.path.join(".") : "body", issue.message);
    }
  }
  return fieldErrors;
}

function pushFieldError(fieldErrors: Record<string, string[]>, key: string, message: string): void {
  const list = fieldErrors[key] ?? [];
  list.push(message);
  fieldErrors[key] = list;
}

export async function requireEmptyBody(request: Request): Promise<void> {
  const raw = await request.text();
  if (raw.length > 0) {
    const message = "Для этой команды тело запроса не принимается";
    throw new ApiError("VALIDATION_ERROR", message, bodyFieldError(message));
  }
}

export const LOCAL_FALLBACK_ADDRESS = "local";

export function isTrustedProxy(): boolean {
  return process.env.TRUST_PROXY === "true";
}

export function getClientAddress(
  request: Request,
  options: { trustProxy?: boolean; fallbackIp?: string } = {},
): string {
  const trustProxy = options.trustProxy ?? isTrustedProxy();
  if (trustProxy) {
    const forwardedFor = request.headers.get("x-forwarded-for");
    const first = forwardedFor?.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) {
      return first;
    }
  }
  return options.fallbackIp ?? LOCAL_FALLBACK_ADDRESS;
}
