import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import {
  formatDuration,
  normalizeWordInput,
  wordInputError,
} from "@/components/game/word-chain/helpers";
import { HintList } from "@/components/game/word-chain/hint-list";
import {
  FinalResults,
  type FinalResultsProps,
} from "@/components/game/word-chain/final-results";
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
      canRestart: false,
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

// Назначения образуют один цикл p1 → p3 → p2 → p1: в PLAYING видимое слово
// «компас» относится к строке p3 → p2, а не к адресату зрителя — собственное
// слово viewer (a3) приходит только со word=null и wordHidden=true.
function playingHints(): HintItem[] {
  return [
    hint({
      assignmentId: "a1",
      author: { id: "p3", name: "Оля" },
      target: { id: "p2", name: "Петя" },
      word: "компас",
      wordHidden: false,
    }),
    hint({
      assignmentId: "a2",
      author: { id: "p1", name: "Маша" },
      target: { id: "p3", name: "Оля" },
      word: "радуга",
      wordHidden: false,
    }),
    hint({
      assignmentId: "a3",
      author: { id: "p2", name: "Петя" },
      target: { id: VIEWER_ID, name: "Маша" },
      word: null,
      wordHidden: true,
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

  test("видимый адресат: «Загадайте слово для игрока: {name}» и прогресс", () => {
    const html = renderWordSetup(
      setupState({
        target: { id: "p2", name: "Петя" },
        targetHidden: false,
        word: null,
      }),
    );
    expect(html).toContain("Загадайте слово для игрока: Петя");
    expect(html).not.toContain("Введите загаданное слово");
    expect(html).toContain("Слова сохранены: 2 из 3");
  });

  test("скрытый адресат: нейтральный заголовок без имени адресата", () => {
    const html = renderWordSetup(
      setupState({ target: null, targetHidden: true, word: null }),
    );
    expect(html).toContain("Введите загаданное слово");
    expect(html).not.toContain("Загадайте слово для игрока");
  });

  test("сохранённое слово показано в поле и отражено в общем прогрессе", () => {
    const html = renderWordSetup(
      setupState({
        target: { id: "p2", name: "Петя" },
        targetHidden: false,
        word: "пи жама",
      }),
    );
    expect(html).toContain("Слова сохранены: 2 из 3");
    expect(html).toContain("пи жама");
    expect(html).toContain('value="пи жама"');
  });

  test("в карточке ровно одна подсказка «От 1 до 80 символов. Слово можно изменить до начала игры.»", () => {
    const html = renderWordSetup(
      setupState({ target: { id: "p2", name: "Петя" }, targetHidden: false, word: null }),
    );
    const hint = "От 1 до 80 символов. Слово можно изменить до начала игры.";
    expect(html).toContain(hint);
    expect(html.match(/От 1 до 80 символов/g)?.length).toBe(1);
    expect(html).not.toContain("конца этапа загадывания");
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

  test("факты ожидания показаны через статусы строк без чужих слов", () => {
    const html = renderWordSetup(
      setupState({ target: { id: "p2", name: "Петя" }, targetHidden: false, word: "радуга" }),
    );
    expect(html).toContain("Слово готово");
    expect(html).toContain("Ждём слово");
    expect(html).not.toContain(OWN_SECRET);
  });

  test("success-бейдж «Слово готово» продублирован иконкой Check, «Ждём слово» — без неё", () => {
    const html = renderWordSetup(
      setupState({ target: { id: "p2", name: "Петя" }, targetHidden: false, word: "радуга" }),
    );
    // p1 и p2 уже сохранили слова, p3 — нет: строго по одной галочке на факт.
    expect(html.match(/lucide-check/g)?.length).toBe(2);
    expect(html).toContain("lucide-check");
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
  test("стилистика: пара author→target вторична (text-xs muted), слово крупное с переносом", () => {
    const html = renderToString(
      <HintList viewerPlayerId={VIEWER_ID} hints={playingHints()} prioritizeViewer />,
    );
    expect(html).toMatch(/class="block truncate text-xs text-muted-foreground"/);
    expect(html).toMatch(/class="block break-words text-base font-medium"/);
    expect(html).not.toContain(OWN_SECRET);
  });

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

  test("без prioritizeViewer порядок строк сохраняет порядок DTO и не мутирует его", () => {
    const hints = playingHints();
    const html = renderToString(<HintList viewerPlayerId={VIEWER_ID} hints={hints} />);
    expect(html.indexOf("радуга")).toBeLessThan(html.indexOf("вам"));
    expect(hints.map((item) => item.assignmentId)).toEqual(["a1", "a2", "a3"]);
  });

  test("prioritizeViewer поднимает строки зрителя первыми, стабильно и без мутации DTO", () => {
    const hints = playingHints();
    const html = renderToString(
      <HintList viewerPlayerId={VIEWER_ID} hints={hints} prioritizeViewer />,
    );
    expect(html.indexOf("вам")).toBeLessThan(html.indexOf("радуга"));
    expect(html.indexOf("компас")).toBeLessThan(html.indexOf("радуга"));
    expect(hints.map((item) => item.assignmentId)).toEqual(["a1", "a2", "a3"]);
    expect(html).not.toContain(OWN_SECRET);
  });

  test("prioritizeViewer: скрытое слово зрителя — warning-фон, Lock и «Ваше слово скрыто»", () => {
    const html = renderToString(
      <HintList viewerPlayerId={VIEWER_ID} hints={playingHints()} prioritizeViewer />,
    );
    expect(html).toContain("Ваше слово скрыто");
    expect(html).toContain("lucide-lock");
    expect(html).toContain("bg-warning");
    expect(html).not.toContain(OWN_SECRET);
  });

  test("prioritizeViewer: раскрытое слово зрителя показано, warning-состояния нет", () => {
    const hints = playingHints().map((item) =>
      item.assignmentId === "a3" ? { ...item, word: OWN_SECRET, wordHidden: false } : item,
    );
    const html = renderToString(
      <HintList viewerPlayerId={VIEWER_ID} hints={hints} prioritizeViewer />,
    );
    expect(html).toContain(OWN_SECRET);
    expect(html).not.toContain("Ваше слово скрыто");
    expect(html).not.toContain("bg-warning");
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

  test("не угадавший видит «Я угадал» в success-варианте с подтверждающим диалогом", () => {
    const html = renderPlayingRoom(playingState());
    expect(html).toContain("Я угадал");
    expect(html).toContain("bg-success");
    expect(html).toMatch(/aria-haspopup="dialog"/);
  });

  test("угадавший становится зрителем: success-карточка без повторного угадывания", () => {
    const players = baseState("PLAYING").players.map((player) =>
      player.id === VIEWER_ID ? { ...player, hasGuessed: true } : player,
    );
    const html = renderPlayingRoom(playingState({}, players));
    expect(html).toContain("Вы угадали");
    expect(html).toContain("bg-success");
    expect(html).not.toContain("Я угадал");
    expect(html).toContain("радуга");
  });

  test("прогресс угадавших считается по hasGuessed всех участников", () => {
    const players = baseState("PLAYING").players.map((player) =>
      player.id === "p2" ? { ...player, hasGuessed: true } : player,
    );
    const html = renderPlayingRoom(playingState({}, players));
    expect(html).toContain("Угадали 1 из 3");
  });

  test("секрет собственного слова отсутствует в разметке целиком", () => {
    const html = renderPlayingRoom(playingState());
    expect(html).not.toContain(OWN_SECRET);
    expect(html).toContain("Ваше слово скрыто");
    expect(html.indexOf("вам")).toBeLessThan(html.indexOf("радуга"));
  });

  test("хост видит досрочное завершение с подтверждением, не-хост — нет", () => {
    const host = renderPlayingRoom(playingState({ canFinish: true }));
    expect(host).toContain("Завершить игру");
    expect(host).toMatch(/aria-haspopup="dialog"/);

    const guest = renderPlayingRoom(playingState({ canFinish: false }));
    expect(guest).not.toContain("Завершить игру");
  });

  test("досрочное завершение — деструктивная зона ниже подсказок", () => {
    const html = renderPlayingRoom(playingState({ canFinish: true }));
    expect(html.indexOf("Завершить игру")).toBeGreaterThan(html.indexOf("Подсказки"));
    expect(html).toContain("border-destructive");
  });

  test("pending блокирует «Я угадал» и завершение", () => {
    const html = renderPlayingRoom(playingState({ canFinish: true }), true);
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("FinalResults", () => {
  function finishedState(
    results: ResultItem[],
    capabilities: Partial<GameStateResponse["capabilities"]> = {},
  ): GameStateResponse {
    const state = baseState("FINISHED");
    state.results = results;
    state.hints = playingHints().map((item) =>
      item.wordHidden ? { ...item, word: OWN_SECRET, wordHidden: false } : item,
    );
    state.capabilities = {
      ...state.capabilities,
      canRestart: false,
      canLeave: true,
      ...capabilities,
    };
    return state;
  }

  function renderFinal(
    state: GameStateResponse,
    overrides: Partial<
      Pick<FinalResultsProps, "mutationPending" | "onRestart" | "onLeave">
    > = {},
  ) {
    return renderToString(
      <FinalResults
        state={state}
        mutationPending={overrides.mutationPending ?? false}
        onRestart={overrides.onRestart ?? (() => Promise.resolve())}
        onLeave={overrides.onLeave ?? (() => Promise.resolve())}
      />,
    );
  }

  test("строки: место, имя, время или прочерк, очки с accessible label", () => {
    const html = renderFinal(
      finishedState([
        result({ playerId: "p1", name: "Маша", place: 1, score: 3, durationMs: 65_000 }),
        result({ playerId: "p2", name: "Петя", place: null, score: 0, durationMs: null }),
      ]),
    );
    expect(html).toContain("Игра завершена");
    expect(html).toContain("Результаты");
    expect(html).toContain("1 место");
    expect(html).toContain("Маша");
    expect(html).toContain("1:05");
    expect(html).toContain('aria-label="Очки: 3"');
    expect(html).toContain("Не угадал");
    expect(html).toContain('aria-label="Очки: 0"');
  });

  test("не угадавшие идут после занявших места", () => {
    const html = renderFinal(
      finishedState([
        result({ playerId: "p1", name: "Маша", place: 1, score: 3, durationMs: 65_000 }),
        result({ playerId: "p3", name: "Оля", place: 2, score: 2, durationMs: 90_000 }),
        result({ playerId: "p2", name: "Петя", place: null, score: 0, durationMs: null }),
      ]),
    );
    expect(html.indexOf("1 место")).toBeLessThan(html.indexOf("2 место"));
    expect(html.indexOf("2 место")).toBeLessThan(html.indexOf("Не угадал"));
  });

  test("победитель с place = 1 выделен иконкой кубка, без победителя блок скрыт", () => {
    const withWinner = renderFinal(
      finishedState([
        result({ playerId: "p1", name: "Маша", place: 1, score: 3, durationMs: 65_000 }),
        result({ playerId: "p2", name: "Петя", place: 2, score: 2, durationMs: 80_000 }),
      ]),
    );
    expect(withWinner).toContain("Победитель");
    expect(withWinner).toContain("lucide-trophy");
    expect(withWinner).toContain("bg-amber-50 py-0");
    expect(withWinner).toContain("gap-3 py-3");
    expect(withWinner).not.toContain("pt-6");
    expect(withWinner).toMatch(/>Вы</);
    expect(withWinner).not.toContain("(вы)");

    const noWinner = renderFinal(
      finishedState([
        result({ playerId: "p1", name: "Маша", place: null, score: 0, durationMs: null }),
        result({ playerId: "p2", name: "Петя", place: null, score: 0, durationMs: null }),
      ]),
    );
    expect(noWinner).toContain("Игра завершена");
    expect(noWinner).not.toContain("Победитель");
    expect(noWinner).not.toContain("lucide-trophy");
  });

  test("хост видит рестарт с подтверждением, действия выше рейтинга, выход доступен", () => {
    const html = renderFinal(
      finishedState(
        [
          result({ playerId: "p1", name: "Маша", place: 1, score: 3, durationMs: 65_000 }),
        ],
        { canRestart: true },
      ),
    );
    expect(html).toContain("Сыграть ещё с этим составом");
    expect(html).toMatch(/aria-haspopup="dialog"/);
    expect(html.indexOf("Сыграть ещё с этим составом")).toBeLessThan(
      html.indexOf("Результаты"),
    );
    expect(html).toContain("В главное меню");
  });

  test("не-хост вместо рестарта видит пояснение хоста и выход в главное меню", () => {
    const html = renderFinal(
      finishedState(
        [
          result({ playerId: "p1", name: "Маша", place: 1, score: 3, durationMs: 65_000 }),
        ],
        { canRestart: false },
      ),
    );
    expect(html).not.toContain("Сыграть ещё с этим составом");
    expect(html).toContain("Хост может вернуть всех в лобби для нового раунда");
    expect(html).toContain("В главное меню");
  });

  test("строка зрителя выделена primary-рамкой и бейджем «Вы», топ-3 — мягкие акценты", () => {
    const html = renderFinal(
      finishedState([
        result({ playerId: "p2", name: "Петя", place: 1, score: 3, durationMs: 65_000 }),
        result({ playerId: VIEWER_ID, name: "Маша", place: 2, score: 2, durationMs: 80_000 }),
        result({ playerId: "p3", name: "Оля", place: 3, score: 1, durationMs: 90_000 }),
      ]),
    );
    expect(html).toContain("border-primary");
    expect(html).toMatch(/>Вы</);
    expect(html).toContain("bg-amber-100");
    expect(html).toContain("bg-slate-200");
    expect(html).toContain("bg-orange-100");
  });

  test("pending блокирует рестарт и выход", () => {
    const html = renderFinal(
      finishedState(
        [result({ playerId: "p1", name: "Маша", place: 1, score: 3, durationMs: null })],
        { canRestart: true },
      ),
      { mutationPending: true },
    );
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("ниже рейтинга показаны все назначения и слова в исходном порядке", () => {
    const html = renderFinal(
      finishedState([
        result({ playerId: "p1", name: "Маша", place: 1, score: 3, durationMs: 65_000 }),
      ]),
    );
    expect(html.indexOf("Результаты")).toBeLessThan(html.indexOf("Все слова"));
    expect(html).toContain(OWN_SECRET);
    expect(html).toContain("радуга");
    expect(html.indexOf("компас")).toBeLessThan(html.indexOf("радуга"));
    expect(html.indexOf("радуга")).toBeLessThan(html.indexOf(OWN_SECRET));
  });

  test("рейтинг — не таблица, нет горизонтального скролла", () => {
    const html = renderFinal(
      finishedState([
        result({ playerId: "p1", name: "Маша", place: 1, score: 3, durationMs: null }),
      ]),
    );
    expect(html).not.toContain("<table");
    expect(html).not.toContain("overflow-x");
  });

  test("прочерк вместо времени у не угадавшего", () => {
    const html = renderFinal(
      finishedState([
        result({ playerId: "p2", name: "Петя", place: null, score: 0, durationMs: null }),
      ]),
    );
    expect(html).toContain("—");
  });
});
