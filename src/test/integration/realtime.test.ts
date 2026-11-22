import { describe, expect, test } from "bun:test";

import { getProcessGameRealtime, InMemoryGameRealtime } from "@/server/core/realtime/in-memory";

describe("InMemoryGameRealtime", () => {
  test("доставляет ревизию только подписчикам этой комнаты", () => {
    const realtime = new InMemoryGameRealtime();
    const callsA: number[] = [];
    const callsB: number[] = [];
    realtime.subscribe("game-a", (revision) => callsA.push(revision));
    realtime.subscribe("game-b", (revision) => callsB.push(revision));

    realtime.publish("game-a", 7);

    expect(callsA).toEqual([7]);
    expect(callsB).toEqual([]);
  });

  test("subscribe возвращает cleanup, который отключает слушателя", () => {
    const realtime = new InMemoryGameRealtime();
    const calls: number[] = [];
    const cleanup = realtime.subscribe("game-a", (revision) => calls.push(revision));

    realtime.publish("game-a", 1);
    cleanup();
    realtime.publish("game-a", 2);

    expect(calls).toEqual([1]);
  });

  test("несколько слушателей получают одну ревизию; cleanup работает на каждого", () => {
    const realtime = new InMemoryGameRealtime();
    const first: number[] = [];
    const second: number[] = [];
    const cleanupFirst = realtime.subscribe("game-a", (revision) => first.push(revision));
    realtime.subscribe("game-a", (revision) => second.push(revision));

    realtime.publish("game-a", 3);
    cleanupFirst();
    realtime.publish("game-a", 4);

    expect(first).toEqual([3]);
    expect(second).toEqual([3, 4]);
  });

  test("publish без подписчиков не падает", () => {
    const realtime = new InMemoryGameRealtime();
    expect(() => realtime.publish("nobody", 1)).not.toThrow();
  });

  test("process-global singleton возвращает один экземпляр на процесс", () => {
    const first = getProcessGameRealtime();
    const second = getProcessGameRealtime();
    expect(first).toBe(second);
    expect(first).toBeInstanceOf(InMemoryGameRealtime);
  });
});
