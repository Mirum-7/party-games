import "server-only";

import type { TransactionClient } from "@/server/db";

export async function resetWordChainAttempt(
  tx: TransactionClient,
  gameId: string,
): Promise<void> {
  await tx.wordAssignment.deleteMany({ where: { gameId } });
  await tx.gameResult.deleteMany({ where: { gameId } });
  await tx.player.updateMany({ where: { gameId }, data: { isReady: false } });
  await tx.game.update({
    where: { id: gameId },
    data: { status: "LOBBY", startedAt: null, finishedAt: null },
  });
  await tx.wordChainGame.update({
    where: { gameId },
    data: { phase: null, playingStartedAt: null },
  });
}
