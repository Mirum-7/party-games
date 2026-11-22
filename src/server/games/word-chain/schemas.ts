import { z } from "zod";

// Настройки WORD_CHAIN, хранящиеся в WordChainGame. Модуль валидирует
// собственные данные, даже когда вход уже проверен Core.
export const wordChainGameSettingsSchema = z.strictObject({
  hideTargetNamesDuringSetup: z.boolean(),
});

export type WordChainGameSettings = z.infer<typeof wordChainGameSettingsSchema>;

// Тело PUT /word. Строгая синтаксическая проверка: нормализация (только
// trim) и доменные лимиты 1–80 code points применяет сервис после парсинга.
export const submitWordSchema = z.strictObject({
  word: z.string(),
});
export type SubmitWordInput = z.infer<typeof submitWordSchema>;
