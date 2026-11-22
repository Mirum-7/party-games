import { randomInt } from "node:crypto";

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;

export type RandomInt = (maxExclusive: number) => number;

export const cryptoRandomInt: RandomInt = (maxExclusive) => randomInt(maxExclusive);

export function generateRoomCode(nextInt: RandomInt): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    const index = nextInt(ROOM_CODE_ALPHABET.length);
    if (!Number.isInteger(index) || index < 0 || index >= ROOM_CODE_ALPHABET.length) {
      throw new Error("RNG_OUT_OF_RANGE");
    }
    code += ROOM_CODE_ALPHABET[index];
  }
  return code;
}

export function normalizeRoomCode(value: string): string {
  return value.replace(/\s+/gu, "").toUpperCase();
}

export function isValidRoomCode(value: string): boolean {
  if (value.length !== ROOM_CODE_LENGTH || normalizeRoomCode(value) !== value) return false;
  for (const ch of value) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}
