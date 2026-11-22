import type { GameDefinition } from "@/server/core/games/types";

import { createWordChainGame, updateWordChainSettings } from "./settings";

// Сборка описания игры для реестра: Core вызывает хуки, не зная полей настроек
// и правил WORD_CHAIN.
export const wordChainGameDefinition: GameDefinition = {
  type: "WORD_CHAIN",
  minPlayers: 3,
  maxPlayers: 12,
  createGame: createWordChainGame,
  updateSettings: updateWordChainSettings,
};
