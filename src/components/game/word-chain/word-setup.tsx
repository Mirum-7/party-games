"use client";

import * as React from "react";

import { Check } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/game/confirm-dialog";
import { PlayerRow } from "@/components/game/player-row";
import {
  MAX_WORD_LENGTH,
  normalizeWordInput,
  wordInputError,
} from "@/components/game/word-chain/helpers";
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
  const submittedCount = players.filter((player) => player.hasSubmittedWord).length;
  const lengthHint = `От 1 до ${MAX_WORD_LENGTH} символов. Слово можно изменить до начала игры.`;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          {targetName != null
            ? `Загадайте слово для игрока: ${targetName}`
            : "Введите загаданное слово"}
        </h1>
        <Badge variant="secondary">{`Слова сохранены: ${submittedCount} из ${players.length}`}</Badge>
      </header>

      {setup?.targetHidden ? (
        <p className="text-sm text-muted-foreground">
          Адресат будет назван после начала угадывания.
        </p>
      ) : null}

      <Card className="gap-4 py-4">
        <CardHeader className="gap-0">
          <CardTitle className="text-base">Ваше слово</CardTitle>
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
                aria-describedby={`word-input-hint${error != null ? " word-input-error" : ""}`}
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
            <p id="word-input-hint" className="text-sm text-muted-foreground">
              {lengthHint}
            </p>
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
          <ul className="flex flex-col">
            {players.map((player) => (
              <PlayerRow
                key={player.id}
                player={player}
                isViewer={player.id === viewer.playerId}
                status={
                  player.hasSubmittedWord ? (
                    <Badge variant="success">
                      <Check aria-hidden="true" />
                      Слово готово
                    </Badge>
                  ) : (
                    <Badge variant="outline">Ждём слово</Badge>
                  )
                }
              />
            ))}
          </ul>
        </CardContent>
      </Card>

      {capabilities.canCancel ? (
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="outline"
              disabled={mutationPending}
              className="min-h-11 w-full"
            >
              Отменить попытку
            </Button>
          }
          title="Отменить попытку?"
          description="Назначения и слова будут удалены, комната вернётся в лобби. Участники и настройки сохранятся."
          actionLabel="Отменить попытку"
          actionVariant="destructive"
          onAction={onCancel}
        />
      ) : null}
    </div>
  );
}
