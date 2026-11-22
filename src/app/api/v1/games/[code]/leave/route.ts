import { destroyGuestSession } from "@/server/core/auth/session";
import { leaveGame } from "@/server/core/players/service";
import { getProcessGameRealtime } from "@/server/core/realtime/in-memory";
import {
  applySessionHeaders,
  createSessionRouteContext,
  getAppOrigin,
  handleGameApi,
  limitGameRoute,
  requireCallerPlayerId,
} from "@/server/http/game-handler";
import { requireEmptyBody, requireOrigin } from "@/server/http/request";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { code } = await context.params;
  return handleGameApi(async () => {
    limitGameRoute(request, "mutation", "POST /api/v1/games/{code}/leave");
    requireOrigin(request, getAppOrigin());
    await requireEmptyBody(request);

    const session = createSessionRouteContext(request);
    const playerId = await requireCallerPlayerId(session.jar);
    await leaveGame({ code, playerId, realtime: getProcessGameRealtime() });

    // Сессия уничтожается только после успешного выхода.
    await destroyGuestSession(session.jar);
    return applySessionHeaders(new Response(null, { status: 204 }), session.responseHeaders);
  });
}
