"use client";

import * as React from "react";
import { UserMinus } from "lucide-react";

import { ConfirmDialog } from "@/components/game/confirm-dialog";
import { PlayerRow } from "@/components/game/player-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
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

// Обратная связь «Код скопирован» самоисчезает через 2–3 с; cleanup таймера
// в эффекте не даёт setState после размонтирования кнопки.
export const INVITE_COPIED_RESET_MS = 2000;

function InviteShareButton({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false);
  const [copyFailed, setCopyFailed] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), INVITE_COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

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
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <>
      <Button type="button" variant="secondary" onClick={handleShare} className="min-h-11 w-full">
        {copied ? "Код скопирован" : "Скопировать приглашение"}
      </Button>
      {copyFailed ? (
        <p role="alert" className="text-sm text-destructive">
          Не удалось скопировать приглашение. Скопируйте текст вручную.
        </p>
      ) : null}
    </>
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

      <Card className="border-primary/40 bg-primary text-primary-foreground">
        <CardHeader>
          <CardTitle className="text-base">Код комнаты</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-center font-mono text-3xl font-bold tracking-[0.3em]">{game.code}</p>
          <p className="text-sm text-primary-foreground">{inviteText(game.code)}</p>
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
            {players.map((player) => (
              <PlayerRow
                key={player.id}
                player={player}
                isViewer={player.id === viewer.playerId}
                status={
                  <>
                    {player.hasSubmittedWord ? <Badge variant="secondary">Слово загадано</Badge> : null}
                    {player.hasGuessed ? <Badge variant="secondary">Угадал</Badge> : null}
                    {player.isReady ? (
                      <Badge variant="success">Готов</Badge>
                    ) : (
                      <Badge variant="warning">Пока не готов</Badge>
                    )}
                  </>
                }
                action={
                  capabilities.canManagePlayers && player.id !== viewer.playerId ? (
                    <ConfirmDialog
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          className="size-11 shrink-0 text-destructive hover:bg-destructive/10"
                          aria-label={`Удалить участника «${player.name}»`}
                          disabled={mutationPending}
                        >
                          <UserMinus aria-hidden="true" />
                        </Button>
                      }
                      title={`Удалить участника «${player.name}»?`}
                      description="Игрок будет исключён из комнаты. Это действие нельзя отменить."
                      actionLabel="Удалить"
                      actionVariant="destructive"
                      onAction={() => onRemove(player.id)}
                    />
                  ) : undefined
                }
              />
            ))}
          </ol>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          id="ready-button"
          variant={viewerPlayer?.isReady ? "success" : "default"}
          disabled={mutationPending || !viewerPlayer}
          onClick={() => void onToggleReady(!(viewerPlayer?.isReady ?? false))}
          className="min-h-11 w-full"
        >
          {viewerPlayer?.isReady ? "Вы готовы" : "Я готов"}
        </Button>
        {viewerPlayer?.isReady && !viewerPlayer.isHost ? (
          <p className="text-center text-sm text-muted-foreground">Ждём начала игры хостом</p>
        ) : null}
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

      <ConfirmDialog
        trigger={
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 w-full"
            disabled={mutationPending || !capabilities.canLeave}
          >
            Выйти из игры
          </Button>
        }
        title="Выйти из игры?"
        description="Вы покинете комнату и вернётесь на главную страницу."
        actionLabel="Выйти"
        onAction={onLeave}
      />
    </div>
  );
}
