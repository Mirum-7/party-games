import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { useGameState } from "@/components/game/use-game-state";
import type { GameStateResponse } from "@/shared/contracts/game";

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

function Consumer({ code, initialState }: { code: string; initialState: GameStateResponse }) {
  const state = useGameState(code, initialState);
  return (
    <output>
      <span data-slot="status">{state.connectionStatus}</span>
      <span data-slot="revision">{state.game.game.revision}</span>
      <span data-slot="pending">{String(state.mutationPending)}</span>
    </output>
  );
}

describe("useGameState SSR", () => {
  test("renderToString рендерит потребителя без ошибок и без открытия EventSource", () => {
    // В среде Bun глобального EventSource нет: любая попытка открыть поток во
    // время серверного рендера (эффекты не выполняются) упала бы с ошибкой.
    const html = renderToString(<Consumer code="k7q2" initialState={makeGameState(4)} />);

    expect(html).toContain("connecting");
    expect(html).toContain(">4<");
    expect(html).toContain("false");
  });

  test("серверный снапшот совпадает с начальным DTO независимо для двух рендеров", () => {
    const first = renderToString(<Consumer code="k7q2" initialState={makeGameState(4)} />);
    const second = renderToString(<Consumer code="k7q2" initialState={makeGameState(4)} />);

    expect(first).toBe(second);
  });
});
