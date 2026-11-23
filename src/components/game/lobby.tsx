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
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type {
  GameStateResponse,
  PlayerSummary,
  UpdateSettingsRequest,
} from "@/shared/contracts/game";

// Узкий контракт для интеграции с GameRoom: индикатор соединения и баннер
// ошибок рисует оболочка GameRoomView; здесь только действия лобби.
export type LobbyProps = {
  state: GameStateResponse;
  mutationPending: boolean;
  onToggleReady: (ready: boolean) => Promise<void>;
  onUpdateSettings: (settings: UpdateSettingsRequest) => Promise<void>;
  onStart: () => Promise<void>;
  onRemove: (playerId: string) => Promise<void>;
  onLeave: () => Promise<void>;
};

// Границы 3..12 — постоянные игровые инварианты WORD_CHAIN.
export function getStartBlockReason(players: readonly PlayerSummary[]): string | null {
  if (players.length < 3) return "Для старта нужно минимум 3 участника";
  if (players.length > 12) return "Для старта допускается максимум 12 участников";
  if (!players.every((player) => player.isReady)) return "Не все участники готовы";
  return null;
}

function inviteText(code: string): string {
  return `Присоединяйся к игре Words Game! Код комнаты: ${code}`;
}

function InviteShareButton({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false);
  const [copyFailed, setCopyFailed] = React.useState(false);

  async function handleShare() {
    setCopyFailed(false);
    const text = inviteText(code);
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Words Game", text });
        return;
      } catch {
        // Пользователь закрыл шеринг или он недоступен — fallback на буфер.
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <>
      <Button type="button" variant="secondary" onClick={handleShare} className="min-h-11 w-full">
        {copied ? "Скопировано" : "Скопировать приглашение"}
      </Button>
      {copyFailed ? (
        <p role="alert" className="text-sm text-destructive">
          Не удалось скопировать приглашение. Скопируйте текст вручную.
        </p>
      ) : null}
    </>
  );
}

type ConfirmProps = {
  title: string;
  description: string;
  actionLabel: string;
  triggerLabel: string;
  triggerVariant?: "outline" | "ghost";
  disabled?: boolean;
  onAction: () => Promise<void>;
};

function ConfirmDialog({
  title,
  description,
  actionLabel,
  triggerLabel,
  triggerVariant = "outline",
  disabled,
  onAction,
}: ConfirmProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        disabled={disabled}
        className={cn(buttonVariants({ variant: triggerVariant }), "min-h-11 w-full")}
      >
        {triggerLabel}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">Отмена</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onAction()} className="min-h-11">
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function Lobby({
  state,
  mutationPending,
  onToggleReady,
  onUpdateSettings,
  onStart,
  onRemove,
  onLeave,
}: LobbyProps) {
  const { game, players, viewer, capabilities } = state;
  const viewerPlayer = players.find((player) => player.id === viewer.playerId) ?? null;
  const startBlockReason = getStartBlockReason(players);
  const canStart = capabilities.canStart && startBlockReason === null;
  // Кнопку запуска и причину недоступности видит админ в лобби: даже когда
  // старт невозможен, причина обязана быть видимой. Сервер повторяет все
  // проверки при POST /start, показ контрола ничего не разрешает.
  const showStartControls = capabilities.canStart || capabilities.canEditSettings;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Лобби</h1>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Код комнаты</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-center font-mono text-3xl font-bold tracking-[0.3em]">{game.code}</p>
          <p className="text-sm text-muted-foreground">{inviteText(game.code)}</p>
          <InviteShareButton code={game.code} />
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
                  <span className="min-w-0 flex-1 truncate font-medium">{player.name}</span>
                  {player.isHost ? <Badge variant="secondary">Хост</Badge> : null}
                  {player.hasSubmittedWord ? <Badge variant="secondary">Слово загадано</Badge> : null}
                  {player.hasGuessed ? <Badge variant="secondary">Угадал</Badge> : null}
                  {player.isReady ? (
                    <Badge variant="default">Готов</Badge>
                  ) : (
                    <Badge variant="outline">Не готов</Badge>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="ready-switch" className="flex min-h-11 flex-1 items-center">
          Готовность{viewerPlayer ? `: ${viewerPlayer.name}` : ""}
        </Label>
        <Switch
          id="ready-switch"
          checked={viewerPlayer?.isReady ?? false}
          disabled={mutationPending || !viewerPlayer}
          onCheckedChange={(checked) => void onToggleReady(checked)}
          className="h-7 w-14"
        />
      </div>

      {capabilities.canEditSettings ? (
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="hide-targets-switch" className="flex min-h-11 flex-1 items-center">
            Скрывать имена адресатов до старта
          </Label>
          <Switch
            id="hide-targets-switch"
            checked={game.settings.hideTargetNamesDuringSetup}
            disabled={mutationPending}
            onCheckedChange={(checked) => void onUpdateSettings({ hideTargetNamesDuringSetup: checked })}
            className="h-7 w-14"
          />
        </div>
      ) : null}

      <Separator />

      {showStartControls ? (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            disabled={mutationPending || !canStart}
            aria-describedby={startBlockReason !== null ? "start-block-reason" : undefined}
            onClick={() => void onStart()}
            className="min-h-11 w-full"
          >
            Начать игру
          </Button>
          {startBlockReason !== null ? (
            <p id="start-block-reason" className="text-sm text-muted-foreground">
              {startBlockReason}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {capabilities.canManagePlayers
          ? players
              .filter((player) => player.id !== viewer.playerId)
              .map((player) => (
                <ConfirmDialog
                  key={player.id}
                  triggerLabel={`Удалить ${player.name}`}
                  title={`Удалить ${player.name}?`}
                  description="Игрок будет исключён из комнаты. Это действие нельзя отменить."
                  actionLabel="Удалить"
                  disabled={mutationPending}
                  onAction={() => onRemove(player.id)}
                />
              ))
          : null}
        <ConfirmDialog
          triggerLabel="Выйти из игры"
          triggerVariant="ghost"
          title="Выйти из игры?"
          description="Вы покинете комнату и вернётесь на главную страницу."
          actionLabel="Выйти"
          disabled={mutationPending || !capabilities.canLeave}
          onAction={onLeave}
        />
      </div>
    </div>
  );
}
