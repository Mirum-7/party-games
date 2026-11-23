"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/game/confirm-dialog";
import { HintList } from "@/components/game/word-chain/hint-list";
import type { GameStateResponse } from "@/shared/contracts/game";

// Узкий контракт для будущей интеграции с хуком GameRoom: сервер фиксирует
// первое угадывание и повторяет проверку прав на досрочное завершение.
export type PlayingRoomProps = {
  state: GameStateResponse;
  mutationPending: boolean;
  onGuessed: () => Promise<void>;
  onFinish: () => Promise<void>;
};

export function PlayingRoom({ state, mutationPending, onGuessed, onFinish }: PlayingRoomProps) {
  const { players, viewer, hints, capabilities } = state;
  const viewerPlayer = players.find((player) => player.id === viewer.playerId) ?? null;
  const hasGuessed = viewerPlayer?.hasGuessed ?? false;
  const guessedCount = players.filter((player) => player.hasGuessed).length;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Игра идёт</h1>
        <Badge variant="secondary">{`Угадали ${guessedCount} из ${players.length}`}</Badge>
      </header>

      {hasGuessed ? (
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <Badge variant="success" className="w-fit">Вы угадали</Badge>
            <p className="text-sm text-muted-foreground">
              Теперь вы зритель: подсказки остаются доступны, повторно угадать нельзя.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="success"
              disabled={mutationPending || !capabilities.canMarkGuessed}
              className="min-h-11 w-full"
            >
              {mutationPending ? "Отмечаем…" : "Я угадал"}
            </Button>
          }
          title="Вы угадали своё слово?"
          description="Место и время зафиксирует сервер. Действие нельзя отменить."
          actionLabel="Я угадал"
          actionVariant="success"
          onAction={onGuessed}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Подсказки</CardTitle>
        </CardHeader>
        <CardContent>
          <HintList
            viewerPlayerId={viewer.playerId}
            hints={hints ?? []}
            prioritizeViewer
          />
        </CardContent>
      </Card>

      {capabilities.canFinish ? (
        <section
          aria-label="Действия хоста"
          className="flex flex-col gap-2 rounded-md border border-destructive/30 p-3"
        >
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                variant="outline"
                disabled={mutationPending}
                className="min-h-11 w-full"
              >
                Завершить игру
              </Button>
            }
            title="Завершить игру досрочно?"
            description="Уже угадавшие сохранят места и очки. Остальные получат 0 очков без места."
            actionLabel="Завершить игру"
            actionVariant="destructive"
            onAction={onFinish}
          />
        </section>
      ) : null}
    </div>
  );
}
