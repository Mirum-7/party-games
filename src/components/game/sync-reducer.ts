import type { GameStateResponse } from "@/shared/contracts/game";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting";

export type GameSyncState = {
  game: GameStateResponse;
  connectionStatus: ConnectionStatus;
  mutationPending: boolean;
  errorMessage: string | null;
};

export type GameSyncAction =
  | { type: "connecting" }
  | { type: "open" }
  | { type: "disconnected" }
  | { type: "stateReceived"; game: GameStateResponse }
  | { type: "mutationStarted" }
  | { type: "mutationSucceeded"; game: GameStateResponse }
  | { type: "mutationFailed"; message: string }
  | { type: "refreshFailed"; message: string };

export function createGameSyncState(initialGame: GameStateResponse): GameSyncState {
  return {
    game: initialGame,
    connectionStatus: "connecting",
    mutationPending: false,
    errorMessage: null,
  };
}

export function shouldRefreshForRevision(
  currentRevision: number,
  eventRevision: number,
): boolean {
  return eventRevision > currentRevision;
}

export function gameSyncReducer(
  state: GameSyncState,
  action: GameSyncAction,
): GameSyncState {
  switch (action.type) {
    case "connecting":
      return { ...state, connectionStatus: "connecting" };
    case "open":
      return { ...state, connectionStatus: "connected", errorMessage: null };
    case "disconnected":
      return { ...state, connectionStatus: "reconnecting" };
    case "stateReceived":
      if (action.game.game.revision < state.game.game.revision) {
        return state;
      }
      return { ...state, game: action.game };
    case "mutationStarted":
      return { ...state, mutationPending: true, errorMessage: null };
    case "mutationSucceeded":
      if (action.game.game.revision < state.game.game.revision) {
        return { ...state, mutationPending: false, errorMessage: null };
      }
      return {
        ...state,
        game: action.game,
        mutationPending: false,
        errorMessage: null,
      };
    case "mutationFailed":
      return {
        ...state,
        mutationPending: false,
        errorMessage: action.message,
      };
    case "refreshFailed":
      return { ...state, errorMessage: action.message };
  }
}
