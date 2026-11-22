import { getOptionalPlayerId, writeGuestPlayer } from "@/server/core/auth/session";
import { joinGameSchema } from "@/server/core/games/schemas";
import { joinGame } from "@/server/core/games/service";
import { getProcessGameRealtime } from "@/server/core/realtime/in-memory";
import { getGameDefinitionForCode } from "@/server/games/registry";
import { getGameState } from "@/server/games/state";
import {
  applySessionHeaders,
  createSessionRouteContext,
  getAppOrigin,
  handleGameApi,
  limitGameRoute,
} from "@/server/http/game-handler";
import { jsonResponse } from "@/server/http/errors";
import { parseJson, requireOrigin } from "@/server/http/request";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { code } = await context.params;
  return handleGameApi(async () => {
    limitGameRoute(request, "join", "POST /api/v1/games/{code}/join");
    requireOrigin(request, getAppOrigin());
    const body = await parseJson(request, joinGameSchema);

    const session = createSessionRouteContext(request);
    // Существующий участник по cookie входит как no-op без смены личности.
    const existingPlayerId = await getOptionalPlayerId(session.jar);
    const definition = await getGameDefinitionForCode(code);
    const joined = await joinGame({
      definition,
      code,
      name: body.name,
      playerId: existingPlayerId,
      realtime: getProcessGameRealtime(),
    });

    // Новая cookie только для нового игрока и только после commit входа.
    if (joined.value.isNewPlayer) {
      await writeGuestPlayer(session.jar, joined.value.playerId);
    }
    const state = await getGameState(code, joined.value.playerId);
    return applySessionHeaders(jsonResponse(200, state), session.responseHeaders);
  });
}
