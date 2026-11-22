import type { TransactionClient } from "@/server/db";
import { invalidInput } from "@/server/core/games/errors";

import { wordChainGameSettingsSchema } from "./schemas";

// Запись настроек создаётся вместе с Game, чтобы настройки были доступны
// уже в лобби; значения по умолчанию задаёт схема Prisma.
export async function createWordChainGame(tx: TransactionClient, gameId: string): Promise<void> {
  await tx.wordChainGame.create({ data: { gameId } });
}

// Возвращает true, только если значение фактически изменилось: повторная
// установка того же значения — no-op без увеличения ревизии.
export async function updateWordChainSettings(
  tx: TransactionClient,
  gameId: string,
  input: unknown,
): Promise<boolean> {
  const parsed = wordChainGameSettingsSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput("settings", "Некорректное тело настроек");
  }
  const current = await tx.wordChainGame.findUniqueOrThrow({ where: { gameId } });
  if (current.hideTargetNamesDuringSetup === parsed.data.hideTargetNamesDuringSetup) {
    return false;
  }
  await tx.wordChainGame.update({ where: { gameId }, data: parsed.data });
  return true;
}
