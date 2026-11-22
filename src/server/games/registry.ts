import type { GameType } from "@/generated/prisma/client";
import type { GameDefinition } from "@/server/core/games/types";

import {
  cancelWordChain,
  startWordChain,
  submitWord,
  wordChainGameDefinition,
} from "./word-chain/service";

// Composition root реестра игр: единственное место, связывающее тип игры
// с её модулем. Core не импортирует этот файл.
const definitions: Record<GameType, GameDefinition> = {
  WORD_CHAIN: wordChainGameDefinition,
};

export { cancelWordChain, startWordChain, submitWord };

export function getGameDefinition(type: GameType): GameDefinition {
  const definition = definitions[type];
  if (!definition) {
    throw new Error(`GAME_TYPE_UNSUPPORTED:${type}`);
  }
  return definition;
}
