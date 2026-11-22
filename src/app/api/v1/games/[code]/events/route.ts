import { webCookies } from "iron-session";

import { requireMembership } from "@/server/core/auth/auth";
import { getOptionalPlayerId } from "@/server/core/auth/session";
import { getProcessGameRealtime } from "@/server/core/realtime/in-memory";
import { createGameEventsResponse } from "@/server/core/realtime/sse";
import { prisma } from "@/server/db";
import { handleApi } from "@/server/http/errors";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

// SSE переносит только метаданные синхронизации: номера ревизий. Членство
// проверяется до открытия потока; до открытия ошибки остаются обычными
// JSON-ответами через handleApi (Cache-Control: no-store сохраняется).
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { code } = await context.params;
  return handleApi(
    async () => {
      const playerId = await getOptionalPlayerId(webCookies(request, new Headers()));
      const { game } = await requireMembership(prisma, playerId, code);

      return createGameEventsResponse({
        gameId: game.id,
        realtime: getProcessGameRealtime(),
        signal: request.signal,
        getCurrentRevision: async () => {
          const current = await prisma.game.findUnique({
            where: { id: game.id },
            select: { revision: true },
          });
          // Комната удалена (последний игрок вышел): закрываем соединение,
          // клиент переподключится и получит ошибку членства обычным JSON.
          if (current === null) throw new Error("Game not found");
          return current.revision;
        },
      });
    },
    { setCacheControl: false },
  );
}
