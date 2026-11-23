import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import type { GameStateResponse } from "../../shared/contracts/game";
import { API_PREFIX } from "./helpers";
import { apiAs, createLobbyApi, openIndependentContexts } from "./acceptance-helpers";

// Browser-acceptance нового повторного раунда и выхода после FINISHED
// (спецификация 2026-11-23-friendly-ui-and-rematch-design, раздел 10).
// Ровно четыре независимых браузерных контекста на сценарий: отдельные
// cookie-хранилища, ни одна страница не читает чужую сессию.
//
// Сценарий A: полный раунд → хост подтверждает «Сыграть ещё с этим составом»
// → все четверо в том же лобби без готовности/слов/результатов → один гость
// выходит и подключается к другой существующей комнате, второй выходит домой
// (состав падает до двух, поэтому <3 блокирует старт) → новый игрок входит по
// прежнему коду → повторный раунд доходит до PLAYING с чистым состоянием.
//
// Сценарий B: свежая комната → досрочное завершение → гость выходит прямо из
// FINISHED (остальные в LOBBY без слов/результатов, гость на главной) →
// повторный раунд в той же комнате → выход хоста из FINISHED передаёт роль
// оставшемуся раньше всех участнику по (joinedAt, id).
//
// UI-проходы здесь намеренно локальные: они следуют новому тексту интерфейса
// («Создать комнату», #ready-button, «Игра завершена»), а не селекторам из
// acceptance-helpers.

const WORD_SETUP_HEADING = /Загадайте слово для игрока:|Введите загаданное слово/u;

const RESTART_TITLE = "Новый раунд с этим составом?";
const RESTART_DESCRIPTION =
  "Слова и результаты этого раунда будут удалены. Участники, код комнаты и настройки сохранятся.";
const FINAL_LEAVE_TITLE = "Выйти в главное меню?";
const FINAL_LEAVE_DESCRIPTION =
  "Вы покинете комнату. Остальные участники вернутся в лобби, а результаты этого раунда будут очищены.";
const LOBBY_LEAVE_TITLE = "Выйти из игры?";
const LOBBY_LEAVE_DESCRIPTION = "Вы покинете комнату и вернётесь на главную страницу.";

const ROUND_ONE_WORDS = ["пирамида", "ракета", "телескоп", "барабан"] as const;
const ROUND_TWO_WORDS = ["компас", "фонарь", "глобус"] as const;
const B_FIRST_WORDS = ["гармошка", "подкова", "ежевика", "самовар"] as const;
const B_SECOND_WORDS = ["атлас", "бинокль", "вертолёт"] as const;

function pageOf(pages: readonly Page[], names: readonly string[], name: string): Page {
  const index = names.indexOf(name);
  if (index === -1) throw new Error(`нет страницы для участника ${name}`);
  const page = pages[index];
  if (page === undefined) throw new Error(`страница участника ${name} отсутствует`);
  return page;
}

function playerRow(page: Page, name: string) {
  return page.getByRole("listitem").filter({ hasText: name });
}

// --- UI-проходы production-экранов (новый текст интерфейса) -----------------

async function createRoomViaHome(page: Page, name: string): Promise<string> {
  await page.goto("/");
  await page.locator("#player-name").fill(name);
  await page.getByRole("button", { name: "Создать комнату" }).click();
  await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
  const code = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u);
  return code;
}

async function joinRoomViaInvitePage(page: Page, code: string, name: string): Promise<void> {
  await page.goto(`/game/${code}`);
  await expect(page.locator("#join-code")).toHaveValue(code);
  await page.locator("#join-name").fill(name);
  await page.getByRole("button", { name: "Подключиться" }).click();
  await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
}

async function joinRoomViaHome(page: Page, code: string, name: string): Promise<void> {
  await page.goto("/");
  await page.locator("#player-name").fill(name);
  await page.locator("#join-code").fill(code);
  await page.getByRole("button", { name: "Подключиться" }).click();
  await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
}

async function markReady(page: Page): Promise<void> {
  await page.locator("#ready-button").click();
  await expect(page.locator("#ready-button")).toHaveText("Вы готовы");
}

async function readyAll(pages: readonly Page[]): Promise<void> {
  for (const page of pages) {
    await markReady(page);
  }
}

async function startRound(hostPage: Page, allPages: readonly Page[]): Promise<void> {
  await hostPage.getByRole("button", { name: "Начать игру" }).click();
  for (const page of allPages) {
    await expect(page.getByRole("heading", { name: WORD_SETUP_HEADING })).toBeVisible();
  }
}

// Каждый участник по очереди вводит слово; последнее отсутствующее слово
// атомарно переводит всю комнату в PLAYING.
async function submitWordsRound(pages: readonly Page[], words: readonly string[]): Promise<void> {
  expect(words).toHaveLength(pages.length);
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const word = words[index];
    if (word === undefined) throw new Error(`нет слова для индекса ${index}`);
    await page.locator("#word-input").fill(word);
    await page.getByRole("button", { name: "Сохранить слово" }).click();
    if (index === pages.length - 1) {
      for (const all of pages) {
        await expect(all.getByRole("heading", { name: "Игра идёт" })).toBeVisible();
      }
    } else {
      await expect(
        page
          .locator("header")
          .getByText(`Слова сохранены: ${index + 1} из ${words.length}`, { exact: true }),
      ).toBeVisible();
    }
  }
}

async function guessOwnWord(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Я угадал" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Я угадал" })
    .click();
  // Обычно следует экран зрителя («Теперь вы зритель: …»); последнее
  // угадывание сразу завершает игру.
  await expect(
    page
      .getByText("Теперь вы зритель")
      .or(page.getByRole("heading", { name: "Игра завершена" })),
  ).toBeVisible();
}

async function finishEarlyViaUi(hostPage: Page, allPages: readonly Page[]): Promise<void> {
  await hostPage.getByRole("button", { name: "Завершить игру" }).click();
  const dialog = hostPage.getByRole("alertdialog");
  await expect(dialog).toContainText(
    "Уже угадавшие сохранят места и очки. Остальные получат 0 очков без места.",
  );
  await dialog.getByRole("button", { name: "Завершить игру" }).click();
  for (const page of allPages) {
    await expect(page.getByRole("heading", { name: "Игра завершена" })).toBeVisible();
  }
}

// Выход через диалог подтверждения; успех — только навигация на главную.
async function leaveRoomViaUi(
  page: Page,
  triggerName: string,
  title: string,
  description: string,
  actionName: string,
): Promise<void> {
  await page.getByRole("button", { name: triggerName }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: title })).toBeVisible();
  await expect(dialog).toContainText(description);
  await dialog.getByRole("button", { name: actionName }).click();
  await expect(page.getByRole("heading", { name: "Создать комнату" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Подключиться по коду" })).toBeVisible();
  expect(new URL(page.url()).pathname, "гость должен оказаться на главной").toBe("/");
}

async function expectNoRoundArtifacts(page: Page, words: readonly string[]): Promise<void> {
  await expect(page.getByRole("heading", { name: "Результаты" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Все слова" })).toHaveCount(0);
  for (const word of words) {
    await expect(page.locator("main")).not.toContainText(word);
  }
}

async function expectFinalRanking(
  page: Page,
  expected: ReadonlyArray<{ place: number; name: string; score: number }>,
): Promise<void> {
  // Рейтинг живёт в собственной секции с heading «Результаты»; скоупим
  // строки к ней, чтобы на странице не было посторонних ol > li.
  const resultsSection = page.locator("section", {
    has: page.getByRole("heading", { name: "Результаты" }),
  });
  const rows = resultsSection.locator("ol > li");
  await expect(rows).toHaveCount(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    const item = expected[index];
    if (item === undefined) throw new Error(`нет ожидаемой строки для индекса ${index}`);
    const row = rows.nth(index);
    await expect(row).toContainText(`${item.place} место`);
    await expect(row).toContainText(item.name);
    await expect(row.locator(`[aria-label="Очки: ${item.score}"]`)).toBeVisible();
  }
}

// --- Авторизованные проекции через cookie браузерных контекстов -------------

async function fetchState(context: BrowserContext, code: string): Promise<GameStateResponse> {
  const api = await apiAs(context);
  const response = await api.get(`${API_PREFIX}/${code}/state`);
  expect(response.status(), `/state для комнаты ${code}`).toBe(200);
  return (await response.json()) as GameStateResponse;
}

async function expectCleanLobbyState(context: BrowserContext, code: string): Promise<void> {
  const state = await fetchState(context, code);
  expect(state.game.phase, "после сброса комната в LOBBY").toBe("LOBBY");
  expect(state.setup, "setup пустой").toBeNull();
  expect(state.hints, "hints пустой").toBeNull();
  expect(state.results, "results пустой").toBeNull();
  expect(
    state.players.every(
      (player) => !player.isReady && !player.hasSubmittedWord && !player.hasGuessed,
    ),
    "готовность и флаги раунда сброшены у всех игроков",
  ).toBe(true);
  expect(state.capabilities.canRestart, "canRestart false вне FINISHED").toBe(false);
  expect(state.capabilities.canLeave, "canLeave true в LOBBY").toBe(true);
}

async function openFour(browser: Browser): Promise<{
  contexts: BrowserContext[];
  pages: Page[];
  consoleErrors: string[];
  close: () => Promise<void>;
}> {
  const names = ["Маша", "Петя", "Ваня", "Саша"];
  const independent = await openIndependentContexts(browser, names);
  return {
    contexts: independent.contexts,
    pages: independent.pages,
    consoleErrors: independent.consoleErrors,
    close: independent.close,
  };
}

// --- Сценарий A --------------------------------------------------------------

test("rematch: хост возвращает FINISHED в лобби, состав меняется, второй раунд чистый", async ({
  browser,
}) => {
  test.slow();
  const { contexts, pages, consoleErrors, close } = await openFour(browser);
  const masha = pageOf(pages, ["Маша", "Петя", "Ваня", "Саша"], "Маша");
  const petya = pageOf(pages, ["Маша", "Петя", "Ваня", "Саша"], "Петя");
  const vanya = pageOf(pages, ["Маша", "Петя", "Ваня", "Саша"], "Ваня");
  const sasha = pageOf(pages, ["Маша", "Петя", "Ваня", "Саша"], "Саша");
  try {
    // Другая существующая комната (только API-личность Оли): к ней позже
    // подключится вышедший гость.
    const otherRoom = await createLobbyApi(["Оля"]);

    // 1. Полный раунд четырёх независимых контекстов до FINISHED.
    const code = await createRoomViaHome(masha, "Маша");
    await joinRoomViaInvitePage(petya, code, "Петя");
    await joinRoomViaInvitePage(vanya, code, "Ваня");
    await joinRoomViaInvitePage(sasha, code, "Саша");
    await expect(masha.getByText("Участники (4/12)", { exact: true })).toBeVisible();

    await readyAll([masha, petya, vanya, sasha]);
    await expect(masha.getByText("Готов", { exact: true })).toHaveCount(4);
    await expect(masha.getByRole("button", { name: "Начать игру" })).toBeEnabled();
    await expect(petya.getByText("Ждём начала игры хостом")).toBeVisible();
    await expect(sasha.getByRole("button", { name: "Начать игру" })).toHaveCount(0);

    await startRound(masha, [masha, petya, vanya, sasha]);
    await submitWordsRound([masha, petya, vanya, sasha], ROUND_ONE_WORDS);
    await expect(masha.getByText("Угадали 0 из 4", { exact: true })).toBeVisible();

    await guessOwnWord(masha);
    await expect(petya.getByText("Угадали 1 из 4", { exact: true })).toBeVisible();
    await guessOwnWord(petya);
    await guessOwnWord(vanya);
    await guessOwnWord(sasha);
    for (const page of [masha, petya, vanya, sasha]) {
      await expect(page.getByRole("heading", { name: "Игра завершена" })).toBeVisible();
    }

    // Финал раскрывает слова и показывает рейтинг 1–4 места.
    await expect(masha.getByText("Победитель")).toBeVisible();
    await expectFinalRanking(masha, [
      { place: 1, name: "Маша", score: 4 },
      { place: 2, name: "Петя", score: 3 },
      { place: 3, name: "Ваня", score: 2 },
      { place: 4, name: "Саша", score: 1 },
    ]);
    await expect(masha.getByRole("heading", { name: "Все слова" })).toBeVisible();
    for (const word of ROUND_ONE_WORDS) {
      await expect(masha.locator("main")).toContainText(word);
    }

    // 2. Capabilities на FINISHED: хост видит rematch, гость — пояснение,
    // «В главное меню» есть у всех; серверная проекция повторяет то же.
    await expect(masha.getByRole("button", { name: "Сыграть ещё с этим составом" })).toBeVisible();
    await expect(sasha.getByRole("button", { name: "Сыграть ещё с этим составом" })).toHaveCount(0);
    await expect(
      sasha.getByText("Хост может вернуть всех в лобби для нового раунда."),
    ).toBeVisible();
    for (const page of [masha, petya, vanya, sasha]) {
      await expect(page.getByRole("button", { name: "В главное меню" })).toBeVisible();
    }
    const hostContext = contexts[0];
    const guestContext = contexts[3];
    if (hostContext === undefined || guestContext === undefined) {
      throw new Error("контексты участников отсутствуют");
    }
    const finishedState = await fetchState(hostContext, code);
    expect(finishedState.capabilities.canRestart, "canRestart хоста в FINISHED").toBe(true);
    expect(finishedState.capabilities.canLeave, "canLeave хоста в FINISHED").toBe(true);
    const finishedGuest = await fetchState(guestContext, code);
    expect(finishedGuest.capabilities.canRestart, "canRestart гостя в FINISHED").toBe(false);
    expect(finishedGuest.capabilities.canLeave, "canLeave гостя в FINISHED").toBe(true);

    // 3. Хост подтверждает новый раунд; диалог называет удаление слов/результатов.
    await masha.getByRole("button", { name: "Сыграть ещё с этим составом" }).click();
    const restartDialog = masha.getByRole("alertdialog");
    await expect(restartDialog.getByRole("heading", { name: RESTART_TITLE })).toBeVisible();
    await expect(restartDialog).toContainText(RESTART_DESCRIPTION);
    await restartDialog.getByRole("button", { name: "Сыграть ещё с этим составом" }).click();

    // Все четверо видят то же лобби: тот же код, неготовый состав, никаких
    // слов и результатов предыдущего раунда.
    for (const page of [masha, petya, vanya, sasha]) {
      await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
      expect(new URL(page.url()).pathname, "тот же код комнаты").toBe(`/game/${code}`);
      await expect(page.getByText("Участники (4/12)", { exact: true })).toBeVisible();
      await expect(page.getByText("Пока не готов", { exact: true })).toHaveCount(4);
      await expect(page.locator("#ready-button")).toHaveText("Я готов");
      await expect(playerRow(page, "Маша")).toContainText("Хост");
      await expect(page.getByRole("button", { name: "Сыграть ещё с этим составом" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Выйти из игры" })).toBeVisible();
      await expectNoRoundArtifacts(page, ROUND_ONE_WORDS);
    }
    const restarted = await fetchState(hostContext, code);
    expect(restarted.game.revision, "ровно одна новая ревизия после restart").toBe(
      finishedState.game.revision + 1,
    );
    await expectCleanLobbyState(hostContext, code);

    // 4. Гость Саша выходит из лобби и подключается к другой существующей
    // комнате; оставшиеся видят его удаление.
    await leaveRoomViaUi(sasha, "Выйти из игры", LOBBY_LEAVE_TITLE, LOBBY_LEAVE_DESCRIPTION, "Выйти");
    await expect(masha.getByText("Участники (3/12)", { exact: true })).toBeVisible();
    await expect(playerRow(masha, "Саша")).toHaveCount(0);

    await joinRoomViaHome(sasha, otherRoom.code, "Саша");
    expect(new URL(sasha.url()).pathname, "Саша в другой комнате").toBe(
      `/game/${otherRoom.code}`,
    );
    await expect(sasha.getByText("Участники (2/12)", { exact: true })).toBeVisible();
    await expect(playerRow(sasha, "Оля")).toBeVisible();
    await expect(playerRow(sasha, "Маша")).toHaveCount(0);

    // 5. Ваня выходит — состав падает до двух; старт блокируется <3 с понятной
    // причиной, гостевых старт-контролов нет.
    await leaveRoomViaUi(vanya, "Выйти из игры", LOBBY_LEAVE_TITLE, LOBBY_LEAVE_DESCRIPTION, "Выйти");
    await expect(masha.getByText("Участники (2/12)", { exact: true })).toBeVisible();
    await expect(playerRow(masha, "Ваня")).toHaveCount(0);
    await expect(masha.getByRole("button", { name: "Начать игру" })).toBeDisabled();
    await expect(masha.getByText("Для старта нужно минимум 3 участника")).toBeVisible();
    await expect(petya.getByRole("button", { name: "Начать игру" })).toHaveCount(0);

    // 6. Новый игрок входит по прежнему коду (тот же браузерный контекст, но
    // cookie выхода уничтожена — вход создаёт нового игрока с новым именем).
    await joinRoomViaHome(vanya, code, "Дима");
    await expect(masha.getByText("Участники (3/12)", { exact: true })).toBeVisible();
    await expect(playerRow(masha, "Дима")).toBeVisible();

    // 7. Повторный раунд: чистый ввод слов, PLAYING без артефактов первого раунда.
    await readyAll([masha, petya, vanya]);
    await startRound(masha, [masha, petya, vanya]);
    for (const page of [masha, petya, vanya]) {
      await expect(
        page.locator("header").getByText("Слова сохранены: 0 из 3", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Ждём слово", { exact: true })).toHaveCount(3);
      await expectNoRoundArtifacts(page, ROUND_ONE_WORDS);
    }
    await submitWordsRound([masha, petya, vanya], ROUND_TWO_WORDS);
    for (const page of [masha, petya, vanya]) {
      await expect(page.getByText("Угадали 0 из 3", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Игра завершена" })).toHaveCount(0);
      for (const word of ROUND_ONE_WORDS) {
        await expect(page.locator("main")).not.toContainText(word);
      }
    }

    expect(consoleErrors).toEqual([]);
  } finally {
    await close();
  }
});

// --- Сценарий B --------------------------------------------------------------

test("rematch: выход гостя и хоста прямо из FINISHED возвращает остальных в лобби", async ({
  browser,
}) => {
  test.slow();
  const { pages, consoleErrors, close } = await openFour(browser);
  const masha = pageOf(pages, ["Маша", "Петя", "Ваня", "Саша"], "Маша");
  const petya = pageOf(pages, ["Маша", "Петя", "Ваня", "Саша"], "Петя");
  const vanya = pageOf(pages, ["Маша", "Петя", "Ваня", "Саша"], "Ваня");
  const sasha = pageOf(pages, ["Маша", "Петя", "Ваня", "Саша"], "Саша");
  try {
    // 1. Свежая комната, досрочное завершение до FINISHED.
    const code = await createRoomViaHome(masha, "Маша");
    await joinRoomViaInvitePage(petya, code, "Петя");
    await joinRoomViaInvitePage(vanya, code, "Ваня");
    await joinRoomViaInvitePage(sasha, code, "Саша");
    await readyAll([masha, petya, vanya, sasha]);
    await startRound(masha, [masha, petya, vanya, sasha]);
    await submitWordsRound([masha, petya, vanya, sasha], B_FIRST_WORDS);
    await finishEarlyViaUi(masha, [masha, petya, vanya, sasha]);

    // Досрочное завершение без угадавших: победитель не показывается.
    await expect(masha.getByText("Победитель")).toHaveCount(0);
    await expect(masha.getByText("Не угадал", { exact: true })).toHaveCount(4);
    await expect(masha.getByRole("heading", { name: "Все слова" })).toBeVisible();

    // 2. Гость выходит прямо из FINISHED: попадает на главную, остальные
    // автоматически получают лобби без слов и результатов.
    await leaveRoomViaUi(
      sasha,
      "В главное меню",
      FINAL_LEAVE_TITLE,
      FINAL_LEAVE_DESCRIPTION,
      "В главное меню",
    );
    for (const page of [masha, petya, vanya]) {
      await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
      expect(new URL(page.url()).pathname, "тот же код комнаты").toBe(`/game/${code}`);
      await expect(page.getByText("Участники (3/12)", { exact: true })).toBeVisible();
      await expect(page.getByText("Пока не готов", { exact: true })).toHaveCount(3);
      await expect(playerRow(page, "Саша")).toHaveCount(0);
      await expectNoRoundArtifacts(page, B_FIRST_WORDS);
    }

    // 3. В той же комнате — повторный раунд до FINISHED, затем выход хоста.
    await readyAll([masha, petya, vanya]);
    await startRound(masha, [masha, petya, vanya]);
    await submitWordsRound([masha, petya, vanya], B_SECOND_WORDS);
    await finishEarlyViaUi(masha, [masha, petya, vanya]);

    // 4. Хост выходит из FINISHED — роль передаётся Пете (раньше всех вошёл
    // после хоста), Ваня видит нового хоста без перезагрузки.
    await leaveRoomViaUi(
      masha,
      "В главное меню",
      FINAL_LEAVE_TITLE,
      FINAL_LEAVE_DESCRIPTION,
      "В главное меню",
    );
    for (const page of [petya, vanya]) {
      await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
      await expect(page.getByText("Участники (2/12)", { exact: true })).toBeVisible();
      await expect(page.getByText("Пока не готов", { exact: true })).toHaveCount(2);
      await expect(playerRow(page, "Маша")).toHaveCount(0);
      await expect(playerRow(page, "Петя")).toContainText("Хост");
      await expectNoRoundArtifacts(page, B_SECOND_WORDS);
    }
    // Хост-контролы переехали к Пете, у Вани их нет.
    await expect(petya.getByRole("button", { name: "Начать игру" })).toBeVisible();
    await expect(vanya.getByRole("button", { name: "Начать игру" })).toHaveCount(0);
    await expect(petya.getByRole("button", { name: "Выйти из игры" })).toBeVisible();

    expect(consoleErrors).toEqual([]);
  } finally {
    await close();
  }
});
