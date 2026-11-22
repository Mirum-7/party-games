import { describe, expect, test } from "bun:test";

import type { GameStateResponse } from "@/shared/contracts/game";
import {
  createGameSyncState,
  gameSyncReducer,
  shouldRefreshForRevision,
  type GameSyncState,
} from "@/components/game/sync-reducer";

function makeGameState(revision: number): GameStateResponse {
  return {
    game: {
      code: "K7Q2",
      type: "WORD_CHAIN",
      phase: "PLAYING",
      revision,
      minPlayers: 3,
      maxPlayers: 12,
      settings: { hideTargetNamesDuringSetup: true },
      startedAt: "2026-11-22T10:00:00.000Z",
      playingStartedAt: "2026-11-22T10:05:00.000Z",
      finishedAt: null,
    },
    viewer: { playerId: "player-1" },
    players: [
      {
        id: "player-1",
        name: "Маша",
        isHost: true,
        isReady: true,
        hasSubmittedWord: true,
        hasGuessed: false,
      },
      {
        id: "player-2",
        name: "Петя",
        isHost: false,
        isReady: true,
        hasSubmittedWord: true,
        hasGuessed: true,
      },
      {
        id: "player-3",
        name: "Ваня",
        isHost: false,
        isReady: true,
        hasSubmittedWord: true,
        hasGuessed: false,
      },
    ],
    setup: {
      target: { id: "player-2", name: "Петя" },
      targetHidden: false,
      word: "молния",
    },
    hints: [
      {
        assignmentId: "assignment-1",
        author: { id: "player-3", name: "Ваня" },
        target: { id: "player-1", name: "Маша" },
        word: "компас",
        wordHidden: false,
      },
    ],
    results: [
      {
        playerId: "player-2",
        name: "Петя",
        place: 1,
        score: 3,
        durationMs: 12000,
      },
    ],
    capabilities: {
      canEditSettings: false,
      canManagePlayers: false,
      canStart: false,
      canSubmitWord: false,
      canMarkGuessed: true,
      canFinish: false,
      canCancel: false,
      canLeave: true,
    },
  };
}

describe("createGameSyncState", () => {
  test("формирует начальное состояние из первого DTO", () => {
    const initialGame = makeGameState(4);

    const state = createGameSyncState(initialGame);

    expect(state.game).toBe(initialGame);
    expect(state.connectionStatus).toBe("connecting");
    expect(state.mutationPending).toBe(false);
    expect(state.errorMessage).toBeNull();
  });
});

describe("shouldRefreshForRevision", () => {
  test("возвращает true, только когда ревизия события выше применённой", () => {
    expect(shouldRefreshForRevision(1, 2)).toBe(true);
    expect(shouldRefreshForRevision(7, 7)).toBe(false);
    expect(shouldRefreshForRevision(7, 3)).toBe(false);
  });
});

describe("gameSyncReducer", () => {
  test("connecting переводит статус в connecting, не трогая данные игры", () => {
    const game = makeGameState(1);
    const state: GameSyncState = {
      game,
      connectionStatus: "reconnecting",
      mutationPending: false,
      errorMessage: null,
    };

    const next = gameSyncReducer(state, { type: "connecting" });

    expect(next.connectionStatus).toBe("connecting");
    expect(next.game).toBe(game);
  });

  test("open ставит connected и очищает ошибку соединения", () => {
    const game = makeGameState(1);
    const state: GameSyncState = {
      game,
      connectionStatus: "reconnecting",
      mutationPending: false,
      errorMessage: "Соединение прервано",
    };

    const next = gameSyncReducer(state, { type: "open" });

    expect(next.connectionStatus).toBe("connected");
    expect(next.errorMessage).toBeNull();
    expect(next.game).toBe(game);
  });

  test("disconnected ставит reconnecting и сохраняет данные игроков и игры", () => {
    const game = makeGameState(2);
    const state: GameSyncState = {
      game,
      connectionStatus: "connected",
      mutationPending: false,
      errorMessage: null,
    };

    const next = gameSyncReducer(state, { type: "disconnected" });

    expect(next.connectionStatus).toBe("reconnecting");
    expect(next.game).toBe(game);
    expect(next.game.players).toHaveLength(3);
  });

  test("stateReceived применяет DTO с более высокой ревизией", () => {
    const state = createGameSyncState(makeGameState(3));
    const fresher = makeGameState(5);

    const next = gameSyncReducer(state, { type: "stateReceived", game: fresher });

    expect(next.game).toBe(fresher);
    expect(next.game.game.revision).toBe(5);
    expect(next.connectionStatus).toBe("connecting");
  });

  test("stateReceived применяет DTO с равной ревизией", () => {
    const state = createGameSyncState(makeGameState(5));
    const equal = makeGameState(5);

    const next = gameSyncReducer(state, { type: "stateReceived", game: equal });

    expect(next.game).toBe(equal);
  });

  test("stateReceived отбрасывает DTO с устаревшей ревизией и возвращает тот же объект состояния", () => {
    const state = createGameSyncState(makeGameState(6));
    const stale = makeGameState(4);

    const next = gameSyncReducer(state, { type: "stateReceived", game: stale });

    expect(next).toBe(state);
    expect(next.game.game.revision).toBe(6);
  });

  test("mutationStarted ставит pending и очищает прежнюю ошибку", () => {
    const game = makeGameState(2);
    const state: GameSyncState = {
      game,
      connectionStatus: "connected",
      mutationPending: false,
      errorMessage: "Прежняя ошибка",
    };

    const next = gameSyncReducer(state, { type: "mutationStarted" });

    expect(next.mutationPending).toBe(true);
    expect(next.errorMessage).toBeNull();
    expect(next.game).toBe(game);
  });

  test("mutationSucceeded применяет возвращённый DTO и снимает pending и ошибку", () => {
    const state: GameSyncState = {
      game: makeGameState(2),
      connectionStatus: "connected",
      mutationPending: true,
      errorMessage: "Предыдущий сбой",
    };
    const confirmed = makeGameState(3);

    const next = gameSyncReducer(state, { type: "mutationSucceeded", game: confirmed });

    expect(next.game).toBe(confirmed);
    expect(next.mutationPending).toBe(false);
    expect(next.errorMessage).toBeNull();
  });

  test("mutationSucceeded отбрасывает устаревший DTO и возвращает тот же объект состояния", () => {
    const state: GameSyncState = {
      game: makeGameState(5),
      connectionStatus: "connected",
      mutationPending: true,
      errorMessage: null,
    };
    const stale = makeGameState(4);

    const next = gameSyncReducer(state, { type: "mutationSucceeded", game: stale });

    expect(next).toBe(state);
    expect(next.mutationPending).toBe(true);
    expect(next.game.game.revision).toBe(5);
  });

  test("mutationFailed снимает pending, сохраняет последнее удачное состояние и сообщает ошибку", () => {
    const game = makeGameState(5);
    const state: GameSyncState = {
      game,
      connectionStatus: "connected",
      mutationPending: true,
      errorMessage: null,
    };

    const next = gameSyncReducer(state, {
      type: "mutationFailed",
      message: "Не удалось применить действие",
    });

    expect(next.mutationPending).toBe(false);
    expect(next.errorMessage).toBe("Не удалось применить действие");
    expect(next.game).toBe(game);
  });

  test("refreshFailed сохраняет последнее удачное состояние и показывает переданное сообщение", () => {
    const game = makeGameState(5);
    const state: GameSyncState = {
      game,
      connectionStatus: "connected",
      mutationPending: false,
      errorMessage: null,
    };
    const message = "Не удалось обновить состояние игры. Попробуйте ещё раз.";

    const next = gameSyncReducer(state, { type: "refreshFailed", message });

    expect(next.game).toBe(game);
    expect(next.errorMessage).toBe(message);
    expect(next.connectionStatus).toBe("connected");
  });
});
