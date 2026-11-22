import { writeGuestPlayer } from "@/server/core/auth/session";
import { createGame } from "@/server/core/games/service";
import { createGameSchema } from "@/server/core/games/schemas";
import { getGameDefinition } from "@/server/games/registry";
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

export async function POST(request: Request): Promise<Response> {
  return handleGameApi(async () => {
    limitGameRoute(request, "create", "POST /api/v1/games");
    requireOrigin(request, getAppOrigin());
    const body = await parseJson(request, createGameSchema);

    const definition = getGameDefinition(body.gameType ?? "WORD_CHAIN");
    const created = await createGame({ definition, name: body.name });

    // Cookie сохраняется только после commit создания комнаты.
    const session = createSessionRouteContext(request);
    await writeGuestPlayer(session.jar, created.playerId);
    const state = await getGameState(created.code, created.playerId);
    return applySessionHeaders(jsonResponse(201, state), session.responseHeaders);
  });
}
