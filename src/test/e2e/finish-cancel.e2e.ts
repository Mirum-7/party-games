import { expect, test } from "@playwright/test";

import {
  API_PREFIX,
  createLobbyOfThree,
  expectApiError,
  getStateViaApi,
  originHeaders,
  startAssigningWords,
} from "./helpers";
import {
  apiAs,
  createGameViaUi,
  finishGameViaUi,
  guessViaUi,
  joinViaUi,
  openIndependentContexts,
  setReadyViaUi,
  startGameViaUi,
  submitWordViaUi,
  submitWordsApi,
} from "./acceptance-helpers";

// Acceptance: досрочное завершение и отмена попытки на production-стеке через
// независимые браузерные контексты. Проверяются точные места, очки, время,
// сортировка не угадавших, сброс попытки при отмене и сохранение хоста,
// участников и настроек.

test("досрочное завершение: угадавшие сохраняют место, время и очки; остальные «Не угадал» с 0 очками после занявших места", async ({
  browser,
}) => {
  const names = ["Маша", "Петя", "Ваня", "Саша"] as const;
  const words = ["самолёт", "ракета", "телескоп", "барабан"] as const;
  const { contexts, pages, consoleErrors, close } = await openIndependentContexts(browser, names);
  const [mashaPage, petePage, vanyaPage, sashaPage] = pages;

  try {
    const code = await createGameViaUi(mashaPage, "Маша");
    await joinViaUi(petePage, code, "Петя");
    await joinViaUi(vanyaPage, code, "Ваня");
    await joinViaUi(sashaPage, code, "Саша");
    await expect(mashaPage.getByText("Участники (4/12)")).toBeVisible();

    for (const page of pages) await setReadyViaUi(page);
    await startGameViaUi(mashaPage);
    for (let index = 0; index < pages.length; index += 1) {
      await submitWordViaUi(pages[index], words[index], index === pages.length - 1);
    }
    for (const page of pages) {
      await expect(page.getByRole("heading", { name: "Игра идёт" })).toBeVisible();
    }

    // Контроль досрочного завершения есть только у админа: у остальных игроков
    // его нет в интерфейсе (а серверный запрос ниже отклоняется с 403).
    await expect(mashaPage.getByRole("button", { name: "Завершить игру" })).toBeVisible();
    for (const page of [petePage, vanyaPage, sashaPage]) {
      await expect(page.getByRole("button", { name: "Завершить игру" })).toHaveCount(0);
    }

    // Известное подмножество угадавших: Петя первый, Ваня второй.
    await guessViaUi(petePage);
    await guessViaUi(vanyaPage);

    const mashaApi = await apiAs(contexts[0]);
    const before = await getStateViaApi(mashaApi, code);
    expect(before.state.game.phase).toBe("PLAYING");
    const revisionBeforeFinish = before.state.game.revision;

    await finishGameViaUi(mashaPage, pages);

    // Финальная таблица на экране админа: места 1–2 с очками 4–3, затем
    // не угадавшие «Не угадал» с 0 очками, без места и без времени.
    const rows = mashaPage.locator("ol > li");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("1 место");
    await expect(rows.nth(0)).toContainText("Петя");
    await expect(rows.nth(0)).toContainText("Очки: 4");
    await expect(rows.nth(1)).toContainText("2 место");
    await expect(rows.nth(1)).toContainText("Ваня");
    await expect(rows.nth(1)).toContainText("Очки: 3");
    await expect(rows.nth(2)).toContainText("Не угадал");
    await expect(rows.nth(2)).toContainText("Маша");
    await expect(rows.nth(2)).toContainText("Очки: 0");
    await expect(rows.nth(3)).toContainText("Не угадал");
    await expect(rows.nth(3)).toContainText("Саша");
    await expect(rows.nth(3)).toContainText("Очки: 0");
    // У не угадавших время отсутствует (прочерк), у угадавших присутствует
    // как отформатированная длительность «MM:SS».
    await expect(rows.nth(0)).not.toContainText("—");
    await expect(rows.nth(2)).toContainText("—");

    // Те же факты в персональном DTO: место/время/очки угадавших зафиксированы,
    // не угадавшие идут после них по (normalizedName, id): «маша» < «саша».
    const after = await getStateViaApi(mashaApi, code);
    expect(after.state.game.phase).toBe("FINISHED");
    expect(after.state.game.revision).toBeGreaterThan(revisionBeforeFinish);
    expect(after.state.game.startedAt).toBeTruthy();
    expect(after.state.game.finishedAt).toBeTruthy();
    const results = after.state.results ?? [];
    expect(results.map((result) => result.name)).toEqual(["Петя", "Ваня", "Маша", "Саша"]);
    expect(results[0]).toMatchObject({ playerId: expect.any(String), place: 1, score: 4 });
    expect(results[1]).toMatchObject({ place: 2, score: 3 });
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(results[1].durationMs).toBeGreaterThanOrEqual(0);
    for (const unplaced of [results[2], results[3]]) {
      expect(unplaced.place).toBeNull();
      expect(unplaced.score).toBe(0);
      expect(unplaced.durationMs).toBeNull();
    }
    expect(consoleErrors).toEqual([]);
  } finally {
    await close();
  }
});

test("отмена ввода слов: слова и готовность сброшены, хост/участники/настройки сохранены, ревизия растёт, повторный запуск доходит до PLAYING", async ({
  browser,
}) => {
  const names = ["Маша", "Петя", "Ваня", "Саша"] as const;
  const { contexts, pages, consoleErrors, close } = await openIndependentContexts(browser, names);
  const [mashaPage, petePage, vanyaPage, sashaPage] = pages;

  try {
    const code = await createGameViaUi(mashaPage, "Маша");
    await joinViaUi(petePage, code, "Петя");
    await joinViaUi(vanyaPage, code, "Ваня");
    await joinViaUi(sashaPage, code, "Саша");

    // Настройка админа, которую отмена обязана сохранить.
    await mashaPage.locator("#hide-targets-switch").click();
    await expect(mashaPage.locator("#hide-targets-switch")).toBeChecked();

    for (const page of pages) await setReadyViaUi(page);
    await startGameViaUi(mashaPage);
    for (const page of pages) {
      await expect(page.getByRole("heading", { name: /Загадай слово|Введи загаданное слово/u })).toBeVisible();
    }

    // Часть слов введена до отмены.
    await submitWordViaUi(mashaPage, "самолёт", false);
    await submitWordViaUi(petePage, "ракета", false);

    // Контроль отмены есть только у админа.
    await expect(mashaPage.getByRole("button", { name: "Отменить попытку" })).toBeVisible();
    for (const page of [petePage, vanyaPage, sashaPage]) {
      await expect(page.getByRole("button", { name: "Отменить попытку" })).toHaveCount(0);
    }

    const mashaApi = await apiAs(contexts[0]);
    const before = await getStateViaApi(mashaApi, code);
    expect(before.state.game.phase).toBe("ASSIGNING_WORDS");
    const revisionBeforeCancel = before.state.game.revision;

    // Админ сначала возвращается из диалога («Назад») — попытка продолжается.
    await mashaPage.getByRole("button", { name: "Отменить попытку" }).click();
    await mashaPage
      .getByRole("alertdialog")
      .getByRole("button", { name: "Назад" })
      .click();
    await expect(
      mashaPage.getByRole("heading", { name: /Загадай слово|Введи загаданное слово/u }),
    ).toBeVisible();
    await expect(mashaPage.locator("#word-input")).toHaveValue("самолёт");

    // Подтверждённая отмена возвращает всех в лобби.
    await mashaPage.getByRole("button", { name: "Отменить попытку" }).click();
    await mashaPage
      .getByRole("alertdialog")
      .getByRole("button", { name: "Отменить попытку" })
      .click();
    for (const page of pages) {
      await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
    }

    // Участники и хост сохранены, готовность сброшена, слов не осталось,
    // настройка скрытия адресатов на месте.
    await expect(mashaPage.getByText("Участники (4/12)")).toBeVisible();
    await expect(mashaPage.getByRole("listitem").filter({ hasText: "Маша" }).getByText("Хост")).toBeVisible();
    for (const name of ["Маша", "Петя", "Ваня", "Саша"]) {
      await expect(
        mashaPage.getByRole("listitem").filter({ hasText: name }).getByText("Не готов", { exact: true }),
      ).toBeVisible();
    }
    await expect(mashaPage.getByText("Слово загадано")).toHaveCount(0);
    await expect(mashaPage.locator("#hide-targets-switch")).toBeChecked();

    // Ревизия увеличилась (никогда не уменьшается), фаза и временные метки
    // попытки очищены, настройка сохранена.
    const after = await getStateViaApi(mashaApi, code);
    expect(after.state.game.phase).toBe("LOBBY");
    expect(after.state.game.revision).toBeGreaterThan(revisionBeforeCancel);
    expect(after.state.game.startedAt).toBeNull();
    expect(after.state.game.playingStartedAt).toBeNull();
    expect(after.state.game.finishedAt).toBeNull();
    expect(after.state.game.settings.hideTargetNamesDuringSetup).toBe(true);
    expect(after.state.setup).toBeNull();
    expect(after.state.hints).toBeNull();
    expect(after.state.results).toBeNull();
    expect(after.state.players.map((player) => player.name)).toEqual(["Маша", "Петя", "Ваня", "Саша"]);
    expect(after.state.players.every((player) => !player.isReady && !player.hasSubmittedWord)).toBe(true);
    expect(after.state.players.filter((player) => player.isHost)).toHaveLength(1);

    // Повторная попытка после общей готовности снова доходит до PLAYING,
    // при этом слова прежней попытки не восстанавливаются.
    for (const page of pages) await setReadyViaUi(page);
    await startGameViaUi(mashaPage);
    const restarted = await getStateViaApi(mashaApi, code);
    expect(restarted.state.game.revision).toBeGreaterThan(after.state.game.revision);
    expect(restarted.state.game.phase).toBe("ASSIGNING_WORDS");
    expect(restarted.state.setup?.word).toBeNull();
    expect(restarted.state.players.every((player) => !player.hasSubmittedWord)).toBe(true);
    for (let index = 0; index < pages.length; index += 1) {
      await submitWordViaUi(pages[index], ["поезд", "корабль", "гитара", "фонарь"][index], index === pages.length - 1);
    }
    for (const page of pages) {
      await expect(page.getByRole("heading", { name: "Игра идёт" })).toBeVisible();
    }

    expect(consoleErrors).toEqual([]);
  } finally {
    await close();
  }
});

test("прямые API: не-админ не может завершить игру или отменить попытку (403), состояние не меняется", async () => {
  const lobby = await createLobbyOfThree();
  await startAssigningWords(lobby);

  const cancel = await lobby.second.post(`${API_PREFIX}/${lobby.code}/cancel`, { headers: originHeaders });
  await expectApiError(cancel, 403, "FORBIDDEN");
  const stillAssigning = await getStateViaApi(lobby.host, lobby.code);
  expect(stillAssigning.state.game.phase).toBe("ASSIGNING_WORDS");

  await submitWordsApi(
    { code: lobby.code, members: [
      { name: "Маша", ctx: lobby.host, id: lobby.hostId },
      { name: "Петя", ctx: lobby.second, id: lobby.secondId },
      { name: "Ваня", ctx: lobby.third, id: lobby.thirdId },
    ] },
    ["самолёт", "поезд", "корабль"],
  );

  const finish = await lobby.second.post(`${API_PREFIX}/${lobby.code}/finish`, { headers: originHeaders });
  await expectApiError(finish, 403, "FORBIDDEN");
  const stillPlaying = await getStateViaApi(lobby.host, lobby.code);
  expect(stillPlaying.state.game.phase).toBe("PLAYING");
  expect(stillPlaying.state.results).toBeNull();
});
