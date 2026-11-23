import type { GameType } from "@/generated/prisma/client";
import type { GameStateResponse } from "@/shared/contracts/game";
import { getGameStateForViewer } from "@/server/core/games/projection";
import type { GameDefinition } from "@/server/core/games/types";
import { GameCommandError, invalidInput } from "@/server/core/games/errors";
import { isValidRoomCode, normalizeRoomCode } from "@/server/core/games/code";
import { prisma } from "@/server/db";

import {
  cancelWordChain,
  finishWordChain,
  markGuessed,
  restartWordChain,
  startWordChain,
  submitWord,
  wordChainGameDefinition,
} from "./word-chain/service";

// Composition root реестра игр: единственное место, связывающее тип игры
// с её модулем. Core не импортирует этот файл.
const definitions: Record<GameType, GameDefinition> = {
  WORD_CHAIN: wordChainGameDefinition,
};

export { cancelWordChain, finishWordChain, markGuessed, restartWordChain, startWordChain, submitWord };

export function getGameDefinition(type: GameType): GameDefinition {
  const definition = definitions[type];
  if (!definition) {
    throw new Error(`GAME_TYPE_UNSUPPORTED:${type}`);
  }
  return definition;
}

// Composition root для публичных входов по коду комнаты (join/settings), где
// тип игры хранится в самой комнате: HTTP-слой не знает конкретных игр.
export async function getGameDefinitionForCode(code: string): Promise<GameDefinition> {
  const normalized = normalizeRoomCode(code);
  if (!isValidRoomCode(normalized)) {
    throw invalidInput("code", "Код комнаты состоит из шести символов без I, O, 0 и 1");
  }
  const game = await prisma.game.findUnique({
    where: { code: normalized },
    select: { type: true },
  });
  if (game === null) {
    throw new GameCommandError("GAME_NOT_FOUND", 404, "Комната не найдена");
  }
  return getGameDefinition(game.type);
}

// Composition root персональной проекции: связывает Core-чтение состояния с
// реестром определений. Каждый вызов строит DTO заново для одного viewer —
// без общего кешируемого DTO и клиентского маскирования.
export function getGameState(code: string, viewerPlayerId: string): Promise<GameStateResponse> {
  return getGameStateForViewer({ code, viewerPlayerId, resolveDefinition: getGameDefinition });
}
