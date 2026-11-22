import { getProcessGameRealtime } from "@/server/core/realtime/in-memory";
import { submitWord } from "@/server/games/registry";
import { submitWordSchema } from "@/server/games/word-chain/schemas";
import { runGameMutation } from "@/server/http/game-handler";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const { code } = await context.params;
  return runGameMutation({
    request,
    code,
    rateLimit: { category: "mutation", route: "PUT /api/v1/games/{code}/word" },
    bodySchema: submitWordSchema,
    command: async ({ body, playerId }) => {
      await submitWord({ code, playerId, word: body.word, realtime: getProcessGameRealtime() });
      return playerId;
    },
  });
}
