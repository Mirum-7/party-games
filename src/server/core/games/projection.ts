import "server-only";

import type { Game, GameResult, GameType, Player } from "@/generated/prisma/client";
import { Prisma, prisma } from "@/server/db";
import { isValidRoomCode, normalizeRoomCode } from "@/server/core/games/code";
import { GameCommandError, invalidInput } from "@/server/core/games/errors";
import { isValidPlayerId } from "@/server/core/players/id";
import type { GameDefinition, GameProjectedState } from "@/server/core/games/types";
import type { Capabilities, GameStateResponse } from "@/shared/contracts/game";

// Персональная проекция состояния для одного viewer. Чтение выполняется в
// согласованной repeatable-read транзакции без блокировки Game: проекция не
// изменяет состояние. Core читает только свои таблицы (Game, Player,
// GameResult); игровые таблицы и game-specific проекцию предоставляет модуль
// через GameDefinition.project, definition передаётся из composition root —
// Core реестр не импортирует.
export async function getGameStateForViewer(input: {
  code: string;
  viewerPlayerId: string;
  resolveDefinition: (type: GameType) => GameDefinition;
}): Promise<GameStateResponse> {
  const code = normalizeRoomCode(input.code);
  if (!isValidRoomCode(code)) {
    throw invalidInput("code", "Код комнаты состоит из шести символов без I, O, 0 и 1");
  }
  // Fail-closed до обращения к БД, иначе валидация Prisma бросит P2007 вместо
  // доменной 401 (общий guard — src/server/core/players/id.ts).
  if (!isValidPlayerId(input.viewerPlayerId)) {
    throw new GameCommandError("UNAUTHENTICATED", 401, "Сессия игрока не найдена");
  }

  return prisma.$transaction(
    async (tx) => {
      const game = await tx.game.findUnique({ where: { code } });
      if (!game) {
        throw new GameCommandError("GAME_NOT_FOUND", 404, "Комната не найдена");
      }
      const definition = input.resolveDefinition(game.type);

      const viewer = await tx.player.findUnique({ where: { id: input.viewerPlayerId } });
      if (!viewer) {
        throw new GameCommandError("UNAUTHENTICATED", 401, "Сессия игрока не найдена");
      }
      if (viewer.gameId !== game.id) {
        throw new GameCommandError("FORBIDDEN", 403, "Не участник комнаты или недостаточно прав");
      }

      const [players, results] = await Promise.all([
        tx.player.findMany({
          where: { gameId: game.id },
          orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        }),
        tx.gameResult.findMany({ where: { gameId: game.id } }),
      ]);

      const projected = await definition.project(tx, { game, viewer, players, results });
      return buildGameStateResponse({ game, viewer, players, results, definition, projected });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

// Общие поля DTO и core-capabilities строит Core; setup/hints/results и
// игровые capabilities приходят из модуля. Служебное submittedWordPlayerIds
// превращается в флаги hasSubmittedWord и не попадает в ответ.
export function buildGameStateResponse(input: {
  game: Game;
  viewer: Player;
  players: Player[];
  results: GameResult[];
  definition: GameDefinition;
  projected: GameProjectedState;
}): GameStateResponse {
  const { game, viewer, players, results, definition, projected } = input;
  const submittedWordPlayerIds = new Set(projected.submittedWordPlayerIds);
  const isHost = game.hostPlayerId === viewer.id;
  const inLobby = projected.phase === "LOBBY";
  const playerCount = players.length;

  const capabilities: Capabilities = {
    canSubmitWord: false,
    canMarkGuessed: false,
    canFinish: false,
    canCancel: false,
    ...projected.capabilities,
    // Core-owned флаги применяются после module capabilities: модуль не может
    // их переопределить через свою проекцию (тип это уже запрещает, порядок —
    // fail-closed защита вглубь).
    canEditSettings: isHost && inLobby,
    canManagePlayers: isHost && inLobby,
    canStart:
      isHost &&
      inLobby &&
      playerCount >= definition.minPlayers &&
      playerCount <= definition.maxPlayers &&
      players.every((player) => player.isReady),
    canRestart: isHost && projected.phase === "FINISHED",
    canLeave: inLobby || projected.phase === "FINISHED",
  };

  return {
    game: {
      code: game.code,
      type: definition.type,
      phase: projected.phase,
      revision: game.revision,
      minPlayers: definition.minPlayers,
      maxPlayers: definition.maxPlayers,
      settings: projected.settings,
      startedAt: toIsoString(game.startedAt),
      playingStartedAt: toIsoString(projected.playingStartedAt),
      finishedAt: toIsoString(game.finishedAt),
    },
    viewer: { playerId: viewer.id },
    players: players.map((player) => ({
      id: player.id,
      name: player.name,
      isHost: player.id === game.hostPlayerId,
      isReady: player.isReady,
      hasSubmittedWord: submittedWordPlayerIds.has(player.id),
      hasGuessed: results.some((result) => result.playerId === player.id && result.place !== null),
    })),
    setup: projected.setup,
    hints: projected.hints,
    results: projected.results,
    capabilities,
  };
}

function toIsoString(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
