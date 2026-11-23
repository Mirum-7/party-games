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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { normalizeWordInput, wordInputError } from "@/components/game/word-chain/helpers";
import type { GameStateResponse } from "@/shared/contracts/game";

// Узкий контракт для будущей интеграции с хуком GameRoom: сервер повторяет все
// проверки, capabilities лишь скрывают контролы, DTO уже персонализирован.
export type WordSetupProps = {
  state: GameStateResponse;
  mutationPending: boolean;
  onSubmitWord: (word: string) => Promise<void>;
  onCancel: () => Promise<void>;
};

export function WordSetup({ state, mutationPending, onSubmitWord, onCancel }: WordSetupProps) {
  const { game, players, viewer, setup, capabilities } = state;
  const savedWord = setup?.word ?? null;
  const [word, setWord] = React.useState(savedWord ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const lastSavedWord = React.useRef(savedWord);

  // Сервер — источник истины сохранённого слова: ответ мутации приходит уже
  // нормализованным, поэтому после сохранения поле синхронизируется с DTO.
  // Пока серверное значение не менялось, введённый локально черновик
  // не затирается.
  React.useEffect(() => {
    if (savedWord !== lastSavedWord.current) {
      lastSavedWord.current = savedWord;
      setWord(savedWord ?? "");
    }
  }, [savedWord]);

  const inputDisabled = mutationPending || !capabilities.canSubmitWord;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inputDisabled) return;
    const validationError = wordInputError(word);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    await onSubmitWord(normalizeWordInput(word));
  }

  const targetName = setup?.target != null && !setup.targetHidden ? setup.target.name : null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          {targetName != null ? `Загадай слово ${targetName}` : "Введи загаданное слово"}
        </h1>
        {setup?.word != null ? <Badge variant="secondary">Слово сохранено</Badge> : null}
      </header>

      {setup?.targetHidden ? (
        <p className="text-sm text-muted-foreground">
          Адресат будет назван после начала угадывания.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Твоё слово</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="word-input">Загаданное слово</Label>
              <Input
                id="word-input"
                name="word"
                autoComplete="off"
                value={word}
                onChange={(event) => setWord(event.target.value)}
                disabled={inputDisabled}
                aria-invalid={error != null}
                aria-describedby={error != null ? "word-input-error" : undefined}
                className="min-h-11"
              />
            </div>
            {error != null ? (
              <p role="alert" id="word-input-error" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button
              type="submit"
              disabled={inputDisabled}
              className="min-h-11 w-full"
            >
              {mutationPending ? "Сохраняем…" : "Сохранить слово"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Участники ({players.length}/{game.maxPlayers})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col">
            {players.map((player, index) => (
              <li key={player.id}>
                {index > 0 ? <Separator /> : null}
                <div className="flex min-h-11 items-center gap-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {player.name}
                    {player.id === viewer.playerId ? " (вы)" : ""}
                  </span>
                  {player.isHost ? <Badge variant="secondary">Хост</Badge> : null}
                  {player.hasSubmittedWord ? (
                    <Badge variant="default">Слово сохранено</Badge>
                  ) : (
                    <Badge variant="outline">Ждём слово</Badge>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {capabilities.canCancel ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={mutationPending}
              className="min-h-11 w-full"
            >
              Отменить попытку
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Отменить попытку?</AlertDialogTitle>
              <AlertDialogDescription>
                Назначения и слова будут удалены, комната вернётся в лобби. Участники
                и настройки сохранятся.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11">Назад</AlertDialogCancel>
              <AlertDialogAction onClick={() => void onCancel()} className="min-h-11">
                Отменить попытку
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
