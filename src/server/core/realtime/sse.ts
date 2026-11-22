import type { GameRealtime } from "./types";

export const GAME_EVENTS_RETRY_LINE = "retry: 3000\n\n";
export const GAME_EVENTS_HEARTBEAT_LINE = ": ping\n\n";
export const GAME_EVENTS_HEARTBEAT_INTERVAL_MS = 15000;

export type CreateGameEventsStreamOptions = {
  gameId: string;
  realtime: GameRealtime;
  getCurrentRevision: () => Promise<number>;
  signal?: AbortSignal;
  heartbeatIntervalMs?: number;
};

function frameRevision(revision: number): string {
  return `id: ${revision}\nevent: game.changed\ndata: {"revision":${revision}}\n\n`;
}

// Поток несёт только метаданные синхронизации: retry, heartbeat и номера
// ревизий. Никаких кодов комнат, имён, слов и других полей DTO.
export function createGameEventsStream(options: CreateGameEventsStreamOptions): ReadableStream<Uint8Array> {
  const { gameId, realtime, getCurrentRevision, signal } = options;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? GAME_EVENTS_HEARTBEAT_INTERVAL_MS;
  const encoder = new TextEncoder();

  let cancelled = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const shutdown = (): void => {
    if (cancelled) return;
    cancelled = true;
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (line: string): void => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          // Поток уже закрыт/отменён: гонка cancel/enqueue не должна улетать
          // в publish после commit команды.
        }
      };

      const closeQuietly = (): void => {
        shutdown();
        try {
          controller.close();
        } catch {
          // Повторный close после racing-cancel безопасен.
        }
      };

      const onAbort = (): void => {
        closeQuietly();
      };

      safeEnqueue(GAME_EVENTS_RETRY_LINE);

      // Подписка до чтения текущей ревизии: публикация между ними
      // дойдёт до слушателя, а позднее чтение не потеряет событие.
      unsubscribe = realtime.subscribe(gameId, (revision) => {
        safeEnqueue(frameRevision(revision));
      });
      if (signal !== undefined) {
        if (signal.aborted) {
          closeQuietly();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      heartbeat = setInterval(() => {
        safeEnqueue(GAME_EVENTS_HEARTBEAT_LINE);
      }, heartbeatIntervalMs);
      (heartbeat as unknown as { unref?: () => void }).unref?.();

      getCurrentRevision().then(
        (revision) => {
          safeEnqueue(frameRevision(revision));
        },
        () => {
          // Начальную ревизию не получить: закрываем соединение, клиент
          // переподключится по retry и запросит состояние.
          closeQuietly();
        },
      );
    },
    cancel() {
      shutdown();
    },
  });
}

export function createGameEventsResponse(options: CreateGameEventsStreamOptions): Response {
  return new Response(createGameEventsStream(options), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
