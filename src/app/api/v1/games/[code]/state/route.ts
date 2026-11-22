import { requireMembership } from "@/server/core/auth/auth";
import { getGameState } from "@/server/games/state";
import { prisma } from "@/server/db";
import { createSessionRouteContext, handleGameApi, requireCallerPlayerId } from "@/server/http/game-handler";
import { jsonResponse } from "@/server/http/errors";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { code } = await context.params;
  return handleGameApi(async () => {
    const session = createSessionRouteContext(request);
    const playerId = await requireCallerPlayerId(session.jar);
    await requireMembership(prisma, playerId, code);
    const state = await getGameState(code, playerId);
    return jsonResponse(200, state);
  });
}
