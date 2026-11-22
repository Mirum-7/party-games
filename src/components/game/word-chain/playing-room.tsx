"use client";

import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Игра идёт</h1>
      </header>

      {hasGuessed ? (
        <Card>
          <CardContent className="pt-6">
            <p className="font-medium">Вы уже угадали своё слово</p>
            <p className="text-sm text-muted-foreground">
              Теперь вы зритель: подсказки остаются доступны, повторно угадать нельзя.
            </p>
          </CardContent>
        </Card>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              disabled={mutationPending || !capabilities.canMarkGuessed}
              className="min-h-11 w-full"
            >
              {mutationPending ? "Отмечаем…" : "Я угадал"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Вы угадали своё слово?</AlertDialogTitle>
              <AlertDialogDescription>
                Место и время зафиксирует сервер. Действие нельзя отменить.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11">Ещё нет</AlertDialogCancel>
              <AlertDialogAction onClick={() => void onGuessed()} className="min-h-11">
                Я угадал
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {capabilities.canFinish ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={mutationPending}
              className="min-h-11 w-full"
            >
              Завершить игру
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Завершить игру досрочно?</AlertDialogTitle>
              <AlertDialogDescription>
                Уже угадавшие сохранят места и очки. Остальные получат 0 очков без места.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11">Продолжить игру</AlertDialogCancel>
              <AlertDialogAction onClick={() => void onFinish()} className="min-h-11">
                Завершить игру
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Подсказки</CardTitle>
        </CardHeader>
        <CardContent>
          <HintList viewerPlayerId={viewer.playerId} hints={hints ?? []} />
        </CardContent>
      </Card>
    </div>
  );
}
