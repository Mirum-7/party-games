import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import {
  formatDuration,
  normalizeWordInput,
  wordInputError,
} from "@/components/game/word-chain/helpers";
import { HintList } from "@/components/game/word-chain/hint-list";
import { FinalResults } from "@/components/game/word-chain/final-results";
import { PlayingRoom } from "@/components/game/word-chain/playing-room";
import { WordSetup } from "@/components/game/word-chain/word-setup";
import type {
  GameStateResponse,
  HintItem,
  ResultItem,
} from "@/shared/contracts/game";

// Фокусные SSR-тесты разметки экранов WORD_CHAIN и чистых хелперов. Они не
// доказывают работу кликов, диалогов в браузере или SSE — live E2E отложен
// до интеграции GameRoom.

const VIEWER_ID = "p1";
const OWN_SECRET = "пирамида";

function baseState(phase: GameStateResponse["game"]["phase"]): GameStateResponse {
  return {
    game: {
      code: "K7Q2MN",
      type: "WORD_CHAIN",
      phase,
      revision: 2,
      minPlayers: 3,
      maxPlayers: 12,
      settings: { hideTargetNamesDuringSetup: false },
      startedAt: "2026-11-23T10:00:00.000Z",
      playingStartedAt:
        phase === "PLAYING" || phase === "FINISHED"
          ? "2026-11-23T10:05:00.000Z"
          : null,
      finishedAt: phase === "FINISHED" ? "2026-11-23T10:20:00.000Z" : null,
    },
    viewer: { playerId: VIEWER_ID },
    players: [
      { id: "p1", name: "Маша", isHost: true, isReady: true, hasSubmittedWord: true, hasGuessed: false },
      { id: "p2", name: "Петя", isHost: false, isReady: true, hasSubmittedWord: true, hasGuessed: false },
      { id: "p3", name: "Оля", isHost: false, isReady: true, hasSubmittedWord: false, hasGuessed: false },
    ],
    setup: null,
    hints: null,
    results: null,
    capabilities: {
      canEditSettings: false,
      canManagePlayers: false,
      canStart: false,
      canSubmitWord: false,
      canMarkGuessed: false,
      canFinish: false,
      canCancel: false,
      canLeave: false,
    },
  };
}

function hint(overrides: Partial<HintItem> = {}): HintItem {
  return {
    assignmentId: "a1",
    author: { id: "p1", name: "Маша" },
    target: { id: "p2", name: "Петя" },
    word: "радуга",
    wordHidden: false,
    ...overrides,
  };
}

function playingHints(): HintItem[] {
  return [
    hint({ assignmentId: "a1" }),
    hint({
      assignmentId: "a2",
      author: { id: "p2", name: "Петя" },
      target: { id: VIEWER_ID, name: "Маша" },
      word: null,
      wordHidden: true,
    }),
    hint({
      assignmentId: "a3",
      author: { id: "p3", name: "Оля" },
      target: { id: "p1", name: "Маша" },
      word: "компас",
      wordHidden: false,
    }),
  ];
}

function result(overrides: Partial<ResultItem>): ResultItem {
  return {
    playerId: "p1",
    name: "Маша",
    place: 1,
    score: 3,
    durationMs: 65_000,
    ...overrides,
  };
}

function renderWordSetup(state: GameStateResponse, mutationPending = false) {
  return renderToString(
    <WordSetup
      state={state}
      mutationPending={mutationPending}
      onSubmitWord={() => Promise.resolve()}
      onCancel={() => Promise.resolve()}
    />,
  );
}

function renderPlayingRoom(state: GameStateResponse, mutationPending = false) {
  return renderToString(
    <PlayingRoom
      state={state}
      mutationPending={mutationPending}
      onGuessed={() => Promise.resolve()}
      onFinish={() => Promise.resolve()}
    />,
  );
}

describe("helpers", () => {
  test("normalizeWordInput удаляет внешние пробелы и сохраняет внутренние", () => {
    expect(normalizeWordInput("  пи жама  ")).toBe("пи жама");
    expect(normalizeWordInput("\tслово\n")).toBe("слово");
  });

  test("wordInputError требует непустое слово после trim", () => {
    expect(wordInputError("")).toBe("Введите слово");
    expect(wordInputError("   ")).toBe("Введите слово");
  });

  test("wordInputError допускает слово от 1 до 80 кодовых точек", () => {
    expect(wordInputError("слово")).toBeNull();
    expect(wordInputError("ю".repeat(80))).toBeNull();
    expect(wordInputError("ю".repeat(81))).toContain("80");
    expect(wordInputError("😀".repeat(81))).toContain("80");
    expect(wordInputError("😀")).toBeNull();
  });

  test("formatDuration форматирует минуты:секунды и часы", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(59_999)).toBe("1:00");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });
});

describe("WordSetup", () => {
  function setupState(
    setup: GameStateResponse["setup"],
    capabilities: Partial<GameStateResponse["capabilities"]> = {},
  ): GameStateResponse {
    const state = baseState("ASSIGNING_WORDS");
    state.setup = setup;
    state.capabilities = { ...state.capabilities, canSubmitWord: true, ...capabilities };
    return state;
  }

  test("видимый адресат: «Загадай слово {name}»", () => {
    const html = renderWordSetup(
      setupState({
        target: { id: "p2", name: "Петя" },
        targetHidden: false,
        word: null,
      }),
    );
    expect(html).toContain("Загадай слово Петя");
    expect(html).not.toContain("Введи загаданное слово");
  });

  test("скрытый адресат: нейтральный заголовок без имени адресата", () => {
    const html = renderWordSetup(
      setupState({ target: null, targetHidden: true, word: null }),
    );
    expect(html).toContain("Введи загаданное слово");
    expect(html).not.toContain("Загадай слово");
  });

  test("сохранённое слово показано в поле и помечено фактом сохранения", () => {
    const html = renderWordSetup(
      setupState({
        target: { id: "p2", name: "Петя" },
        targetHidden: false,
        word: "пи жама",
      }),
    );
    expect(html).toContain("Слово сохранено");
    expect(html).toContain("пи жама");
    expect(html).toContain('value="пи жама"');
  });

  test("редактирование доступно, пока canSubmitWord, и блокируется без него", () => {
    const editable = renderWordSetup(
      setupState(
        { target: { id: "p2", name: "Петя" }, targetHidden: false, word: "пи жама" },
        { canSubmitWord: true },
      ),
    );
    expect(editable).not.toMatch(/<input[^>]*disabled=""/);

    const readonly = renderWordSetup(
      setupState(
        { target: { id: "p2", name: "Петя" }, targetHidden: false, word: "пи жама" },
        { canSubmitWord: false },
      ),
    );
    expect(readonly).toMatch(/<input[^>]*disabled=""/);
  });

  test("факты ожидания показаны без чужих слов", () => {
    const html = renderWordSetup(
      setupState({ target: { id: "p2", name: "Петя" }, targetHidden: false, word: "радуга" }),
    );
    expect(html).toContain("Слово сохранено");
    expect(html).toContain("Ждём слово");
    expect(html).not.toContain(OWN_SECRET);
  });

  test("хост видит отмену попытки через доступный диалог, не-хост — нет", () => {
    const host = renderWordSetup(
      setupState(
        { target: { id: "p2", name: "Петя" }, targetHidden: false, word: "радуга" },
        { canCancel: true },
      ),
    );
    expect(host).toContain("Отменить попытку");
    expect(host).toMatch(/aria-haspopup="dialog"/);

    const guest = renderWordSetup(
      setupState({ target: { id: "p2", name: "Петя" }, targetHidden: false, word: "радуга" }),
    );
    expect(guest).not.toContain("Отменить попытку");
  });

  test("pending блокирует поле и отправку", () => {
    const html = renderWordSetup(
      setupState({ target: { id: "p2", name: "Петя" }, targetHidden: false, word: null }),
      true,
    );
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(html).toContain("Сохраняем");
  });

  test("форма семантична: label привязан к полю, есть submit-кнопка", () => {
    const html = renderWordSetup(
      setupState({ target: { id: "p2", name: "Петя" }, targetHidden: false, word: null }),
    );
    expect(html).toContain('for="word-input"');
    expect(html).toContain('type="submit"');
    expect(html).toContain("min-h-11");
    expect(html).toContain("focus-visible");
  });
});

describe("HintList", () => {
  test("в PLAYING чужие слова видны, собственная строка — «вам», секрет отсутствует", () => {
    const html = renderToString(
      <HintList viewerPlayerId={VIEWER_ID} hints={playingHints()} />,
    );
    expect(html).toContain("радуга");
    expect(html).toContain("компас");
    expect(html).toContain("вам");
    expect(html).toContain("слово скрыто");
    expect(html).not.toContain(OWN_SECRET);
  });

  test("в FINISHED раскрыты все слова, включая собственное", () => {
    const hints = playingHints().map((item) =>
      item.wordHidden ? { ...item, word: OWN_SECRET, wordHidden: false } : item,
    );
    const html = renderToString(<HintList viewerPlayerId={VIEWER_ID} hints={hints} />);
    expect(html).toContain(OWN_SECRET);
    expect(html).not.toContain("слово скрыто");
  });
});

describe("PlayingRoom", () => {
  function playingState(
    capabilities: Partial<GameStateResponse["capabilities"]> = {},
    players: GameStateResponse["players"] = baseState("PLAYING").players,
  ): GameStateResponse {
    const state = baseState("PLAYING");
    state.players = players;
    state.hints = playingHints();
    state.capabilities = {
      ...state.capabilities,
      canMarkGuessed: true,
      ...capabilities,
    };
    return state;
  }

  test("не угадавший видит «Я угадал» с подтверждающим диалогом", () => {
    const html = renderPlayingRoom(playingState());
    expect(html).toContain("Я угадал");
    expect(html).toMatch(/aria-haspopup="dialog"/);
  });

  test("угадавший становится зрителем без повторного угадывания", () => {
    const players = baseState("PLAYING").players.map((player) =>
      player.id === VIEWER_ID ? { ...player, hasGuessed: true } : player,
    );
    const html = renderPlayingRoom(playingState({}, players));
    expect(html).toContain("Вы уже угадали");
    expect(html).not.toContain("Я угадал");
    expect(html).toContain("радуга");
  });

  test("секрет собственного слова отсутствует в разметке целиком", () => {
    const html = renderPlayingRoom(playingState());
    expect(html).not.toContain(OWN_SECRET);
    expect(html).toContain("слово скрыто");
  });

  test("хост видит досрочное завершение с подтверждением, не-хост — нет", () => {
    const host = renderPlayingRoom(playingState({ canFinish: true }));
    expect(host).toContain("Завершить игру");
    expect(host).toMatch(/aria-haspopup="dialog"/);

    const guest = renderPlayingRoom(playingState({ canFinish: false }));
    expect(guest).not.toContain("Завершить игру");
  });

  test("pending блокирует «Я угадал» и завершение", () => {
    const html = renderPlayingRoom(playingState({ canFinish: true }), true);
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("FinalResults", () => {
  function finishedState(results: ResultItem[]): GameStateResponse {
    const state = baseState("FINISHED");
    state.results = results;
    state.hints = playingHints().map((item) =>
      item.wordHidden ? { ...item, word: OWN_SECRET, wordHidden: false } : item,
    );
    return state;
  }

  test("карточки: место, имя, время или прочерк, очки", () => {
    const html = renderToString(
      <FinalResults
        state={finishedState([
          result({ playerId: "p1", name: "Маша", place: 1, score: 3, durationMs: 65_000 }),
          result({ playerId: "p2", name: "Петя", place: null, score: 0, durationMs: null }),
        ])}
      />,
    );
    expect(html).toContain("Результаты");
    expect(html).toContain("1 место");
    expect(html).toContain("Маша");
    expect(html).toContain("1:05");
    expect(html).toContain("Очки: 3");
    expect(html).toContain("Не угадал");
    expect(html).toContain("Очки: 0");
  });

  test("не угадавшие идут после занявших места", () => {
    const html = renderToString(
      <FinalResults
        state={finishedState([
          result({ playerId: "p1", name: "Маша", place: 1, score: 3, durationMs: 65_000 }),
          result({ playerId: "p3", name: "Оля", place: 2, score: 2, durationMs: 90_000 }),
          result({ playerId: "p2", name: "Петя", place: null, score: 0, durationMs: null }),
        ])}
      />,
    );
    expect(html.indexOf("1 место")).toBeLessThan(html.indexOf("2 место"));
    expect(html.indexOf("2 место")).toBeLessThan(html.indexOf("Не угадал"));
  });

  test("ниже рейтинга показаны все назначения и слова", () => {
    const html = renderToString(
      <FinalResults
        state={finishedState([
          result({ playerId: "p1", name: "Маша", place: 1, score: 3, durationMs: 65_000 }),
        ])}
      />,
    );
    expect(html).toContain(OWN_SECRET);
    expect(html).toContain("радуга");
  });

  test("рейтинг — не таблица, нет горизонтального скролла", () => {
    const html = renderToString(
      <FinalResults
        state={finishedState([
          result({ playerId: "p1", name: "Маша", place: 1, score: 3, durationMs: null }),
        ])}
      />,
    );
    expect(html).not.toContain("<table");
    expect(html).not.toContain("overflow-x");
  });

  test("прочерк вместо времени у не угадавшего", () => {
    const html = renderToString(
      <FinalResults
        state={finishedState([
          result({ playerId: "p2", name: "Петя", place: null, score: 0, durationMs: null }),
        ])}
      />,
    );
    expect(html).toContain("—");
  });
});
