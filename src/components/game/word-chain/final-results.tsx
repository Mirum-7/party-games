"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { HintList } from "@/components/game/word-chain/hint-list";
import { formatDuration } from "@/components/game/word-chain/helpers";
import type { GameStateResponse } from "@/shared/contracts/game";

// Финальный экран: рейтинг карточками (без таблиц и горизонтального скролла —
// укладывается в 360 px) и полное раскрытие назначений ниже. DTO уже отсортирован
// сервером: сначала места по возрастанию, затем не угадавшие.
export type FinalResultsProps = {
  state: GameStateResponse;
};

export function FinalResults({ state }: FinalResultsProps) {
  const { viewer, results, hints } = state;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Результаты</h1>
      </header>

      <ol className="flex flex-col gap-2">
        {(results ?? []).map((item) => (
          <li key={item.playerId}>
            <Card>
              <CardContent className="flex items-center gap-3 py-3">
                {item.place != null ? (
                  <Badge variant="default">{`${item.place} место`}</Badge>
                ) : (
                  <Badge variant="outline">Не угадал</Badge>
                )}
                <span className="min-w-0 flex-1 truncate font-medium">
                  {item.name}
                  {item.playerId === viewer.playerId ? " (вы)" : ""}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                  {item.durationMs != null ? formatDuration(item.durationMs) : "—"}
                </span>
                <span className="shrink-0 text-sm font-medium">{`Очки: ${item.score}`}</span>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>

      {hints != null && hints.length > 0 ? (
        <section aria-labelledby="final-words-title" className="flex flex-col gap-2">
          <h2 id="final-words-title" className="text-base font-semibold">
            Все слова
          </h2>
          <HintList viewerPlayerId={viewer.playerId} hints={hints} />
        </section>
      ) : null}
    </div>
  );
}
