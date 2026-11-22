import { z } from "zod";

// Strict-схемы тел запросов. Нормализация и доменные лимиты применяются
// сервисом после синтаксической проверки; личность вызывающего сюда не входит.
export const createGameSchema = z.strictObject({
  name: z.string(),
  gameType: z.literal("WORD_CHAIN").optional(),
});
export type CreateGameInput = z.infer<typeof createGameSchema>;

export const joinGameSchema = z.strictObject({
  name: z.string(),
});
export type JoinGameInput = z.infer<typeof joinGameSchema>;

export const readinessSchema = z.strictObject({
  ready: z.boolean(),
});
export type ReadinessInput = z.infer<typeof readinessSchema>;

export const wordChainSettingsSchema = z.strictObject({
  hideTargetNamesDuringSetup: z.boolean(),
});
export type WordChainSettingsInput = z.infer<typeof wordChainSettingsSchema>;
