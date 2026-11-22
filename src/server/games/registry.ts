import type { GameType } from "@/generated/prisma/client";
import type { GameStateResponse } from "@/shared/contracts/game";
import { getGameStateForViewer } from "@/server/core/games/projection";
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

// Composition root персональной проекции: связывает Core-чтение состояния с
// реестром определений. Каждый вызов строит DTO заново для одного viewer —
// без общего кешируемого DTO и клиентского маскирования.
export function getGameState(code: string, viewerPlayerId: string): Promise<GameStateResponse> {
  return getGameStateForViewer({ code, viewerPlayerId, resolveDefinition: getGameDefinition });
}
