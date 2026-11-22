import "server-only";

import type { Game, Player, PrismaClient } from "@/generated/prisma/client";

import { ApiError } from "@/server/http/errors";

// Защита от некорректного UUID в cookie: fail-closed без обращения к БД.
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type Membership = {
  player: Player;
  game: Game;
};

function normalizeGameCode(code: string): string {
  return code.trim().toUpperCase();
}

// Каждая проверка заново загружает Player и Game из БД. Права админа
// (Game.hostPlayerId) и готовность на этом уровне не кешируются —
// мутационные сервисы повторяют проверки под блокировкой строки Game.
export async function requireMembership(
  db: PrismaClient,
  playerId: string | null,
  gameCode: string,
): Promise<Membership> {
  if (playerId === null || !UUID_PATTERN.test(playerId)) {
    throw new ApiError("UNAUTHENTICATED", "Сессия отсутствует или недействительна");
  }
  const player = await db.player.findUnique({ where: { id: playerId } });
  if (player === null) {
    throw new ApiError("UNAUTHENTICATED", "Игрок не найден, войдите в комнату заново");
  }
  const game = await db.game.findUnique({ where: { code: normalizeGameCode(gameCode) } });
  if (game === null) {
    throw new ApiError("GAME_NOT_FOUND", "Комната не найдена");
  }
  if (player.gameId !== game.id) {
    throw new ApiError("FORBIDDEN", "Вы не участник этой комнаты");
  }
  return { player, game };
}
