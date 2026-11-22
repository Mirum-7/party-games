import { wordChainSettingsSchema } from "@/server/core/games/schemas";
import { updateSettings } from "@/server/core/games/service";
import { getProcessGameRealtime } from "@/server/core/realtime/in-memory";
import { getGameDefinitionForCode } from "@/server/games/registry";
import { runGameMutation } from "@/server/http/game-handler";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const { code } = await context.params;
  return runGameMutation({
    request,
    code,
    rateLimit: { category: "mutation", route: "PATCH /api/v1/games/{code}/settings" },
    bodySchema: wordChainSettingsSchema,
    command: async ({ body, playerId }) => {
      const definition = await getGameDefinitionForCode(code);
      await updateSettings({
        definition,
        code,
        playerId,
        settings: body,
        realtime: getProcessGameRealtime(),
      });
      return playerId;
    },
  });
}
