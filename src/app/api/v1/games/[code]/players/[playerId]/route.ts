import { removePlayer } from "@/server/core/players/service";
import { getProcessGameRealtime } from "@/server/core/realtime/in-memory";
import { runGameMutation } from "@/server/http/game-handler";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string; playerId: string }> };

// Удаляемый участник берётся только из path; личность админа — только из
// cookie, тело запроса не принимается.
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { code, playerId: targetPlayerId } = await context.params;
  return runGameMutation({
    request,
    code,
    rateLimit: { category: "mutation", route: "DELETE /api/v1/games/{code}/players/{playerId}" },
    bodySchema: null,
    command: async ({ playerId }) => {
      await removePlayer({
        code,
        actorPlayerId: playerId,
        targetPlayerId,
        realtime: getProcessGameRealtime(),
      });
      return playerId;
    },
  });
}
