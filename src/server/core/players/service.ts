import "server-only";

import type { GameRealtime } from "@/server/core/realtime/types";
import { runGameCommand, requireHost, requireLobby, requireMember } from "@/server/core/games/command";
import type { CommandResult } from "@/server/core/games/command";
import { GameCommandError } from "@/server/core/games/errors";
import { isValidPlayerId } from "@/server/core/players/id";
import type { TransactionClient } from "@/server/db";

// Каждый игрок управляет только собственной готовностью; повторное
// присваивание того же значения — no-op без ревизии и публикации.
export async function setReadiness(input: {
  code: string;
  playerId: string;
  ready: boolean;
  realtime: GameRealtime;
}): Promise<CommandResult<{ playerId: string; isReady: boolean }>> {
  return runGameCommand({
    code: input.code,
    realtime: input.realtime,
    action: "readiness",
    command: async (tx, game) => {
      const player = await requireMember(tx, game.id, input.playerId);
      requireLobby(game);
      if (player.isReady === input.ready) {
        return { changed: false, value: { playerId: player.id, isReady: player.isReady } };
      }
      await tx.player.update({ where: { id: player.id }, data: { isReady: input.ready } });
      return { changed: true, value: { playerId: player.id, isReady: input.ready } };
    },
  });
}

// Удаление чужого участника — только админом в LOBBY; админ не удаляет себя
// через эту команду (для этого есть leave).
export async function removePlayer(input: {
  code: string;
  actorPlayerId: string;
  targetPlayerId: string;
  realtime: GameRealtime;
}): Promise<CommandResult<{ removedPlayerId: string }>> {
  return runGameCommand({
    code: input.code,
    realtime: input.realtime,
    action: "kick",
    command: async (tx, game) => {
      await requireMember(tx, game.id, input.actorPlayerId);
      requireHost(game, input.actorPlayerId);
      requireLobby(game);
      if (input.targetPlayerId === input.actorPlayerId) {
        throw new GameCommandError("FORBIDDEN", 403, "Админ не может удалить сам себя");
      }
      // Fail-closed до Prisma: malformed-UUID бросил бы P2007 вместо 404.
      if (!isValidPlayerId(input.targetPlayerId)) {
        throw new GameCommandError("PLAYER_NOT_FOUND", 404, "Удаляемый участник не найден в комнате");
      }
      const target = await tx.player.findFirst({
        where: { id: input.targetPlayerId, gameId: game.id },
      });
      if (!target) {
        throw new GameCommandError("PLAYER_NOT_FOUND", 404, "Удаляемый участник не найден в комнате");
      }
      await assertNoGameRecords(tx, game.id, target.id);
      await tx.player.delete({ where: { id: target.id } });
      return { changed: true, value: { removedPlayerId: target.id } };
    },
  });
}

// Самостоятельный выход в LOBBY: админ передаёт роль самому раннему оставшемуся
// участнику по (joinedAt, id) до удаления; последний игрок очищает админа
// и удаляет комнату вместе со связанными записями.
export async function leaveGame(input: {
  code: string;
  playerId: string;
  realtime: GameRealtime;
}): Promise<CommandResult<{ removedPlayerId: string; roomDeleted: boolean }>> {
  return runGameCommand<{ removedPlayerId: string; roomDeleted: boolean }>({
    code: input.code,
    realtime: input.realtime,
    action: "leave",
    command: async (tx, game) => {
      await requireMember(tx, game.id, input.playerId);
      requireLobby(game);
      await assertNoGameRecords(tx, game.id, input.playerId);

      const successors = await tx.player.findMany({
        where: { gameId: game.id, id: { not: input.playerId } },
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });

      if (successors.length === 0) {
        await tx.game.update({ where: { id: game.id }, data: { hostPlayerId: null } });
        await tx.player.delete({ where: { id: input.playerId } });
        await tx.game.delete({ where: { id: game.id } });
        return { changed: true, value: { removedPlayerId: input.playerId, roomDeleted: true } };
      }

      if (game.hostPlayerId === input.playerId) {
        await tx.game.update({
          where: { id: game.id },
          data: { hostPlayerId: successors[0].id },
        });
      }
      await tx.player.delete({ where: { id: input.playerId } });
      return { changed: true, value: { removedPlayerId: input.playerId, roomDeleted: false } };
    },
  });
}

async function assertNoGameRecords(
  tx: TransactionClient,
  gameId: string,
  playerId: string,
): Promise<void> {
  const [assignments, results] = await Promise.all([
    tx.wordAssignment.count({
      where: { gameId, OR: [{ authorPlayerId: playerId }, { targetPlayerId: playerId }] },
    }),
    tx.gameResult.count({ where: { gameId, playerId } }),
  ]);
  if (assignments > 0 || results > 0) {
    throw new GameCommandError("INVALID_GAME_STATE", 409, "У игрока есть игровые записи");
  }
}
