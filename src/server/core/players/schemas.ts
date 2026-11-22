import { invalidInput } from "@/server/core/games/errors";

export const MAX_PLAYER_NAME_LENGTH = 24;

export function normalizePlayerName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function playerNameKey(value: string): string {
  return normalizePlayerName(value).toLowerCase();
}

export function isValidPlayerName(value: string): boolean {
  const length = [...value].length;
  return value === normalizePlayerName(value) && length >= 1 && length <= MAX_PLAYER_NAME_LENGTH;
}

export type ValidatedPlayerName = { name: string; key: string };

export function normalizeAndValidatePlayerName(raw: string): ValidatedPlayerName {
  const name = normalizePlayerName(raw);
  if (!isValidPlayerName(name)) {
    throw invalidInput("name", `Имя должно содержать от 1 до ${MAX_PLAYER_NAME_LENGTH} символов`);
  }
  return { name, key: playerNameKey(name) };
}
