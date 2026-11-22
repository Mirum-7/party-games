import { z } from "zod";

import {
  getGameState,
  sendGameMutation,
  type MutationMethod,
  type SyncFetch,
} from "./api-client";
import {
  createGameSyncState,
  gameSyncReducer,
  shouldRefreshForRevision,
  type GameSyncAction,
  type GameSyncState,
} from "./sync-reducer";
import type { GameStateResponse } from "@/shared/contracts/game";

export const REFRESH_FAILED_MESSAGE =
  "Не удалось обновить состояние игры. Попробуйте ещё раз.";
export const MUTATION_PENDING_MESSAGE = "Действие уже выполняется.";
export const MUTATION_CANCELLED_MESSAGE = "Действие отменено.";

export type EventSourceLike = {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void;
  close(): void;
};

export type CreateEventSource = (url: string) => EventSourceLike;

export type GameSyncControllerOptions = {
  code: string;
  initialState: GameStateResponse;
  fetcher?: SyncFetch;
  createEventSource?: CreateEventSource;
};

const revisionEventSchema = z.object({ revision: z.number() });

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

function defaultCreateEventSource(url: string): EventSourceLike {
  return new EventSource(url);
}

// Контроллер не зависит от React: состояние хранится в редьюсере, внешний мир
// получает его через getSnapshot/subscribe. Все опоздавшие ответы отбрасываются
// по поколению запуска и монотонному номеру запроса; тела ответов и запросы в
// лог не пишутся.
export class GameSyncController {
  private state: GameSyncState;
  private readonly code: string;
  private readonly fetcher?: SyncFetch;
  private readonly createEventSource: CreateEventSource;
  private readonly listeners = new Set<() => void>();

  private eventSource: EventSourceLike | null = null;
  private generation = 0;
  private refreshSeq = 0;
  private refreshAbort: AbortController | null = null;
  private mutationAbort: AbortController | null = null;

  constructor(options: GameSyncControllerOptions) {
    this.code = options.code;
    this.state = createGameSyncState(options.initialState);
    this.fetcher = options.fetcher;
    this.createEventSource = options.createEventSource ?? defaultCreateEventSource;
  }

  getSnapshot(): GameSyncState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.eventSource !== null) return;
    this.generation += 1;
    const generation = this.generation;
    this.dispatch({ type: "connecting" });

    const source = this.createEventSource(
      `/api/v1/games/${encodeURIComponent(this.code)}/events`,
    );
    this.eventSource = source;
    source.onopen = () => {
      if (!this.isCurrent(generation)) return;
      this.dispatch({ type: "open" });
      void this.refresh();
    };
    source.onerror = () => {
      if (!this.isCurrent(generation)) return;
      // Переподключение EventSource автоматическое; игрок не покидает игру.
      this.dispatch({ type: "disconnected" });
    };
    source.addEventListener("game.changed", this.onGameChanged);
  }

  close(): void {
    const source = this.eventSource;
    if (source !== null) {
      this.eventSource = null;
      source.onopen = null;
      source.onerror = null;
      source.removeEventListener("game.changed", this.onGameChanged);
      source.close();
    }
    // Инвалидирует обработчики старого поколения и отменяет поздние ответы.
    this.generation += 1;
    this.refreshAbort?.abort();
    this.mutationAbort?.abort();
    if (this.state.mutationPending) {
      this.dispatch({ type: "mutationFailed", message: MUTATION_CANCELLED_MESSAGE });
    }
  }

  refresh(): Promise<void> {
    const generation = this.generation;
    const seq = ++this.refreshSeq;
    this.refreshAbort?.abort();
    const abort = new AbortController();
    this.refreshAbort = abort;

    return getGameState(this.code, { fetcher: this.fetcher, signal: abort.signal })
      .then((game) => {
        if (!this.isCurrentRefresh(generation, seq)) return;
        this.dispatch({ type: "stateReceived", game });
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        if (!this.isCurrentRefresh(generation, seq)) return;
        this.dispatch({ type: "refreshFailed", message: REFRESH_FAILED_MESSAGE });
      });
  }

  async mutate(method: MutationMethod, path: string, body?: unknown): Promise<void> {
    if (this.state.mutationPending) {
      throw new Error(MUTATION_PENDING_MESSAGE);
    }
    const generation = this.generation;
    this.dispatch({ type: "mutationStarted" });
    const abort = new AbortController();
    this.mutationAbort = abort;

    try {
      const game = await sendGameMutation(this.code, method, path, body, {
        fetcher: this.fetcher,
        signal: abort.signal,
      });
      if (this.generation !== generation) return;
      this.dispatch({ type: "mutationSucceeded", game });
    } catch (error) {
      if (this.generation !== generation) return;
      if (isAbortError(error)) {
        this.dispatch({ type: "mutationFailed", message: MUTATION_CANCELLED_MESSAGE });
        throw error;
      }
      const apiError =
        error instanceof Error
          ? error
          : new Error("Не удалось выполнить действие. Попробуйте ещё раз.");
      this.dispatch({ type: "mutationFailed", message: apiError.message });
      throw error;
    }
  }

  private readonly onGameChanged = (event: { data: unknown }): void => {
    const revision = parseRevisionEvent(event.data);
    if (revision === null) return;
    if (!shouldRefreshForRevision(this.state.game.game.revision, revision)) return;
    void this.refresh();
  };

  private isCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  private isCurrentRefresh(generation: number, seq: number): boolean {
    return this.generation === generation && this.refreshSeq === seq;
  }

  private dispatch(action: GameSyncAction): void {
    const prev = this.state;
    const next = gameSyncReducer(prev, action);
    if (next === prev) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

function parseRevisionEvent(data: unknown): number | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const result = revisionEventSchema.safeParse(parsed);
  return result.success ? result.data.revision : null;
}
