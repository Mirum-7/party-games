import "server-only";

import type { GameResult } from "@/generated/prisma/client";
import type { TransactionClient } from "@/server/db";

// Общие операции с результатами GameResult для команд игровых модулей.
// Все функции выполняются внутри транзакции команды после блокировки строки
// Game; смысл place/score определяет игровой модуль, Core предоставляет
// типовую запись и чтение без игровой семантики и без импорта конкретных игр.

export async function findPlayerResult(
  tx: TransactionClient,
  gameId: string,
  playerId: string,
): Promise<GameResult | null> {
  return tx.gameResult.findFirst({ where: { gameId, playerId } });
}

export async function countPlacedResults(tx: TransactionClient, gameId: string): Promise<number> {
  return tx.gameResult.count({ where: { gameId, place: { not: null } } });
}

// Запись результата угадавшего участника с серверным временем.
export async function recordPlacedResult(
  tx: TransactionClient,
  input: {
    gameId: string;
    playerId: string;
    place: number;
    score: number;
    finishedAt: Date;
  },
): Promise<GameResult> {
  return tx.gameResult.create({ data: input });
}

// Нулевые результаты для участников без результата (досрочное завершение):
// place/score/finishedAt остаются null/0/null. Существующие записи не
// изменяются. Возвращает число созданных строк.
export async function recordMissingZeroResults(
  tx: TransactionClient,
  gameId: string,
  playerIds: readonly string[],
): Promise<number> {
  if (playerIds.length === 0) return 0;
  const created = await tx.gameResult.createMany({
    data: playerIds.map((playerId) => ({
      gameId,
      playerId,
      place: null,
      score: 0,
      finishedAt: null,
    })),
  });
  return created.count;
}

export async function findResultPlayerIds(
  tx: TransactionClient,
  gameId: string,
): Promise<string[]> {
  const rows = await tx.gameResult.findMany({
    where: { gameId },
    select: { playerId: true },
  });
  return rows.map((row) => row.playerId);
}
