import { describe, expect, test } from "bun:test";

import { ApiClientError, type SyncFetch } from "@/components/game/api-client";
import {
  GameSyncController,
  MUTATION_CANCELLED_MESSAGE,
  MUTATION_PENDING_MESSAGE,
  REFRESH_FAILED_MESSAGE,
  type EventSourceLike,
} from "@/components/game/sync-controller";
import type { GameStateResponse } from "@/shared/contracts/game";

const STATE_URL = "/api/v1/games/k7q2/state";
const EVENTS_URL = "/api/v1/games/k7q2/events";

type FetchCall = { input: string; init?: RequestInit };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Пропускает микрозадачи: контроллер применяет ответы асинхронно.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createFakeFetch() {
  const calls: FetchCall[] = [];
  const pending: Array<{ deferred: Deferred<Response>; call: FetchCall }> = [];
  const fetcher: SyncFetch = (input, init) => {
    const call: FetchCall = { input, init };
    calls.push(call);
    const d = deferred<Response>();
    pending.push({ deferred: d, call });
    return d.promise;
  };
  return {
    calls,
    fetcher,
    nextPending(): { deferred: Deferred<Response>; call: FetchCall } {
      const entry = pending.shift();
      if (!entry) throw new Error("ожидался fetch-запрос");
      return entry;
    },
    pendingCount(): number {
      return pending.length;
    },
  };
}

type FakeFetch = ReturnType<typeof createFakeFetch>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FakeEventSource = EventSourceLike & {
  url: string;
  closed: boolean;
  emitOpen(): void;
  emitError(): void;
  emitGameChanged(data: string): void;
  listenerCount(type: string): number;
};

function createFakeEventSourceFactory() {
  const created: FakeEventSource[] = [];
  const factory = (url: string): FakeEventSource => {
    const listeners = new Map<string, Set<(event: { data: unknown }) => void>>();
    const source: FakeEventSource = {
      url,
      closed: false,
      onopen: null,
      onerror: null,
      addEventListener(type, listener) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      close() {
        source.closed = true;
      },
      emitOpen() {
        source.onopen?.(new Event("open"));
      },
      emitError() {
        source.onerror?.(new Event("error"));
      },
      emitGameChanged(data: string) {
        for (const listener of listeners.get("game.changed") ?? []) listener({ data });
      },
      listenerCount(type: string) {
        return listeners.get(type)?.size ?? 0;
      },
    };
    created.push(source);
    return source;
  };
  return { factory, created };
}

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
    ],
    setup: null,
    hints: null,
    results: null,
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

function setup(options?: { initialRevision?: number }) {
  const fetchMock = createFakeFetch();
  const eventSources = createFakeEventSourceFactory();
  const controller = new GameSyncController({
    code: "k7q2",
    initialState: makeGameState(options?.initialRevision ?? 1),
    fetcher: fetchMock.fetcher,
    createEventSource: eventSources.factory,
  });
  return { controller, fetchMock, eventSources };
}

function stateCalls(fetchMock: FakeFetch): FetchCall[] {
  return fetchMock.calls.filter((call) => call.input === STATE_URL);
}

describe("GameSyncController", () => {
  test("начальное состояние — connecting без запросов до start", () => {
    const { controller, fetchMock, eventSources } = setup();

    expect(controller.getSnapshot().connectionStatus).toBe("connecting");
    expect(controller.getSnapshot().game.game.revision).toBe(1);
    expect(fetchMock.calls).toHaveLength(0);
    expect(eventSources.created).toHaveLength(0);
  });

  test("start открывает EventSource на /events; open подключает и запрашивает полный state", async () => {
    const { controller, fetchMock, eventSources } = setup();

    controller.start();
    const source = eventSources.created[0]!;
    expect(source.url).toBe(EVENTS_URL);
    expect(source.closed).toBe(false);
    expect(controller.getSnapshot().connectionStatus).toBe("connecting");
    expect(stateCalls(fetchMock)).toHaveLength(0);

    source.emitOpen();
    expect(controller.getSnapshot().connectionStatus).toBe("connected");
    expect(stateCalls(fetchMock)).toHaveLength(1);

    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(2)));
    await flush();
    expect(controller.getSnapshot().game.game.revision).toBe(2);
  });

  test("каждый open, включая reconnect, выполняет полный запрос state", async () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;

    source.emitOpen();
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(2)));
    await flush();

    source.emitError();
    expect(controller.getSnapshot().connectionStatus).toBe("reconnecting");

    source.emitOpen();
    expect(controller.getSnapshot().connectionStatus).toBe("connected");
    expect(stateCalls(fetchMock)).toHaveLength(2);
    expect(fetchMock.pendingCount()).toBe(1);
  });

  test("game.changed с большей ревизией инициирует refresh, равная/меньшая — нет", async () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;
    source.emitOpen();
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(5)));
    await flush();

    source.emitGameChanged(JSON.stringify({ revision: 6 }));
    expect(stateCalls(fetchMock)).toHaveLength(2);
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(6)));
    await flush();

    source.emitGameChanged(JSON.stringify({ revision: 6 }));
    source.emitGameChanged(JSON.stringify({ revision: 4 }));
    expect(stateCalls(fetchMock)).toHaveLength(2);
    expect(fetchMock.pendingCount()).toBe(0);

    source.emitGameChanged(JSON.stringify({ revision: 7 }));
    expect(stateCalls(fetchMock)).toHaveLength(3);
  });

  test("game.changed с повреждёнными данными игнорируется без запроса и без ошибки", () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;
    source.emitOpen();
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(5)));

    source.emitGameChanged("не-json");
    source.emitGameChanged(JSON.stringify({ rev: 9 }));
    source.emitGameChanged(JSON.stringify({ revision: "9" }));
    source.emitGameChanged(JSON.stringify(null));

    expect(stateCalls(fetchMock)).toHaveLength(1);
    expect(controller.getSnapshot().errorMessage).toBeNull();
  });

  test("ошибка EventSource ставит reconnecting, сохраняет игроков и не покидает игру", () => {
    const { controller, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;
    const initialGame = controller.getSnapshot().game;

    source.emitError();

    const snapshot = controller.getSnapshot();
    expect(snapshot.connectionStatus).toBe("reconnecting");
    expect(snapshot.game).toBe(initialGame);
    expect(snapshot.game.players).toHaveLength(1);
  });

  test("сбой refresh сохраняет последнее удачное состояние и ставит общую русскую ошибку", async () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;
    source.emitOpen();
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(3)));
    await flush();

    source.emitGameChanged(JSON.stringify({ revision: 4 }));
    fetchMock.nextPending().deferred.resolve(new Response("boom", { status: 500 }));
    await flush();

    const snapshot = controller.getSnapshot();
    expect(snapshot.game.game.revision).toBe(3);
    expect(snapshot.errorMessage).toBe(REFRESH_FAILED_MESSAGE);
  });

  test("устаревший ответ предыдущего refresh не перезаписывает более новое состояние", async () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;
    source.emitOpen();
    const first = fetchMock.nextPending();

    source.emitGameChanged(JSON.stringify({ revision: 5 }));
    const second = fetchMock.nextPending();
    expect(first.call.init?.signal?.aborted).toBe(true);

    second.deferred.resolve(jsonResponse(200, makeGameState(5)));
    first.deferred.resolve(jsonResponse(200, makeGameState(4)));
    await flush();

    expect(controller.getSnapshot().game.game.revision).toBe(5);
  });

  test("close во время выполнения refresh отменяет запрос и отбрасывает поздний ответ", async () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;
    source.emitOpen();
    const pending = fetchMock.nextPending();

    const listenerCalls = { count: 0 };
    const unsubscribe = controller.subscribe(() => {
      listenerCalls.count += 1;
    });

    controller.close();
    expect(pending.call.init?.signal?.aborted).toBe(true);
    expect(source.closed).toBe(true);

    const callsAfterClose = listenerCalls.count;
    pending.deferred.resolve(jsonResponse(200, makeGameState(9)));
    source.emitOpen();
    await flush();

    expect(controller.getSnapshot().game.game.revision).toBe(1);
    expect(listenerCalls.count).toBe(callsAfterClose);
    expect(stateCalls(fetchMock)).toHaveLength(1);
    unsubscribe();
  });

  test("после close повторный start открывает новый EventSource и заново запрашивает state", () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const first = eventSources.created[0]!;
    first.emitOpen();
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(2)));
    controller.close();

    controller.start();
    const second = eventSources.created[1]!;
    expect(second.closed).toBe(false);
    second.emitOpen();
    expect(stateCalls(fetchMock)).toHaveLength(2);
  });

  test("mutation ставит pending, сразу применяет возвращённый DTO и снимает pending", async () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;
    source.emitOpen();
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(2)));
    await flush();

    const mutation = controller.mutate("POST", "/guessed");
    expect(controller.getSnapshot().mutationPending).toBe(true);

    const call = fetchMock.calls[fetchMock.calls.length - 1]!;
    expect(call.input).toBe("/api/v1/games/k7q2/guessed");
    expect(call.init?.method).toBe("POST");

    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(3)));
    await mutation;

    const snapshot = controller.getSnapshot();
    expect(snapshot.mutationPending).toBe(false);
    expect(snapshot.errorMessage).toBeNull();
    expect(snapshot.game.game.revision).toBe(3);
  });

  test("вторая mutation во время pending отклоняется и запрос не отправляется", async () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;
    source.emitOpen();
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(2)));
    await flush();

    const first = controller.mutate("POST", "/guessed");
    const mutationCalls = fetchMock.calls.length;

    await expect(controller.mutate("POST", "/guessed")).rejects.toThrow(MUTATION_PENDING_MESSAGE);
    expect(fetchMock.calls).toHaveLength(mutationCalls);

    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(3)));
    await first;
    expect(controller.getSnapshot().mutationPending).toBe(false);
  });

  test("сбой mutation сохраняет ApiClientError, снимает pending и сохраняет последнее состояние", async () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;
    source.emitOpen();
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(2)));
    await flush();

    const mutation = controller.mutate("POST", "/guessed");
    fetchMock.nextPending().deferred.resolve(
      jsonResponse(409, { error: { code: "INVALID_GAME_STATE", message: "Сейчас нельзя отметить угадывание" } }),
    );

    const error = await mutation.then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe("INVALID_GAME_STATE");

    const snapshot = controller.getSnapshot();
    expect(snapshot.mutationPending).toBe(false);
    expect(snapshot.errorMessage).toBe("Сейчас нельзя отметить угадывание");
    expect(snapshot.game.game.revision).toBe(2);
  });

  test("устаревший успех mutation снимает pending и не перезаписывает более новое состояние", async () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;
    source.emitOpen();
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(5)));
    await flush();

    const mutation = controller.mutate("POST", "/guessed");
    source.emitGameChanged(JSON.stringify({ revision: 6 }));
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(6)));
    await flush();

    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(5)));
    await mutation;
    await flush();

    const snapshot = controller.getSnapshot();
    expect(snapshot.mutationPending).toBe(false);
    expect(snapshot.errorMessage).toBeNull();
    expect(snapshot.game.game.revision).toBe(6);
  });

  test("close во время mutation отменяет запрос, снимает pending и отбрасывает поздний ответ", async () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;
    source.emitOpen();
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(2)));
    await flush();

    const mutation = controller.mutate("POST", "/guessed");
    const pending = fetchMock.nextPending();
    expect(controller.getSnapshot().mutationPending).toBe(true);

    controller.close();
    expect(pending.call.init?.signal?.aborted).toBe(true);
    expect(controller.getSnapshot().mutationPending).toBe(false);
    expect(controller.getSnapshot().errorMessage).toBe(MUTATION_CANCELLED_MESSAGE);

    pending.deferred.resolve(jsonResponse(200, makeGameState(8)));
    await mutation;
    await flush();
    expect(controller.getSnapshot().game.game.revision).toBe(2);
  });

  test("getSnapshot возвращает один и тот же объект, пока состояние не изменилось", async () => {
    const { controller, fetchMock, eventSources } = setup();
    const first = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(first);

    controller.start();
    const source = eventSources.created[0]!;
    source.emitOpen();
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(2)));
    await flush();

    expect(controller.getSnapshot()).not.toBe(first);
  });

  test("подписчики уведомляются об изменениях, отписка и close прекращают уведомления", async () => {
    const { controller, fetchMock, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;

    let calls = 0;
    const unsubscribe = controller.subscribe(() => {
      calls += 1;
    });

    source.emitOpen();
    expect(calls).toBe(1);
    fetchMock.nextPending().deferred.resolve(jsonResponse(200, makeGameState(2)));
    await flush();
    expect(calls).toBe(2);

    unsubscribe();
    source.emitError();
    expect(calls).toBe(2);

    const second = controller.subscribe(() => {
      calls += 1;
    });
    controller.close();
    source.emitOpen();
    await flush();
    expect(calls).toBe(2);
    second();
  });

  test("close снимает слушатели EventSource", () => {
    const { controller, eventSources } = setup();
    controller.start();
    const source = eventSources.created[0]!;
    expect(source.listenerCount("game.changed")).toBe(1);

    controller.close();

    expect(source.listenerCount("game.changed")).toBe(0);
    expect(source.onopen).toBeNull();
    expect(source.onerror).toBeNull();
  });
});
