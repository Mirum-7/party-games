import { describe, expect, test } from "bun:test";

import type { Game, Player } from "@/generated/prisma/client";
import { buildGameStateResponse } from "@/server/core/games/projection";
import type { GameDefinition, GameProjectedState } from "@/server/core/games/types";
import type { Capabilities } from "@/shared/contracts/game";

const GAME_ID = "game-00000001";
const T0 = new Date("2026-11-23T09:00:00.000Z");

// Заглушка определения: buildGameStateResponse читает только type и лимиты
// состава; игровые хуки в тесте не вызываются.
const definition: GameDefinition = {
  type: "WORD_CHAIN",
  minPlayers: 3,
  maxPlayers: 12,
  createGame: () => Promise.resolve(),
  updateSettings: () => Promise.resolve(false),
  resetAttempt: () => Promise.resolve(),
  project: () => Promise.reject(new Error("UNUSED")),
};

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: GAME_ID,
    code: "WC1001",
    type: "WORD_CHAIN",
    status: "LOBBY",
    hostPlayerId: "pl-host",
    revision: 7,
    createdAt: T0,
    updatedAt: T0,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makePlayer(id: string, name: string, isReady: boolean): Player {
  return {
    id,
    gameId: GAME_ID,
    name,
    normalizedName: name.toLowerCase(),
    isReady,
    joinedAt: T0,
  };
}

function makeProjected(overrides: Partial<GameProjectedState> = {}): GameProjectedState {
  return {
    phase: "LOBBY",
    settings: { hideTargetNamesDuringSetup: false },
    playingStartedAt: null,
    setup: null,
    hints: null,
    results: null,
    capabilities: {},
    submittedWordPlayerIds: [],
    ...overrides,
  };
}

const PLAYERS = [
  makePlayer("pl-host", "Маша", true),
  makePlayer("pl-petya", "Петя", true),
  makePlayer("pl-vanya", "Ваня", true),
];

describe("buildGameStateResponse: Core-owned capabilities", () => {
  test("модуль не может ни включить, ни отключить Core-флаги через свою проекцию", () => {
    // Тип GameProjectedState["capabilities"] запрещает Core-owned ключи; приведение
    // имитирует скомпрометированный модуль, приславший их в обход типа. Core
    // обязан вычислить эти флаги заново из роли и публичной фазы, а module-owned
    // флаги модуля сохранить.
    const rogueCapabilities = {
      canEditSettings: false,
      canManagePlayers: false,
      canStart: false,
      canRestart: true,
      canLeave: false,
      canSubmitWord: true,
    } as unknown as GameProjectedState["capabilities"];

    const state = buildGameStateResponse({
      game: makeGame({ status: "FINISHED", finishedAt: T0 }),
      viewer: PLAYERS[0]!,
      players: PLAYERS,
      results: [],
      definition,
      projected: makeProjected({ phase: "FINISHED", capabilities: rogueCapabilities }),
    });

    expect(state.capabilities).toEqual({
      canEditSettings: false, // FINISHED: только LOBBY даёт право хоста
      canManagePlayers: false,
      canStart: false,
      canRestart: true, // хост в FINISHED, несмотря на canRestart:false модуля
      canLeave: true, // FINISHED разрешает выход, несмотря на canLeave:false модуля
      canSubmitWord: true, // module-owned флаг модуля проходит без изменений
      canMarkGuessed: false,
      canFinish: false,
      canCancel: false,
    } satisfies Capabilities);
  });

  test("не-хост в LOBBY не получает права хоста через проекцию модуля", () => {
    const rogueCapabilities = {
      canEditSettings: true,
      canManagePlayers: true,
      canStart: true,
    } as unknown as GameProjectedState["capabilities"];

    const state = buildGameStateResponse({
      game: makeGame(),
      viewer: PLAYERS[1]!,
      players: PLAYERS,
      results: [],
      definition,
      projected: makeProjected({ capabilities: rogueCapabilities }),
    });

    expect(state.capabilities.canEditSettings).toBe(false);
    expect(state.capabilities.canManagePlayers).toBe(false);
    expect(state.capabilities.canStart).toBe(false);
    expect(state.capabilities.canRestart).toBe(false);
    expect(state.capabilities.canLeave).toBe(true);
  });
});
