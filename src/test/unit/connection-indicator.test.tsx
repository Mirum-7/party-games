import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { ConnectionIndicator } from "@/components/game/connection-indicator";
import type { ConnectionStatus } from "@/components/game/sync-reducer";
import type { GameStateResponse } from "@/shared/contracts/game";

// Регрессия: канонический ConnectionStatus из sync-reducer должен
// приниматься индикатором и оболочкой GameRoomView целиком, с русской копией.

const STATUSES: Array<{ status: ConnectionStatus; label: string }> = [
  { status: "connecting", label: "Подключение…" },
  { status: "connected", label: "Подключено" },
  { status: "reconnecting", label: "Переподключение…" },
];

function makeState(): GameStateResponse {
  return {
    game: {
      code: "K7Q2MN",
      type: "WORD_CHAIN",
      phase: "LOBBY",
      revision: 1,
      minPlayers: 3,
      maxPlayers: 12,
      settings: { hideTargetNamesDuringSetup: false },
      startedAt: null,
      playingStartedAt: null,
      finishedAt: null,
    },
    viewer: { playerId: "p1" },
    players: [
      { id: "p1", name: "Маша", isHost: true, isReady: true, hasSubmittedWord: false, hasGuessed: false },
      { id: "p2", name: "Петя", isHost: false, isReady: true, hasSubmittedWord: false, hasGuessed: false },
      { id: "p3", name: "Оля", isHost: false, isReady: true, hasSubmittedWord: false, hasGuessed: false },
    ],
    setup: null,
    hints: null,
    results: null,
    capabilities: {
      canEditSettings: true,
      canManagePlayers: true,
      canStart: true,
      canSubmitWord: false,
      canMarkGuessed: false,
      canFinish: false,
      canCancel: false,
      canLeave: true,
    },
  };
}

describe("ConnectionIndicator с каноническим ConnectionStatus", () => {
  for (const { status, label } of STATUSES) {
    test(`рендерит «${label}» для статуса ${status}`, () => {
      const html = renderToString(<ConnectionIndicator status={status} />);
      expect(html).toContain(label);
    });
  }
});

describe("GameRoomView принимает каждый канонический статус", () => {
  for (const { status, label } of STATUSES) {
    test(`показывает «${label}» для статуса ${status}`, async () => {
      const { GameRoomView } = await import("@/components/game/game-room");
      const html = renderToString(
        <GameRoomView
          game={makeState()}
          connectionStatus={status}
          mutationPending={false}
          errorMessage={null}
          refresh={() => Promise.resolve()}
          onToggleReady={() => Promise.resolve()}
          onUpdateSettings={() => Promise.resolve()}
          onStart={() => Promise.resolve()}
          onRemove={() => Promise.resolve()}
          onLeave={() => Promise.resolve()}
          onSubmitWord={() => Promise.resolve()}
          onCancel={() => Promise.resolve()}
          onGuessed={() => Promise.resolve()}
          onFinish={() => Promise.resolve()}
        />,
      );
      expect(html).toContain(label);
    });
  }
});
