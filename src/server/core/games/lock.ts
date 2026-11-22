import { Prisma } from "@/server/db";
import type { TransactionClient } from "@/server/db";

import { GameCommandError } from "./errors";

// Блокировка строки комнаты внутри интерактивной транзакции: все проверки
// членства, прав и фазы выполняются только после этой блокировки.
export async function lockGameByCode(tx: TransactionClient, code: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "games" WHERE "code" = ${code} FOR UPDATE`,
  );
  const row = rows[0];
  if (!row) {
    throw new GameCommandError("GAME_NOT_FOUND", 404, "Комната не найдена");
  }
  return row.id;
}
