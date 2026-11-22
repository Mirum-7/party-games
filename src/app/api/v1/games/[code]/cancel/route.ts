import { getProcessGameRealtime } from "@/server/core/realtime/in-memory";
import { cancelWordChain } from "@/server/games/registry";
import { runGameMutation } from "@/server/http/game-handler";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { code } = await context.params;
  return runGameMutation({
    request,
    code,
    rateLimit: { category: "mutation", route: "POST /api/v1/games/{code}/cancel" },
    bodySchema: null,
    command: async ({ playerId }) => {
      await cancelWordChain({ code, playerId, realtime: getProcessGameRealtime() });
      return playerId;
    },
  });
}
