import { readinessSchema } from "@/server/core/games/schemas";
import { setReadiness } from "@/server/core/players/service";
import { getProcessGameRealtime } from "@/server/core/realtime/in-memory";
import { runGameMutation } from "@/server/http/game-handler";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { code } = await context.params;
  return runGameMutation({
    request,
    code,
    rateLimit: { category: "mutation", route: "POST /api/v1/games/{code}/readiness" },
    bodySchema: readinessSchema,
    command: async ({ body, playerId }) => {
      await setReadiness({ code, playerId, ready: body.ready, realtime: getProcessGameRealtime() });
      return playerId;
    },
  });
}
