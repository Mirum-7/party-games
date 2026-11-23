"use client";

import { Star, Trophy } from "lucide-react";
import { cn } from "cn";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/game/confirm-dialog";
import { HintList } from "@/components/game/word-chain/hint-list";
import { formatDuration } from "@/components/game/word-chain/helpers";
import type { GameStateResponse } from "@/shared/contracts/game";

// Финальный экран сверху вниз: «Игра завершена», выделение победителя, действия
// нового раунда/выхода, компактный рейтинг и полное раскрытие назначений ниже.
// DTO уже отсортирован сервером: сначала места по возрастанию, затем не
// угадавшие; порядок строк не меняется. Копия подтверждений живёт в диалогах
// Radix AlertDialog: в SSR она не рендерится, поэтому проверяется в E2E.
export type FinalResultsProps = {
  state: GameStateResponse;
  mutationPending: boolean;
  onRestart: () => Promise<void>;
  onLeave: () => Promise<void>;
};

const PLACE_BADGE_CLASS: Record<number, string> = {
  1: "bg-amber-100 text-amber-800 dark:bg-amber-400/20 dark:text-amber-200",
  2: "bg-slate-200 text-slate-700 dark:bg-slate-400/20 dark:text-slate-200",
  3: "bg-orange-100 text-orange-800 dark:bg-orange-400/20 dark:text-orange-200",
};

export function FinalResults({
  state,
  mutationPending,
  onRestart,
  onLeave,
}: FinalResultsProps) {
  const { viewer, results, hints, capabilities } = state;
  const winner = results?.find((item) => item.place === 1) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Игра завершена</h1>
      </header>

      {winner != null ? (
        <Card className="border-amber-300/60 bg-amber-50 py-0 dark:bg-amber-400/10">
          <CardContent className="flex items-center gap-3 py-3">
            <Trophy
              aria-hidden="true"
              className="size-5 shrink-0 text-amber-600 dark:text-amber-400"
            />
            <p className="min-w-0">
              <span className="block text-xs text-muted-foreground">Победитель</span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                <span className="truncate font-semibold">{winner.name}</span>
                {winner.playerId === viewer.playerId ? (
                  <Badge variant="outline">Вы</Badge>
                ) : null}
              </span>
            </p>
          </CardContent>
        </Card>
      ) : null}

      <section aria-label="Действия после финала" className="flex flex-col gap-2">
        {capabilities.canRestart ? (
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                disabled={mutationPending}
                className="min-h-11 w-full"
              >
                {mutationPending ? "Возвращаем в лобби…" : "Сыграть ещё с этим составом"}
              </Button>
            }
            title="Новый раунд с этим составом?"
            description="Слова и результаты этого раунда будут удалены. Участники, код комнаты и настройки сохранятся."
            actionLabel="Сыграть ещё с этим составом"
            onAction={onRestart}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Хост может вернуть всех в лобби для нового раунда.
          </p>
        )}
        {capabilities.canLeave ? (
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                variant="outline"
                disabled={mutationPending}
                className="min-h-11 w-full"
              >
                В главное меню
              </Button>
            }
            title="Выйти в главное меню?"
            description="Вы покинете комнату. Остальные участники вернутся в лобби, а результаты этого раунда будут очищены."
            actionLabel="В главное меню"
            actionVariant="destructive"
            onAction={onLeave}
          />
        ) : null}
      </section>

      <section aria-labelledby="final-results-title" className="flex flex-col gap-2">
        <h2 id="final-results-title" className="text-base font-semibold">
          Результаты
        </h2>
        <ol className="flex flex-col gap-2">
          {(results ?? []).map((item) => {
            const isViewer = item.playerId === viewer.playerId;
            return (
              <li
                key={item.playerId}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-md border px-3 py-2",
                  isViewer && "border-primary",
                )}
              >
                {item.place != null ? (
                  <Badge
                    variant="default"
                    className={PLACE_BADGE_CLASS[item.place]}
                  >{`${item.place} место`}</Badge>
                ) : (
                  <Badge variant="outline">Не угадал</Badge>
                )}
                <span className="min-w-0 flex-1 truncate font-medium">
                  {item.name}
                  {isViewer ? (
                    <Badge variant="outline" className="ml-1.5">
                      Вы
                    </Badge>
                  ) : null}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                  {item.durationMs != null ? formatDuration(item.durationMs) : "—"}
                </span>
                <span
                  className="inline-flex shrink-0 items-center gap-1 text-sm font-medium"
                  aria-label={`Очки: ${item.score}`}
                >
                  <Star aria-hidden="true" className="size-3.5 text-amber-500" />
                  {item.score}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      {hints != null && hints.length > 0 ? (
        <section aria-labelledby="final-words-title" className="flex flex-col gap-2">
          <h2 id="final-words-title" className="text-base font-semibold">
            Все слова
          </h2>
          <HintList viewerPlayerId={viewer.playerId} hints={hints} prioritizeViewer={false} />
        </section>
      ) : null}
    </div>
  );
}
