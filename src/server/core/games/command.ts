import "server-only";

import type { Game, Player } from "@/generated/prisma/client";
import { prisma } from "@/server/db";
import type { TransactionClient } from "@/server/db";
import type { GameRealtime } from "@/server/core/realtime/types";

import { GameCommandError } from "./errors";
import { lockGameByCode } from "./lock";

export type CommandOutcome<T> = { value: T; changed: boolean };

export type CommandResult<T> = {
  gameId: string;
  revision: number;
  changed: boolean;
  value: T;
};

// Единый протокол команд существующей комнаты: транзакция, блокировка строки
// Game, повторные проверки внутри command, атомарное увеличение revision и
// публикация только после успешного commit.
export async function runGameCommand<T>(input: {
  code: string;
  realtime: GameRealtime;
  action: string;
  command: (tx: TransactionClient, game: Game) => Promise<CommandOutcome<T>>;
}): Promise<CommandResult<T>> {
  const result = await prisma.$transaction(async (tx) => {
    const gameId = await lockGameByCode(tx, input.code);
    const game = await tx.game.findUniqueOrThrow({ where: { id: gameId } });
    const outcome = await input.command(tx, game);

    let revision = game.revision;
    let gameExists = true;
    if (outcome.changed) {
      try {
        const updated = await tx.game.update({
          where: { id: game.id },
          data: { revision: { increment: 1 } },
          select: { revision: true },
        });
        revision = updated.revision;
      } catch (error) {
        // Команда могла удалить саму комнату (последний игрок вышел):
        // ревизии больше нет, публиковать нечего.
        if (!isRecordNotFound(error)) throw error;
        gameExists = false;
      }
    }
    return { gameId: game.id, revision, changed: outcome.changed, value: outcome.value, gameExists };
  });

  if (result.changed && result.gameExists) {
    input.realtime.publish(result.gameId, result.revision);
  }
  console.info(
    JSON.stringify({
      event: "game.command",
      action: input.action,
      gameId: result.gameId,
      changed: result.changed,
      revision: result.revision,
    }),
  );
  return result;
}

function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "P2025"
  );
}

// --- Повторяемые под блокировкой проверки прав и фазы ---

export async function requireMember(
  tx: TransactionClient,
  gameId: string,
  playerId: string,
): Promise<Player> {
  const player = await tx.player.findFirst({ where: { id: playerId, gameId } });
  if (!player) {
    throw new GameCommandError("FORBIDDEN", 403, "Не участник комнаты или недостаточно прав");
  }
  return player;
}

export function requireHost(game: Game, playerId: string): void {
  if (game.hostPlayerId !== playerId) {
    throw new GameCommandError("FORBIDDEN", 403, "Не участник комнаты или недостаточно прав");
  }
}

export function requireLobby(game: Game): void {
  if (game.status !== "LOBBY") {
    throw new GameCommandError("INVALID_GAME_STATE", 409, "Действие недопустимо в текущей фазе");
  }
}
