"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ApiClientError, joinGame, leaveGame } from "@/components/game/api-client";
import { ConnectionIndicator } from "@/components/game/connection-indicator";
import { JoinForm, normalizeInviteCode } from "@/components/game/join-form";
import { Lobby } from "@/components/game/lobby";
import type { ConnectionStatus } from "@/components/game/sync-reducer";
import { useGameState } from "@/components/game/use-game-state";
import { FinalResults } from "@/components/game/word-chain/final-results";
import { PlayingRoom } from "@/components/game/word-chain/playing-room";
import { WordSetup } from "@/components/game/word-chain/word-setup";
import { Button } from "@/components/ui/button";
import type { GameStateResponse, UpdateSettingsRequest } from "@/shared/contracts/game";

// Общий баннер комнаты: свежая ошибка выхода важнее застойной ошибки мутации
// или обновления — иначе leave-ошибку маскирует прежний mutationError, и
// пользователь не видит причину отказа выхода.
export function roomErrorMessage(errorMessage: string | null, leaveError: string | null): string | null {
  return leaveError ?? errorMessage;
}

export type GameRoomViewProps = {
  game: GameStateResponse;
  connectionStatus: ConnectionStatus;
  mutationPending: boolean;
  // Общая ошибка мутации или обновления состояния; null скрывает баннер.
  errorMessage: string | null;
  refresh: () => Promise<void>;
  onToggleReady: (ready: boolean) => Promise<void>;
  onUpdateSettings: (settings: UpdateSettingsRequest) => Promise<void>;
  onStart: () => Promise<void>;
  onRemove: (playerId: string) => Promise<void>;
  onLeave: () => Promise<void>;
  onRestart: () => Promise<void>;
  onSubmitWord: (word: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onGuessed: () => Promise<void>;
  onFinish: () => Promise<void>;
};

// Презентационная оболочка: индикатор соединения и баннер ошибок общие для
// всех фаз, экран выбирается по фазе персонального DTO.
export function GameRoomView({
  game,
  connectionStatus,
  mutationPending,
  errorMessage,
  refresh,
  onToggleReady,
  onUpdateSettings,
  onStart,
  onRemove,
  onLeave,
  onRestart,
  onSubmitWord,
  onCancel,
  onGuessed,
  onFinish,
}: GameRoomViewProps) {
  let screen: React.ReactNode;
  switch (game.game.phase) {
    case "LOBBY":
      screen = (
        <Lobby
          state={game}
          mutationPending={mutationPending}
          onToggleReady={onToggleReady}
          onUpdateSettings={onUpdateSettings}
          onStart={onStart}
          onRemove={onRemove}
          onLeave={onLeave}
        />
      );
      break;
    case "ASSIGNING_WORDS":
      screen = (
        <WordSetup
          state={game}
          mutationPending={mutationPending}
          onSubmitWord={onSubmitWord}
          onCancel={onCancel}
        />
      );
      break;
    case "PLAYING":
      screen = (
        <PlayingRoom
          state={game}
          mutationPending={mutationPending}
          onGuessed={onGuessed}
          onFinish={onFinish}
        />
      );
      break;
    case "FINISHED":
      screen = (
        <FinalResults
          state={game}
          mutationPending={mutationPending}
          onRestart={onRestart}
          onLeave={onLeave}
        />
      );
      break;
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 p-4">
      <div className="flex items-center justify-end">
        <ConnectionIndicator status={connectionStatus} />
      </div>
      {errorMessage !== null ? (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3"
        >
          <p className="min-w-0 flex-1 text-sm">{errorMessage}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void refresh()}
          >
            Обновить
          </Button>
        </div>
      ) : null}
      {screen}
    </main>
  );
}

export type GameRoomProps = {
  code: string;
  initialState: GameStateResponse;
};

// Связка useGameState с экранами: все действия — серверные мутации по
// зафиксированным путям API; capabilities из DTO лишь скрывают контролы.
export function GameRoom({ code, initialState }: GameRoomProps) {
  const router = useRouter();
  const { game, connectionStatus, mutationPending, errorMessage, refresh, mutate } = useGameState(
    code,
    initialState,
  );
  const [leaveError, setLeaveError] = React.useState<string | null>(null);
  // Выход идёт через отдельный helper без mutationPending: держим собственный
  // флаг, чтобы блокировать финальные кнопки и защищать повторный запуск.
  const [leavePending, setLeavePending] = React.useState(false);

  // Контроллер уже записал message ошибки в errorMessage; повторный throw
  // превратился бы в unhandled rejection из обработчиков экранов.
  const runGuarded = React.useCallback(async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch {
      // Ошибка уже отражена в баннере.
    }
  }, []);

  const handleToggleReady = React.useCallback(
    (ready: boolean) => runGuarded(() => mutate("POST", "/readiness", { ready })),
    [mutate, runGuarded],
  );
  const handleUpdateSettings = React.useCallback(
    (settings: UpdateSettingsRequest) => runGuarded(() => mutate("PATCH", "/settings", settings)),
    [mutate, runGuarded],
  );
  const handleStart = React.useCallback(
    () => runGuarded(() => mutate("POST", "/start")),
    [mutate, runGuarded],
  );
  const handleRemove = React.useCallback(
    (playerId: string) =>
      runGuarded(() => mutate("DELETE", `/players/${encodeURIComponent(playerId)}`)),
    [mutate, runGuarded],
  );
  const handleSubmitWord = React.useCallback(
    (word: string) => runGuarded(() => mutate("PUT", "/word", { word })),
    [mutate, runGuarded],
  );
  const handleCancel = React.useCallback(
    () => runGuarded(() => mutate("POST", "/cancel")),
    [mutate, runGuarded],
  );
  const handleGuessed = React.useCallback(
    () => runGuarded(() => mutate("POST", "/guessed")),
    [mutate, runGuarded],
  );
  const handleFinish = React.useCallback(
    () => runGuarded(() => mutate("POST", "/finish")),
    [mutate, runGuarded],
  );
  const handleRestart = React.useCallback(
    () => runGuarded(() => mutate("POST", "/restart")),
    [mutate, runGuarded],
  );

  // Выход — единственное действие с ответом 204 без тела: используем
  // специальный хелпер, при успехе уходим на главную. Повторный запуск
  // заблокирован, pending снимается в finally; навигация на `/` — только
  // после успешного 204.
  const handleLeave = React.useCallback(async (): Promise<void> => {
    if (leavePending) return;
    setLeavePending(true);
    try {
      await leaveGame(code);
      setLeaveError(null);
      router.push("/");
    } catch (error) {
      setLeaveError(
        error instanceof ApiClientError
          ? error.message
          : "Не удалось выйти из игры. Попробуйте ещё раз.",
      );
    } finally {
      setLeavePending(false);
    }
  }, [code, leavePending, router]);

  return (
    <GameRoomView
      game={game}
      connectionStatus={connectionStatus}
      mutationPending={mutationPending || leavePending}
      errorMessage={roomErrorMessage(errorMessage, leaveError)}
      refresh={refresh}
      onToggleReady={handleToggleReady}
      onUpdateSettings={handleUpdateSettings}
      onStart={handleStart}
      onRemove={handleRemove}
      onLeave={handleLeave}
      onRestart={handleRestart}
      onSubmitWord={handleSubmitWord}
      onCancel={handleCancel}
      onGuessed={handleGuessed}
      onFinish={handleFinish}
    />
  );
}

// Экран входа для устройства без действительного членства: код комнаты уже
// известен из адреса, имя обязательно. Успешный вход ставит cookie, после
// чего серверный рендер страницы покажет GameRoom.
export function GameRoomJoin({ code }: { code: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function handleJoin(name: string, enteredCode: string): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      const normalized = normalizeInviteCode(enteredCode);
      await joinGame(normalized, name);
      if (normalized !== code) {
        router.push(`/game/${encodeURIComponent(normalized)}`);
      }
      router.refresh();
    } finally {
      // Ошибку показывает JoinForm: проброс нужен, чтобы catch формы сработал.
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Words Game</h1>
        <p className="text-muted-foreground">Введите имя, чтобы присоединиться к комнате {code}.</p>
      </div>
      <JoinForm onJoin={handleJoin} pending={pending} initialCode={code} />
    </main>
  );
}
