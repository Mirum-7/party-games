import { describe, expect, test } from "bun:test";

import {
  cryptoRandomInt,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "@/server/core/games/code";

describe("generateRoomCode", () => {
  test("строит код ровно из ROOM_CODE_LENGTH символов алфавита по инъектируемому RNG", () => {
    expect(ROOM_CODE_LENGTH).toBe(6);
    expect(generateRoomCode(() => 0)).toBe("AAAAAA");
    expect(generateRoomCode((max) => max - 1)).toBe("999999");
    const code = generateRoomCode((max) => max - 1);
    expect(code).toHaveLength(ROOM_CODE_LENGTH);
    for (const ch of code) {
      expect(ROOM_CODE_ALPHABET.includes(ch)).toBe(true);
    }
  });

  test("отклоняет выход RNG за пределы алфавита", () => {
    expect(() => generateRoomCode(() => -1)).toThrow("RNG_OUT_OF_RANGE");
    expect(() => generateRoomCode(() => ROOM_CODE_ALPHABET.length)).toThrow("RNG_OUT_OF_RANGE");
    expect(() => generateRoomCode(() => 1.5)).toThrow("RNG_OUT_OF_RANGE");
  });

  test("криптографический RNG всегда даёт валидный код", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(isValidRoomCode(generateRoomCode(cryptoRandomInt))).toBe(true);
    }
  });
});

describe("normalizeRoomCode / isValidRoomCode", () => {
  test("normalize приводит к верхнему регистру и убирает любые пробелы", () => {
    expect(normalizeRoomCode("abcdef")).toBe("ABCDEF");
    expect(normalizeRoomCode(" ab cdef ")).toBe("ABCDEF");
    expect(normalizeRoomCode("ab\tcd\nef")).toBe("ABCDEF");
  });

  test("принимает ровно шесть символов алфавита без I, O, 0, 1", () => {
    expect(isValidRoomCode("ABCDEF")).toBe(true);
    expect(isValidRoomCode("234567")).toBe(true);
    expect(isValidRoomCode("AB2D5H")).toBe(true);
    expect(isValidRoomCode("ABCDE")).toBe(false);
    expect(isValidRoomCode("ABCDEFG")).toBe(false);
    expect(isValidRoomCode("ABCDIF")).toBe(false);
    expect(isValidRoomCode("ABCDOF")).toBe(false);
    expect(isValidRoomCode("ABCD0F")).toBe(false);
    expect(isValidRoomCode("ABCD1F")).toBe(false);
    expect(isValidRoomCode("abcdef")).toBe(false);
    expect(isValidRoomCode("AB CDEF")).toBe(false);
  });
});
