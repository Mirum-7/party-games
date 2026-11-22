"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { GameStateResponse } from "@/shared/contracts/game";

import type { MutationMethod } from "./api-client";
import { GameSyncController } from "./sync-controller";
import type { GameSyncState } from "./sync-reducer";

export type UseGameStateResult = GameSyncState & {
  refresh: () => Promise<void>;
  mutate: (method: MutationMethod, path: string, body?: unknown) => Promise<void>;
};

// Тонкая обёртка над GameSyncController: контроллер вне React — здесь только
// подписка через useSyncExternalStore и жизненный цикл в эффекте. Смена кода
// пересоздаёт контроллер; старый закрывается cleanup-предыдущего эффекта.
export function useGameState(code: string, initialState: GameStateResponse): UseGameStateResult {
  const [controller, setController] = useState(
    () => new GameSyncController({ code, initialState }),
  );
  const [prevCode, setPrevCode] = useState(code);

  if (prevCode !== code) {
    setPrevCode(code);
    setController(new GameSyncController({ code, initialState }));
  }

  useEffect(() => {
    controller.start();
    return () => controller.close();
  }, [controller]);

  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  const state = useSyncExternalStore(
    useCallback((onStoreChange) => controller.subscribe(onStoreChange), [controller]),
    getSnapshot,
    getSnapshot,
  );

  const refresh = useCallback(() => controller.refresh(), [controller]);
  const mutate = useCallback(
    (method: MutationMethod, path: string, body?: unknown) =>
      controller.mutate(method, path, body),
    [controller],
  );

  return { ...state, refresh, mutate };
}
