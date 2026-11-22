import type { TransactionClient } from "@/server/db";

// Описание типа игры, известное Core. Реализация конкретной игры привязывается
// только в composition root (src/server/games/registry.ts): Core вызывает эти
// хуки и не знает игровых полей и правил.
export type GameDefinition = {
  readonly type: "WORD_CHAIN";
  readonly minPlayers: 3;
  readonly maxPlayers: 12;
  createGame(tx: TransactionClient, gameId: string): Promise<void>;
  updateSettings(tx: TransactionClient, gameId: string, input: unknown): Promise<boolean>;
};
