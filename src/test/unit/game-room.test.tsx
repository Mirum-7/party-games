import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import {
  GameRoomView,
  type GameRoomViewProps,
} from "@/components/game/game-room";
import type {
  GamePhase,
  GameStateResponse,
} from "@/shared/contracts/game";

// Фокусные SSR-тесты разводки GameRoomView: выбор экрана по фазе, индикатор
// соединения, баннер ошибок мутаций/обновления. Клики, диалоги, форма входа
// и SSE доказываются browser E2E (lobby.e2e.ts, full-cycle.e2e.ts), здесь
// только разметка.

const VIEWER_ID = "p1";

function makeState(phase: GamePhase): GameStateResponse {
  const playing = phase === "PLAYING" || phase === "FINISHED";
  return {
    game: {
      code: "K7Q2MN",
      type: "WORD_CHAIN",
      phase,
      revision: 3,
      minPlayers: 3,
      maxPlayers: 12,
      settings: { hideTargetNamesDuringSetup: false },
      startedAt: phase === "LOBBY" ? null : "2026-11-23T10:00:00.000Z",
      playingStartedAt: playing ? "2026-11-23T10:10:00.000Z" : null,
      finishedAt: phase === "FINISHED" ? "2026-11-23T10:20:00.000Z" : null,
    },
    viewer: { playerId: VIEWER_ID },
    players: [
      { id: "p1", name: "Маша", isHost: true, isReady: true, hasSubmittedWord: true, hasGuessed: phase === "FINISHED" },
      { id: "p2", name: "Петя", isHost: false, isReady: true, hasSubmittedWord: true, hasGuessed: false },
      { id: "p3", name: "Ваня", isHost: false, isReady: true, hasSubmittedWord: true, hasGuessed: false },
    ],
    setup:
      phase === "ASSIGNING_WORDS"
        ? { target: { id: "p2", name: "Петя" }, targetHidden: false, word: "пирамида" }
        : null,
    hints: null,
    results: null,
    capabilities: {
      canEditSettings: phase === "LOBBY",
      canManagePlayers: phase === "LOBBY",
      canStart: phase === "LOBBY",
      canSubmitWord: phase === "ASSIGNING_WORDS",
      canMarkGuessed: phase === "PLAYING",
      canFinish: phase === "PLAYING",
      canCancel: phase === "ASSIGNING_WORDS",
      canLeave: phase === "LOBBY",
    },
  };
}

function makeView(overrides: Partial<GameRoomViewProps> = {}): GameRoomViewProps {
  return {
    game: makeState("LOBBY"),
    connectionStatus: "connecting",
    mutationPending: false,
    errorMessage: null,
    refresh: () => Promise.resolve(),
    onToggleReady: () => Promise.resolve(),
    onUpdateSettings: () => Promise.resolve(),
    onStart: () => Promise.resolve(),
    onRemove: () => Promise.resolve(),
    onLeave: () => Promise.resolve(),
    onSubmitWord: () => Promise.resolve(),
    onCancel: () => Promise.resolve(),
    onGuessed: () => Promise.resolve(),
    onFinish: () => Promise.resolve(),
    ...overrides,
  };
}

describe("GameRoomView", () => {
  test.each(["LOBBY", "ASSIGNING_WORDS", "PLAYING", "FINISHED"] as const)(
    "фаза %s переключает экран и показывает индикатор соединения",
    (phase) => {
      const html = renderToString(
        <GameRoomView {...makeView({ game: makeState(phase), connectionStatus: "connected" })} />,
      );
      expect(html).toContain("Подключено");
      if (phase === "LOBBY") expect(html).toContain("Лобби");
      if (phase === "ASSIGNING_WORDS") expect(html).toContain("Загадай слово Петя");
      if (phase === "PLAYING") expect(html).toContain("Игра идёт");
      if (phase === "FINISHED") expect(html).toContain("Результаты");
    },
  );

  test("ошибка мутации или обновления показана баннером с кнопкой обновления", () => {
    const html = renderToString(
      <GameRoomView {...makeView({ errorMessage: "Не удалось выполнить действие" })} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Не удалось выполнить действие");
    expect(html).toContain("Обновить");
  });

  test("переподключение отражает статус соединения", () => {
    const html = renderToString(
      <GameRoomView {...makeView({ connectionStatus: "reconnecting" })} />,
    );
    expect(html).toContain("Переподключение…");
  });

  test("pending состояние блокирует контролы экрана", () => {
    const html = renderToString(<GameRoomView {...makeView({ mutationPending: true })} />);
    expect(html.match(/disabled=""/gu)?.length).toBeGreaterThan(0);
  });
});
