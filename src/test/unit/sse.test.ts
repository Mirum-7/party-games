import { describe, expect, test } from "bun:test";

import { createGameEventsResponse, createGameEventsStream } from "@/server/core/realtime/sse";

type Listener = (revision: number) => void;

function createFakeRealtime() {
  const listeners = new Map<string, Set<Listener>>();
  const calls: string[] = [];
  return {
    calls,
    publish(gameId: string, revision: number): void {
      for (const listener of [...(listeners.get(gameId) ?? [])]) {
        listener(revision);
      }
    },
    subscribe(gameId: string, listener: Listener): () => void {
      calls.push(`subscribe:${gameId}`);
      let set = listeners.get(gameId);
      if (set === undefined) {
        set = new Set();
        listeners.set(gameId, set);
      }
      set.add(listener);
      return () => {
        calls.push(`unsubscribe:${gameId}`);
        set.delete(listener);
      };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function openStream(
  options: {
    realtime?: ReturnType<typeof createFakeRealtime>;
    getCurrentRevision?: () => Promise<number>;
    signal?: AbortSignal;
    heartbeatIntervalMs?: number;
  } = {},
) {
  const realtime = options.realtime ?? createFakeRealtime();
  const revision = deferred<number>();
  const stream = createGameEventsStream({
    gameId: "game-1",
    realtime,
    getCurrentRevision: options.getCurrentRevision ?? (() => revision.promise),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
  });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const next = async (timeoutMs = 1000): Promise<string> => {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("таймаут ожидания chunk")), timeoutMs),
      ),
    ]);
    if (result.done) throw new Error("поток закрылся раньше chunk");
    return decoder.decode(result.value, { stream: true });
  };
  return { realtime, revision, reader, next };
}

describe("createGameEventsStream", () => {
  test("подписывается до чтения текущей ревизии", () => {
    const realtime = createFakeRealtime();
    const order: string[] = [];
    createGameEventsStream({
      gameId: "game-1",
      realtime,
      getCurrentRevision: () => {
        order.push("read");
        return Promise.resolve(1);
      },
    });
    expect(realtime.calls).toEqual(["subscribe:game-1"]);
    expect(order).toEqual(["read"]);
  });

  test("начинается с retry: 3000, затем текущая ревизия как game.changed", async () => {
    const { revision, next } = openStream();

    expect(await next()).toBe("retry: 3000\n\n");
    revision.resolve(7);
    expect(await next()).toBe('id: 7\nevent: game.changed\ndata: {"revision":7}\n\n');
  });

  test("каждая опубликованная ревизия уходит одним событием в точном формате", async () => {
    const { realtime, revision, next } = openStream();
    revision.resolve(7);
    await next();
    await next();

    realtime.publish("game-1", 8);
    expect(await next()).toBe('id: 8\nevent: game.changed\ndata: {"revision":8}\n\n');
  });

  test("повторная публикация той же ревизии не ломает поток", async () => {
    const { realtime, revision, next } = openStream();
    revision.resolve(3);
    await next();
    await next();

    realtime.publish("game-1", 3);
    realtime.publish("game-1", 3);
    expect(await next()).toBe('id: 3\nevent: game.changed\ndata: {"revision":3}\n\n');
    expect(await next()).toBe('id: 3\nevent: game.changed\ndata: {"revision":3}\n\n');
  });

  test("heartbeat с внедряемым интервалом — ровно ': ping' каждый тик", async () => {
    const { revision, next } = openStream({ heartbeatIntervalMs: 5 });
    revision.resolve(1);
    await next();
    await next();

    for (let i = 0; i < 3; i++) {
      expect(await next()).toBe(": ping\n\n");
    }
  });

  test("по умолчанию heartbeat не приходит быстрее продакшен-интервала", async () => {
    const { revision, next } = openStream();
    revision.resolve(1);
    await next();
    await next();

    await new Promise((resolve) => setTimeout(resolve, 120));
    await expect(next(50)).rejects.toThrow("таймаут");
  });

  test("отмена потока отписывается, останавливает heartbeat и глушит поздние enqueue", async () => {
    const { realtime, revision, reader, next } = openStream({ heartbeatIntervalMs: 5 });
    revision.resolve(1);
    await next();
    await next();

    await reader.cancel();
    expect(realtime.calls).toEqual(["subscribe:game-1", "unsubscribe:game-1"]);
    expect((await reader.read()).done).toBe(true);

    expect(() => realtime.publish("game-1", 9)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  test("abort сигнала запроса закрывает поток и отписывается", async () => {
    const controller = new AbortController();
    const { realtime, revision, reader, next } = openStream({ signal: controller.signal });
    revision.resolve(2);
    await next();
    await next();

    controller.abort();
    expect(realtime.calls).toEqual(["subscribe:game-1", "unsubscribe:game-1"]);
    expect((await reader.read()).done).toBe(true);
    expect(() => realtime.publish("game-1", 3)).not.toThrow();
  });

  test("поздно разрешившееся чтение ревизии не пишет в закрытый поток", async () => {
    const { realtime, revision, reader, next } = openStream();

    expect(await next()).toBe("retry: 3000\n\n");
    await reader.cancel();
    revision.resolve(5);

    expect(() => realtime.publish("game-1", 6)).not.toThrow();
    expect((await reader.read()).done).toBe(true);
  });

  test("отклонение чтения ревизии закрывает поток без unhandled rejection", async () => {
    const { realtime, revision, reader, next } = openStream();
    await next();

    revision.reject(new Error("db down"));
    expect((await reader.read()).done).toBe(true);
    expect(() => realtime.publish("game-1", 1)).not.toThrow();
  });

  test("сообщения не содержат ничего, кроме номера ревизии", async () => {
    const { realtime, revision, next } = openStream();
    revision.resolve(11);
    const chunks = [await next(), await next()];

    realtime.publish("game-1", 12);
    chunks.push(await next());

    for (const chunk of chunks) {
      expect(chunk.includes("самолёт")).toBe(false);
      expect(chunk.includes("Маша")).toBe(false);
    }
    expect(JSON.stringify(chunks)).toBe(
      JSON.stringify([
        "retry: 3000\n\n",
        'id: 11\nevent: game.changed\ndata: {"revision":11}\n\n',
        'id: 12\nevent: game.changed\ndata: {"revision":12}\n\n',
      ]),
    );
  });
});

describe("createGameEventsResponse", () => {
  test("выставляет ровно зафиксированные SSE-заголовки", () => {
    const response = createGameEventsResponse({
      gameId: "game-1",
      realtime: createFakeRealtime(),
      getCurrentRevision: () => Promise.resolve(1),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("Connection")).toBe("keep-alive");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
  });
});
