import { normalizeCode, normalizeName, normalizeWord, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "./rules";

export const MAX_NAME_LENGTH = 24;
export const MAX_WORD_LENGTH = 80;

function codePointLength(value: string): number {
  return [...value].length;
}

// Валидаторы работают с уже нормализованными значениями: сервис сначала
// вызывает normalize*, затем проверяет доменные ограничения.
export function isValidNormalizedName(value: string): boolean {
  const length = codePointLength(value);
  return value === normalizeName(value) && length >= 1 && length <= MAX_NAME_LENGTH;
}

export function isValidWord(value: string): boolean {
  const length = codePointLength(value);
  return value === normalizeWord(value) && length >= 1 && length <= MAX_WORD_LENGTH;
}

export function isValidRoomCode(value: string): boolean {
  if (value.length !== ROOM_CODE_LENGTH || normalizeCode(value) !== value) return false;
  for (const ch of value) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

export function isValidScore(score: number): boolean {
  return Number.isInteger(score) && score >= 0;
}

export function isValidRevision(revision: number): boolean {
  return Number.isInteger(revision) && revision >= 0;
}
