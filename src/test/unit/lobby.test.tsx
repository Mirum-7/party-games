import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { getStartBlockReason, Lobby } from "@/components/game/lobby";
import type { GameStateResponse } from "@/shared/contracts/game";

// Фокусные SSR-тесты разметки лобби и чистых хелперов. Они не доказывают
// работу кликов, диалогов в браузере или SSE — live E2E отложен до интеграции.

let seq = 0;
function player(
  name: string,
  overrides: Partial<GameStateResponse["players"][number]> = {},
) {
  seq += 1;
  return {
    id: `player-${seq}`,
    name,
    isHost: false,
    isReady: true,
    hasSubmittedWord: false,
    hasGuessed: false,
    ...overrides,
  };
}

function makeState(players: GameStateResponse["players"]): GameStateResponse {
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
    viewer: { playerId: players[0]?.id ?? "player-0" },
    players,
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

const callbacks = {
  onToggleReady: () => Promise.resolve(),
  onUpdateSettings: () => Promise.resolve(),
  onStart: () => Promise.resolve(),
  onRemove: () => Promise.resolve(),
  onLeave: () => Promise.resolve(),
};

function renderLobby(state: GameStateResponse, mutationPending = false) {
  return renderToString(
    <Lobby
      state={state}
      connectionStatus="connected"
      mutationPending={mutationPending}
      {...callbacks}
    />,
  );
}

describe("getStartBlockReason", () => {
  test("null, когда три готовых участника", () => {
    const players = [player("Маша"), player("Петя"), player("Оля")];
    expect(getStartBlockReason(players)).toBeNull();
  });

  test("русская причина при меньше трёх участников", () => {
    expect(getStartBlockReason([player("Маша"), player("Петя")])).toBe(
      "Для старта нужно минимум 3 участника",
    );
  });

  test("русская причина при больше двенадцати участников", () => {
    const players = Array.from({ length: 13 }, (_, i) => player(`Игрок ${i + 1}`));
    expect(getStartBlockReason(players)).toBe(
      "Для старта допускается максимум 12 участников",
    );
  });

  test("русская причина, когда не все готовы", () => {
    const players = [
      player("Маша"),
      player("Петя"),
      player("Оля", { isReady: false }),
    ];
    expect(getStartBlockReason(players)).toBe("Не все участники готовы");
  });
});

describe("Lobby", () => {
  test("показывает код комнаты, порядок игроков, хоста и готовность", () => {
    const html = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя", { isReady: false }),
        player("Оля"),
      ]),
    );
    expect(html).toContain("K7Q2MN");
    expect(html.indexOf("Маша")).toBeLessThan(html.indexOf("Петя"));
    expect(html.indexOf("Петя")).toBeLessThan(html.indexOf("Оля"));
    expect(html).toContain("Хост");
    expect(html).toContain("Готов");
    expect(html).toContain("Не готов");
  });

  test("флаги слова и угадывания показываются только когда есть в DTO", () => {
    const withFlags = renderLobby(
      makeState([
        player("Маша", { isHost: true, hasSubmittedWord: true, hasGuessed: true }),
        player("Петя"),
        player("Оля"),
      ]),
    );
    expect(withFlags).toContain("Слово загадано");
    expect(withFlags).toContain("Угадал");

    const withoutFlags = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя"),
        player("Оля"),
      ]),
    );
    expect(withoutFlags).not.toContain("Слово загадано");
    expect(withoutFlags).not.toContain("Угадал");
  });

  test("админ видит переключатель скрытия имён, удаление и старт", () => {
    const html = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя"),
        player("Оля"),
      ]),
    );
    expect(html).toContain("Скрывать имена адресатов");
    expect(html).toContain("Удалить Петя");
    expect(html).toContain("Начать игру");
  });

  test("не-админ не видит управляющих контролов", () => {
    const state = makeState([
      player("Маша", { isHost: true }),
      player("Петя"),
      player("Оля"),
    ]);
    state.viewer = { playerId: state.players[1].id };
    state.capabilities = { ...state.capabilities, canEditSettings: false, canManagePlayers: false, canStart: false };
    const html = renderLobby(state);
    expect(html).not.toContain("Скрывать имена адресатов");
    expect(html).not.toContain("Удалить");
    expect(html).not.toContain("Начать игру");
  });

  test("старт заблокирован с видимой русской причиной", () => {
    const html = renderLobby(
      makeState([player("Маша", { isHost: true }), player("Петя")]),
    );
    expect(html).toContain("Для старта нужно минимум 3 участника");
    expect(html).toMatch(/Начать игру/);
  });

  test("переключение готовности доступно только себе", () => {
    const html = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя"),
        player("Оля"),
      ]),
    );
    expect(html).toContain("Готовность");
    expect(html).not.toContain("Изменить готовность Петя");
  });

  test("выход использует доступный диалог подтверждения", () => {
    const html = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя"),
        player("Оля"),
      ]),
    );
    expect(html).toContain("Выйти из игры");
    expect(html).toMatch(/aria-haspopup="dialog"/);
  });

  test("pending блокирует повторную отправку", () => {
    const html = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя"),
        player("Оля"),
      ]),
      true,
    );
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test("статус подключения показан ненавязчиво", () => {
    const html = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя"),
        player("Оля"),
      ]),
    );
    expect(html).toContain("Подключено");
  });

  test("контролы имеют touch-таргет не менее 44px", () => {
    const html = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя"),
        player("Оля"),
      ]),
    );
    expect(html).toContain("min-h-11");
    expect(html).toContain("focus-visible");
  });
});
