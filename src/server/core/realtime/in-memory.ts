import type { GameRealtime } from "./types";

// In-memory реализация для одного процесса Next.js. Слушатели хранятся в Map
// по gameId; subscribe возвращает cleanup, который удаляет слушателя.
export class InMemoryGameRealtime implements GameRealtime {
  private readonly listeners = new Map<string, Set<(revision: number) => void>>();

  publish(gameId: string, revision: number): void {
    const listeners = this.listeners.get(gameId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      listener(revision);
    }
  }

  subscribe(gameId: string, listener: (revision: number) => void): () => void {
    let listeners = this.listeners.get(gameId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(gameId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(gameId);
      }
    };
  }
}

const globalForRealtime = globalThis as unknown as { __wordsGameRealtime?: InMemoryGameRealtime };

// Process-global singleton: переживает перезагрузку модулей Next.js в dev,
// поэтому SSE-подписки не теряются при hot reload.
export function getProcessGameRealtime(): InMemoryGameRealtime {
  globalForRealtime.__wordsGameRealtime ??= new InMemoryGameRealtime();
  return globalForRealtime.__wordsGameRealtime;
}
