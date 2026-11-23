import { notFound } from "next/navigation";

import { GameRoom, GameRoomJoin } from "@/components/game/game-room";
import { requireMembership } from "@/server/core/auth/auth";
import { getOptionalPlayerId } from "@/server/core/auth/session";
import { prisma } from "@/server/db";
import { getGameState } from "@/server/games/state";
import { ApiError } from "@/server/http/errors";

export const dynamic = "force-dynamic";

function normalizeCodeValue(value: string): string {
  return value.trim().toUpperCase();
}

// Серверный рендер комнаты по cookie: без внутреннего HTTP. Действительное
// членство получает персональный DTO для GameRoom; неизвестная комната — 404;
// остальным показывается форма входа с предзаполненным кодом.
export default async function GamePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const normalizedCode = normalizeCodeValue(code);
  const playerId = await getOptionalPlayerId();

  if (playerId !== null) {
    let membershipGame: { code: string } | null = null;
    try {
      membershipGame = (await requireMembership(prisma, playerId, code)).game;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === "GAME_NOT_FOUND") notFound();
      // UNAUTHENTICATED / FORBIDDEN: cookie чужая или из другой комнаты —
      // предлагаем войти по коду.
    }
    if (membershipGame !== null) {
      const state = await getGameState(membershipGame.code, playerId);
      return <GameRoom code={membershipGame.code} initialState={state} />;
    }
  } else {
    // Без cookie нельзя раскрывать существование комнаты: неизвестный код
    // должен быть неотличим от отсутствия доступа.
    const game = await prisma.game.findUnique({
      where: { code: normalizedCode },
      select: { code: true },
    });
    if (game === null) notFound();
  }

  return <GameRoomJoin code={normalizedCode} />;
}
