import { z } from "zod";

// Настройки WORD_CHAIN, хранящиеся в WordChainGame. Модуль валидирует
// собственные данные, даже когда вход уже проверен Core.
export const wordChainGameSettingsSchema = z.strictObject({
  hideTargetNamesDuringSetup: z.boolean(),
});

export type WordChainGameSettings = z.infer<typeof wordChainGameSettingsSchema>;
