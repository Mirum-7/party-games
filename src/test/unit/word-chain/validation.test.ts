import { describe, expect, test } from "bun:test";

import {
  isValidNormalizedName,
  isValidRevision,
  isValidRoomCode,
  isValidScore,
  isValidWord,
  MAX_NAME_LENGTH,
  MAX_WORD_LENGTH,
} from "@/server/games/word-chain/validation";

const EMOJI = "😀";

describe("isValidNormalizedName", () => {
  test("принимает имена длиной 1–24 code points", () => {
    expect(isValidNormalizedName("а")).toBe(true);
    expect(isValidNormalizedName("ы".repeat(MAX_NAME_LENGTH))).toBe(true);
    expect(isValidNormalizedName(EMOJI.repeat(MAX_NAME_LENGTH))).toBe(true);
  });

  test("отклоняет пустые и имена длиннее 24 code points", () => {
    expect(isValidNormalizedName("")).toBe(false);
    expect(isValidNormalizedName("ы".repeat(MAX_NAME_LENGTH + 1))).toBe(false);
    // Длина считается по code points, а не по UTF-16 единицам:
    // 24 эмодзи — это 48 UTF-16 единиц, но 24 code points.
    expect(EMOJI.repeat(MAX_NAME_LENGTH + 1)).toHaveLength((MAX_NAME_LENGTH + 1) * 2);
    expect(isValidNormalizedName(EMOJI.repeat(MAX_NAME_LENGTH + 1))).toBe(false);
  });

  test("отклоняет значение, не прошедшее нормализацию имени", () => {
    expect(isValidNormalizedName(" маша")).toBe(false);
    expect(isValidNormalizedName("маша ")).toBe(false);
    expect(isValidNormalizedName("ма  ша")).toBe(false);
    expect(isValidNormalizedName("МАША\tПЕТЯ")).toBe(false);
  });
});

describe("isValidWord", () => {
  test("принимает слова длиной 1–80 code points после trim", () => {
    expect(isValidWord("слово")).toBe(true);
    expect(isValidWord("ы".repeat(MAX_WORD_LENGTH))).toBe(true);
    expect(isValidWord(EMOJI.repeat(MAX_WORD_LENGTH))).toBe(true);
    // Внутренние пробелы сохраняются.
    expect(isValidWord("два  слова")).toBe(true);
  });

  test("отклоняет пустые слова и слова длиннее 80 code points", () => {
    expect(isValidWord("")).toBe(false);
    expect(isValidWord("   ")).toBe(false);
    expect(isValidWord("ы".repeat(MAX_WORD_LENGTH + 1))).toBe(false);
    expect(isValidWord(EMOJI.repeat(MAX_WORD_LENGTH + 1))).toBe(false);
  });

  test("отклоняет значение с внешними пробелами, не прошедшее trim", () => {
    expect(isValidWord(" слово")).toBe(false);
    expect(isValidWord("слово ")).toBe(false);
  });
});

describe("isValidRoomCode", () => {
  test("принимает код из шести символов алфавита A–Z без I, O и цифр 0, 1", () => {
    expect(isValidRoomCode("ABCDEF")).toBe(true);
    expect(isValidRoomCode("B2N4Q8")).toBe(true);
    expect(isValidRoomCode("234567")).toBe(true);
  });

  test("отклоняет неверную длину, посторонние символы и непрозрачный регистр", () => {
    expect(isValidRoomCode("ABCDE")).toBe(false);
    expect(isValidRoomCode("ABCDEFG")).toBe(false);
    expect(isValidRoomCode("ABCDEI")).toBe(false);
    expect(isValidRoomCode("ABCDEO")).toBe(false);
    expect(isValidRoomCode("ABCD10")).toBe(false);
    expect(isValidRoomCode("ABC DEF")).toBe(false);
    expect(isValidRoomCode("abcdef")).toBe(false);
    expect(isValidRoomCode("АБВГДЕ")).toBe(false);
  });
});

describe("isValidScore", () => {
  test("очки — неотрицательное целое", () => {
    expect(isValidScore(0)).toBe(true);
    expect(isValidScore(1)).toBe(true);
    expect(isValidScore(12)).toBe(true);
    expect(isValidScore(-1)).toBe(false);
    expect(isValidScore(1.5)).toBe(false);
    expect(isValidScore(Number.NaN)).toBe(false);
  });
});

describe("isValidRevision", () => {
  test("ревизия — неотрицательное целое", () => {
    expect(isValidRevision(0)).toBe(true);
    expect(isValidRevision(7)).toBe(true);
    expect(isValidRevision(-1)).toBe(false);
    expect(isValidRevision(0.5)).toBe(false);
  });
});
