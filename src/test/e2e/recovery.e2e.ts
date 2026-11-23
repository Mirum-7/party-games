import { expect, test, type Page } from "@playwright/test";

import type { GameStateResponse } from "../../shared/contracts/game";
import {
  API_PREFIX,
  APP_ORIGIN,
  e2eFetch,
  joinGameViaApi,
  newScenarioContext,
  originHeaders,
  type ErrorBody,
} from "./helpers";

// Восстановление после перезагрузки и разрыва SSE: личность и состояние
// всегда приходят с сервера (cookie → персональный DTO), localStorage пуст,
// пропущенное событие восстанавливается полным /state после переподключения,
// а опоздавший ответ со старой ревизией не перезаписывает новое состояние.
// Каждый тест — своя комната; браузер только для проверяемого игрока,
// остальные участники — независимые API-контексты.

const PHASE_HEADING = {
  LOBBY: "Лобби",
  ASSIGNING_WORDS: /Загадай слово|Введи загаданное слово/u,
  PLAYING: "Игра идёт",
  FINISHED: "Результаты",
} as const;

function watchConsole(page: Page, errors: string[]): void {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Браузер сам логирует неуспешные fetch как "Failed to load resource":
    // abort /events в тесте разрыва — намеренный, прочие ошибки падают тест.
    if (message.text().startsWith("Failed to load resource")) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(String(error));
  });
}

// Персональный DTO сервера глазами той же страницы: cookie контекста
// страницы — единственное удостоверение личности.
async function fetchStateInPage(page: Page, code: string): Promise<GameStateResponse> {
  return page.evaluate(async (gameCode) => {
    const response = await fetch(`/api/v1/games/${gameCode}/state`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`state HTTP ${response.status}`);
    return (await response.json()) as unknown;
  }, code) as Promise<GameStateResponse>;
}

async function expectLocalStorageEmpty(page: Page): Promise<void> {
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
}

async function expectIdentityRestored(page: Page, name: string): Promise<void> {
  // Форма входа не появляется повторно: серверный рендер узнал игрока по cookie.
  await expect(page.locator("#join-code")).toHaveCount(0);
  await expect(page.getByRole("listitem").filter({ hasText: name })).toBeVisible();
}

async function createRoomWithHostViaUi(page: Page): Promise<string> {
  await page.goto("/");
  const createSection = page.locator("section", {
    has: page.getByRole("heading", { name: "Создать игру" }),
  });
  await createSection.getByLabel("Ваше имя").fill("Маша");
  await createSection.getByRole("button", { name: "Создать игру" }).click();
  await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
  const code = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u);
  return code;
}

async function setReadyViaApi(ctx: Awaited<ReturnType<typeof newScenarioContext>>, code: string): Promise<GameStateResponse> {
  const response = await ctx.post(`${API_PREFIX}/${code}/readiness`, {
    data: { ready: true },
    headers: originHeaders,
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as GameStateResponse;
}

async function submitWordViaApi(ctx: Awaited<ReturnType<typeof newScenarioContext>>, code: string, word: string): Promise<GameStateResponse> {
  const response = await ctx.put(`${API_PREFIX}/${code}/word`, {
    data: { word },
    headers: originHeaders,
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as GameStateResponse;
}

test("перезагрузка в LOBBY и ASSIGNING_WORDS: фаза, ревизия, слово и capabilities — с сервера", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  const context = await browser.newContext();
  const page = await context.newPage();
  watchConsole(page, consoleErrors);
  const petya = await newScenarioContext();
  const vanya = await newScenarioContext();

  try {
    // --- LOBBY ---
    const code = await createRoomWithHostViaUi(page);
    await expect(page.getByText("Участники (1/12)")).toBeVisible();
    await expect(page.getByText("Хост")).toBeVisible();
    // Админ в лобби: настройки доступны; старт недоступен без 3 участников.
    // Кнопка и причина недоступности видны, но кнопка отключена
    // (одобренное disabled-start+aria поведение из acceptance-ветки).
    await expect(page.locator("#hide-targets-switch")).toBeVisible();
    const startButton = page.getByRole("button", { name: "Начать игру" });
    await expect(startButton).toBeVisible();
    await expect(startButton).toBeDisabled();
    await expect(page.locator("#start-block-reason")).toBeVisible();

    const lobbyState = await fetchStateInPage(page, code);
    expect(lobbyState.game.phase).toBe("LOBBY");
    expect(lobbyState.game.code).toBe(code);
    expect(lobbyState.players.map((player) => player.name)).toEqual(["Маша"]);
    expect(lobbyState.players[0]?.isHost).toBe(true);
    expect(lobbyState.capabilities.canEditSettings).toBe(true);

    await page.reload();
    await expect(page.getByRole("heading", { name: PHASE_HEADING.LOBBY })).toBeVisible();
    await expectIdentityRestored(page, "Маша");
    await expect(page.getByText("Участники (1/12)")).toBeVisible();
    await expect(page.locator("#hide-targets-switch")).toBeVisible();
    await expectLocalStorageEmpty(page);
    const reloadedLobby = await fetchStateInPage(page, code);
    expect(reloadedLobby.game.revision).toBe(lobbyState.game.revision);
    expect(reloadedLobby.game.phase).toBe("LOBBY");

    // --- LOBBY с другими участниками и чужой мутацией до перезагрузки ---
    await joinGameViaApi(petya, code, "Петя");
    await joinGameViaApi(vanya, code, "Ваня");
    await expect(page.getByText("Участники (3/12)")).toBeVisible();

    const vanyaReady = await setReadyViaApi(vanya, code);
    await page.reload();
    await expect(page.getByText("Участники (3/12)")).toBeVisible();
    await expectIdentityRestored(page, "Маша");
    // Чужая готовность, произошедшая до перезагрузки, пришла с сервера.
    await expect(
      page.getByRole("listitem").filter({ hasText: "Ваня" }).getByText("Готов", { exact: true }),
    ).toBeVisible();
    await expectLocalStorageEmpty(page);
    const lobbyAfterVanya = await fetchStateInPage(page, code);
    expect(lobbyAfterVanya.game.revision).toBe(vanyaReady.game.revision);
    expect(lobbyAfterVanya.players).toHaveLength(3);
    expect(lobbyAfterVanya.players.filter((player) => player.isHost)).toHaveLength(1);

    // --- ASSIGNING_WORDS ---
    await page.locator("#ready-switch").click();
    await expect(page.getByText("Готов", { exact: true })).toBeVisible();
    await setReadyViaApi(petya, code);
    await page.getByRole("button", { name: "Начать игру" }).click();
    await expect(page.getByRole("heading", { name: PHASE_HEADING.ASSIGNING_WORDS })).toBeVisible();

    // Маша вводит слово с лишними пробелами: сервер нормализует (trim).
    await page.locator("#word-input").fill("  пирамида  ");
    await page.getByRole("button", { name: "Сохранить слово" }).click();
    await expect(page.locator("header").getByText("Слово сохранено", { exact: true })).toBeVisible();
    await expect(page.locator("#word-input")).toHaveValue("пирамида");

    const setupState = await fetchStateInPage(page, code);
    expect(setupState.game.phase).toBe("ASSIGNING_WORDS");
    expect(setupState.setup?.word).toBe("пирамида");
    expect(setupState.capabilities.canSubmitWord).toBe(true);
    expect(setupState.capabilities.canCancel).toBe(true);

    await page.reload();
    await expect(page.getByRole("heading", { name: PHASE_HEADING.ASSIGNING_WORDS })).toBeVisible();
    await expectIdentityRestored(page, "Маша");
    // Разрешённое слово восстановлено сервером в нормализованном виде.
    await expect(page.locator("#word-input")).toHaveValue("пирамида");
    await expect(page.locator("header").getByText("Слово сохранено", { exact: true })).toBeVisible();
    // Capabilities восстановлены: сохранение доступно, отмена — админу.
    await expect(page.getByRole("button", { name: "Сохранить слово" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Отменить попытку" })).toBeVisible();
    await expectLocalStorageEmpty(page);
    const reloadedSetup = await fetchStateInPage(page, code);
    expect(reloadedSetup.game.phase).toBe("ASSIGNING_WORDS");
    expect(reloadedSetup.setup?.word).toBe("пирамида");
    expect(reloadedSetup.game.revision).toBe(setupState.game.revision);

    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("перезагрузка в PLAYING и FINISHED: состояние сохранено; новый контекст личность не наследует", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  const context = await browser.newContext();
  const page = await context.newPage();
  watchConsole(page, consoleErrors);
  const petya = await newScenarioContext();
  const vanya = await newScenarioContext();

  try {
    const code = await createRoomWithHostViaUi(page);
    await joinGameViaApi(petya, code, "Петя");
    await joinGameViaApi(vanya, code, "Ваня");
    await page.locator("#ready-switch").click();
    await setReadyViaApi(petya, code);
    await setReadyViaApi(vanya, code);
    await page.getByRole("button", { name: "Начать игру" }).click();
    await expect(page.getByRole("heading", { name: PHASE_HEADING.ASSIGNING_WORDS })).toBeVisible();

    await page.locator("#word-input").fill("пирамида");
    await page.getByRole("button", { name: "Сохранить слово" }).click();
    await expect(page.locator("header").getByText("Слово сохранено", { exact: true })).toBeVisible();
    await submitWordViaApi(petya, code, "ракета");
    await submitWordViaApi(vanya, code, "телескоп");
    await expect(page.getByRole("heading", { name: PHASE_HEADING.PLAYING })).toBeVisible();

    const playingState = await fetchStateInPage(page, code);
    expect(playingState.game.phase).toBe("PLAYING");
    expect(playingState.hints).toHaveLength(3);
    expect(playingState.hints?.filter((hint) => hint.wordHidden)).toHaveLength(1);

    // --- PLAYING: перезагрузка ---
    await page.reload();
    await expect(page.getByRole("heading", { name: PHASE_HEADING.PLAYING })).toBeVisible();
    await expectIdentityRestored(page, "Маша");
    // Capabilities восстановлены: угадать и (админу) завершить.
    await expect(page.getByRole("button", { name: "Я угадал" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Завершить игру" })).toBeVisible();
    // Персональная проекция восстановлена: своё слово по-прежнему скрыто.
    const ownHint = page.locator("li").filter({ hasText: "вам" });
    await expect(ownHint).toHaveCount(1);
    await expect(ownHint).toContainText("слово скрыто");
    // Скрыто ровно то слово, которое адресовано Маше: автор читается из
    // строки «вам», остальные слова видны.
    const ownHintText = (await ownHint.innerText()).replace("вам", "");
    const hiddenAuthor = ["Петя", "Ваня"].find((name) => ownHintText.includes(name));
    expect(hiddenAuthor, "автор назначения для Маши").toBeDefined();
    const hiddenWord = hiddenAuthor === "Петя" ? "ракета" : "телескоп";
    await expect(page.locator("body")).not.toContainText(hiddenWord);
    await expectLocalStorageEmpty(page);
    const reloadedPlaying = await fetchStateInPage(page, code);
    expect(reloadedPlaying.game.phase).toBe("PLAYING");
    expect(reloadedPlaying.game.revision).toBe(playingState.game.revision);
    expect(reloadedPlaying.capabilities.canMarkGuessed).toBe(true);
    expect(reloadedPlaying.capabilities.canFinish).toBe(true);

    // --- PLAYING после угадывания: перезагрузка фиксирует результат ---
    await page.getByRole("button", { name: "Я угадал" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Я угадал" })
      .click();
    await expect(page.getByText("Вы уже угадали своё слово")).toBeVisible();

    await page.reload();
    await expect(page.getByText("Вы уже угадали своё слово")).toBeVisible();
    await expect(page.getByRole("button", { name: "Я угадал" })).toHaveCount(0);
    await expectLocalStorageEmpty(page);
    const guessedState = await fetchStateInPage(page, code);
    expect(guessedState.players.find((player) => player.name === "Маша")?.hasGuessed).toBe(true);
    expect(guessedState.capabilities.canMarkGuessed).toBe(false);

    // --- FINISHED ---
    for (const ctx of [petya, vanya]) {
      const response = await ctx.post(`${API_PREFIX}/${code}/guessed`, { headers: originHeaders });
      expect(response.status()).toBe(200);
    }
    await expect(page.getByRole("heading", { name: PHASE_HEADING.FINISHED })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: PHASE_HEADING.FINISHED })).toBeVisible();
    await expect(page.locator("ol > li")).toHaveCount(3);
    await expect(page.locator("ol > li").first()).toContainText("1 место");
    await expect(page.locator("ol > li").first()).toContainText("Маша");
    await expect(page.locator("ol > li").first()).toContainText("Очки: 3");
    // После финала слова раскрыты, интерактивных действий не осталось.
    await expect(page.getByRole("heading", { name: "Все слова" })).toBeVisible();
    for (const word of ["пирамида", "ракета", "телескоп"]) {
      await expect(page.locator("body")).toContainText(word);
    }
    await expectLocalStorageEmpty(page);
    const finishedState = await fetchStateInPage(page, code);
    expect(finishedState.game.phase).toBe("FINISHED");
    expect(finishedState.results).toHaveLength(3);
    expect(finishedState.results?.find((item) => item.name === "Маша")).toMatchObject({
      place: 1,
      score: 3,
    });

    // --- Новый контекст не наследует личность ---
    const strangerContext = await browser.newContext();
    const stranger = await strangerContext.newPage();
    watchConsole(stranger, consoleErrors);
    try {
      await stranger.goto(`/game/${code}`);
      await expect(stranger.getByRole("heading", { name: "Words Game" })).toBeVisible();
      await expect(stranger.locator("#join-code")).toHaveValue(code);
      await expect(stranger.getByRole("heading", { name: "Лобби" })).toHaveCount(0);
      await expectLocalStorageEmpty(stranger);
      // Без cookie сервер не отдаёт даже метаданные состояния комнаты.
      const anonymous = await e2eFetch(`${APP_ORIGIN}${API_PREFIX}/${code}/state`);
      expect(anonymous.status).toBe(401);
      const anonymousBody = (await anonymous.json()) as ErrorBody;
      expect(anonymousBody.error.code).toBe("UNAUTHENTICATED");
    } finally {
      await strangerContext.close();
    }

    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("разрыв SSE: пропущенное событие восстанавливается полным /state после переподключения", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const mashaContext = await browser.newContext();
  const page = await mashaContext.newPage();
  watchConsole(page, consoleErrors);
  const petya = await newScenarioContext();
  const vanya = await newScenarioContext();

  // Журнал сетевых событий — доказательство переподключения, а не только
  // итоговый текст: порядок успешных /events и /state после восстановления.
  type NetEvent =
    | { kind: "events-request" }
    | { kind: "events-failed" }
    | { kind: "events-200" }
    | { kind: "state-200"; revision: number };
  const networkLog: NetEvent[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/events")) networkLog.push({ kind: "events-request" });
  });
  page.on("requestfailed", (request) => {
    if (request.url().endsWith("/events")) networkLog.push({ kind: "events-failed" });
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.endsWith("/events") && response.status() === 200) {
      networkLog.push({ kind: "events-200" });
    }
    if (url.endsWith("/state") && response.status() === 200) {
      void response
        .json()
        .then((body) => {
          networkLog.push({
            kind: "state-200",
            revision: (body as GameStateResponse).game.revision,
          });
        })
        .catch(() => {});
    }
  });

  const eventsRoute = "**/api/v1/games/*/events";

  try {
    const code = await createRoomWithHostViaUi(page);
    await joinGameViaApi(petya, code, "Петя");
    await joinGameViaApi(vanya, code, "Ваня");
    await expect(page.getByText("Участники (3/12)")).toBeVisible();

    // Здоровое соединение: индикатор «Подключено», поток открыт.
    await expect(page.getByText("Подключено", { exact: true })).toBeVisible();
    const beforeBlock = networkLog.length;
    expect(networkLog.slice(0, beforeBlock).some((event) => event.kind === "events-200")).toBe(true);

    // Обрыв: новые запросы /events рвём на уровне маршрутизации.
    await mashaContext.route(eventsRoute, (route) => void route.abort());
    await page.reload();
    await expect(page.getByText("Переподключение…", { exact: true })).toBeVisible();
    await expect
      .poll(
        () => networkLog.filter((event) => event.kind === "events-failed").length,
        { message: "запросы /events обрываются" },
      )
      .toBeGreaterThan(0);
    const logAfterReload = networkLog.length;

    // Мутация другого игрока, пока событие не может дойти: событие пропущено.
    const petyaReady = await setReadyViaApi(petya, code);
    await page.waitForTimeout(500);
    // За окном обрыва не было ни одного успешного /state: клиент ещё не знает
    // о новой ревизии, UI по-прежнему показывает Петю неготовым.
    const stateDuringBlock = networkLog
      .slice(logAfterReload)
      .filter((event) => event.kind === "state-200");
    expect(stateDuringBlock).toEqual([]);
    await expect(
      page.getByRole("listitem").filter({ hasText: "Петя" }).getByText("Не готов", { exact: true }),
    ).toBeVisible();

    // Восстановление маршрута: авто-retry EventSource открывает поток заново,
    // open контроллера выполняет полный /state — пропущенное событие наверстано.
    await mashaContext.unroute(eventsRoute);
    await expect(page.getByText("Подключено", { exact: true })).toBeVisible();

    await expect
      .poll(
        () => {
          const log = networkLog;
          const lastEventsOpen = log.map((event, index) => ({ event, index })).filter(
            (entry) => entry.event.kind === "events-200",
          ).at(-1);
          if (lastEventsOpen === undefined) return false;
          return log
            .slice(lastEventsOpen.index + 1)
            .some(
              (event) =>
                event.kind === "state-200" && event.revision === petyaReady.game.revision,
            );
        },
        { message: "после открытия потока выполнен полный /state с новой ревизией" },
      )
      .toBe(true);

    // Итоговое состояние — новейшее, участники без дублей, хост не перешёл.
    await expect(
      page.getByRole("listitem").filter({ hasText: "Петя" }).getByText("Готов", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Участники (3/12)")).toBeVisible();
    await expect(page.getByText("Хост")).toHaveCount(1);
    const finalState = await fetchStateInPage(page, code);
    expect(finalState.game.revision).toBe(petyaReady.game.revision);
    expect(finalState.players).toHaveLength(3);
    expect(finalState.players.filter((player) => player.isHost)).toHaveLength(1);
    expect(finalState.players.find((player) => player.name === "Маша")?.isHost).toBe(true);

    expect(consoleErrors).toEqual([]);
  } finally {
    await mashaContext.close();
  }
});

test("опоздавший ответ /state со старой ревизией не перезаписывает новое состояние", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  const context = await browser.newContext();
  const page = await context.newPage();
  watchConsole(page, consoleErrors);
  const petya = await newScenarioContext();
  const vanya = await newScenarioContext();

  try {
    const code = await createRoomWithHostViaUi(page);
    await joinGameViaApi(petya, code, "Петя");
    await joinGameViaApi(vanya, code, "Ваня");
    await expect(page.getByText("Подключено", { exact: true })).toBeVisible();

    // Тело «устаревшего» ответа: реальная проекция Маши до любых мутаций.
    const staleBody = await fetchStateInPage(page, code);
    expect(staleBody.game.revision).toBeGreaterThanOrEqual(1);

    // Первая мутация применяется честно: ревизия растёт, Петя готов.
    await setReadyViaApi(petya, code);
    await expect(
      page.getByRole("listitem").filter({ hasText: "Петя" }).getByText("Готов", { exact: true }),
    ).toBeVisible();
    const afterPetya = await fetchStateInPage(page, code);
    expect(afterPetya.game.revision).toBe(staleBody.game.revision + 1);

    // Вторая мутация инициирует refresh контроллера; его ответ подменяем на
    // сохранённое ранее тело со СТАРОЙ ревизией. Пока подмена вооружена,
    // собственных зондов не выполняем: первым запросом /state будет именно
    // refresh контроллера по событию SSE. Живой хук обязан отбросить
    // опоздавший ответ с ревизией ниже текущей.
    let forged = false;
    await page.route("**/api/v1/games/*/state", (route) => {
      if (!forged) {
        forged = true;
        void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(staleBody),
        });
        return;
      }
      void route.continue();
    });
    await setReadyViaApi(vanya, code);
    await expect
      .poll(() => forged, { message: "подмена ответа /state применена" })
      .toBe(true);
    // Ответ доставлен контроллеру: новое состояние не перезаписано старым,
    // Петя остался «Готов».
    await expect(
      page.getByRole("listitem").filter({ hasText: "Петя" }).getByText("Готов", { exact: true }),
    ).toBeVisible();

    // Подмена снята: серверная истина (ревизия выше, Ваня готов) intact.
    await page.unroute("**/api/v1/games/*/state");
    const afterVanya = await fetchStateInPage(page, code);
    expect(afterVanya.game.revision).toBe(afterPetya.game.revision + 1);
    expect(afterVanya.players.find((player) => player.name === "Ваня")?.isReady).toBe(true);

    // Перезагрузка показывает ту же серверную истину.
    await page.reload();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Ваня" }).getByText("Готов", { exact: true }),
    ).toBeVisible();

    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
