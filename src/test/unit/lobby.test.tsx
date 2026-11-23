import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { getStartBlockReason, INVITE_COPIED_RESET_MS, Lobby } from "@/components/game/lobby";
import type { GameStateResponse } from "@/shared/contracts/game";

// Фокусные SSR-тесты разметки лобби и чистых хелперов. Индикатор соединения
// и баннер ошибок рисует оболочка GameRoomView (см. game-room.test.tsx);
// клики и диалоги доказываются browser E2E.

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
      canRestart: false,
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
    <Lobby state={state} mutationPending={mutationPending} {...callbacks} />,
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
  test("показывает код в accent-карточке, порядок игроков, хоста и статусы готовности", () => {
    const html = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя", { isReady: false }),
        player("Оля"),
      ]),
    );
    expect(html).toContain("K7Q2MN");
    expect(html).toContain("bg-primary");
    expect(html).toContain("Скопировать приглашение");
    expect(html).toContain("Присоединяйся к игре Words Game! Код комнаты: K7Q2MN");
    // Текст приглашения на primary-фоне без ослабления прозрачности: /80
    // давал бы контраст ниже AA (4.06 против требуемых 4.5).
    expect(html).not.toContain("primary-foreground/80");
    expect(html).toContain('class="text-sm text-primary-foreground"');
    expect(html.indexOf("Маша")).toBeLessThan(html.indexOf("Петя"));
    expect(html.indexOf("Петя")).toBeLessThan(html.indexOf("Оля"));
    expect(html).toContain("Хост");
    expect(html).toContain("Готов");
    expect(html).toContain("Пока не готов");
    expect(html).toContain('data-variant="success"');
    expect(html).toContain('data-variant="warning"');
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

  test("удаление участника живёт в строке ростера, отдельного списка кнопок нет", () => {
    const html = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя"),
        player("Оля"),
      ]),
    );
    for (const name of ["Петя", "Оля"]) {
      const label = `aria-label="Удалить участника «${name}»"`;
      expect(html).toContain(label);
      const actionAt = html.indexOf(label);
      const item = html.slice(html.lastIndexOf("<li", actionAt), html.indexOf("</li>", actionAt));
      expect(item).toContain(name);
    }
    expect(html).not.toContain('aria-label="Удалить участника «Маша»"');
    expect(html.slice(html.indexOf("</ol>"))).not.toContain("Удалить участника");
    expect(html).toContain("Скрывать имена адресатов");
    expect(html).toContain("Начать игру");
  });

  test("не-админ не видит управляющих контролов, но управляет своей готовностью", () => {
    const state = makeState([
      player("Маша", { isHost: true }),
      player("Петя"),
      player("Оля"),
    ]);
    state.viewer = { playerId: state.players[1].id };
    state.capabilities = { ...state.capabilities, canEditSettings: false, canManagePlayers: false, canStart: false };
    const html = renderLobby(state);
    expect(html).not.toContain("Скрывать имена адресатов");
    expect(html).not.toContain("Удалить участника");
    expect(html).not.toContain("Начать игру");
    expect(html).toContain('id="ready-button"');
  });

  test("старт заблокирован с видимой русской причиной", () => {
    const html = renderLobby(
      makeState([player("Маша", { isHost: true }), player("Петя")]),
    );
    expect(html).toContain("Для старта нужно минимум 3 участника");
    expect(html).toMatch(/Начать игру/);
  });

  test("готовность — одна полноширинная кнопка вместо переключателя", () => {
    const notReady = renderLobby(
      makeState([
        player("Маша", { isHost: true, isReady: false }),
        player("Петя"),
        player("Оля"),
      ]),
    );
    expect(notReady.match(/id="ready-button"/g)?.length).toBe(1);
    expect(notReady).toContain("Я готов");
    expect(notReady).not.toContain("ready-switch");

    const ready = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя"),
        player("Оля"),
      ]),
    );
    expect(ready).toContain("Вы готовы");
    expect(ready).not.toContain("ready-switch");
  });

  test("«Ждём начала игры хостом» видит только готовый не-хост", () => {
    const hostView = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя"),
        player("Оля"),
      ]),
    );
    expect(hostView).not.toContain("Ждём начала игры хостом");

    const readyGuestState = makeState([
      player("Маша", { isHost: true }),
      player("Петя"),
      player("Оля"),
    ]);
    readyGuestState.viewer = { playerId: readyGuestState.players[1].id };
    const readyGuestView = renderLobby(readyGuestState);
    expect(readyGuestView).toContain("Ждём начала игры хостом");

    // Неготовый участник ещё действует, а не ждёт: подсказка не показана.
    const notReadyGuestState = makeState([
      player("Маша", { isHost: true }),
      player("Петя", { isReady: false }),
      player("Оля"),
    ]);
    notReadyGuestState.viewer = { playerId: notReadyGuestState.players[1].id };
    const notReadyGuestView = renderLobby(notReadyGuestState);
    expect(notReadyGuestView).not.toContain("Ждём начала игры хостом");
  });

  test("copied feedback сбрасывается таймером 2–3 с с очисткой", () => {
    expect(INVITE_COPIED_RESET_MS).toBeGreaterThanOrEqual(2000);
    expect(INVITE_COPIED_RESET_MS).toBeLessThanOrEqual(3000);
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

  test("контролы имеют touch-таргет не менее 44px", () => {
    const html = renderLobby(
      makeState([
        player("Маша", { isHost: true }),
        player("Петя"),
        player("Оля"),
      ]),
    );
    expect(html).toContain("min-h-11");
    expect(html).toContain("size-11");
    expect(html).toContain("focus-visible");
  });
});
