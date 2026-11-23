import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  API_PREFIX,
  joinGameViaApi,
  newScenarioContext,
  originHeaders,
} from "./helpers";

// Мобильный приёмочный прогон на viewport 360px (оба движка — проекты
// chromium и webkit конфигурации): ни в одной фазе нет горизонтального
// переполнения; интерактивные цели измерены (bounding box >= 44x44, свитчи —
// через их подпись как реализованную интерактивную область); формы и диалоги
// работают с клавиатуры, фокус виден, активный контрол остаётся доступным
// при сжатом вьюпорте (эмуляция открытой клавиатуры); финал — карточки без
// таблиц и горизонтального скролла.

const VIEWPORT_WIDTH = 360;
const VIEWPORT_HEIGHT = 740;
const KEYBOARD_OPEN_HEIGHT = 340;
const MIN_TARGET = 44;

function watchConsole(page: Page, errors: string[]): void {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.text().startsWith("Failed to load resource")) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(String(error));
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, `scrollWidth ${scrollWidth}px <= ${VIEWPORT_WIDTH}px`).toBeLessThanOrEqual(
    VIEWPORT_WIDTH,
  );
}

// Измеренная, а не класс-only проверка: фактический bounding box цели.
async function expectMeasuredTarget(locator: Locator, label: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label}: область существует`).not.toBeNull();
  if (box === null) return;
  expect(box.width, `${label}: ширина ${box.width}px >= ${MIN_TARGET}px`).toBeGreaterThanOrEqual(
    MIN_TARGET,
  );
  expect(box.height, `${label}: высота ${box.height}px >= ${MIN_TARGET}px`).toBeGreaterThanOrEqual(
    MIN_TARGET,
  );
}

// Видимый индикатор фокуса: компоненты рисуют focus-visible кольцо через
// box-shadow (outline у них outline-none).
async function expectFocusRing(locator: Locator, label: string): Promise<void> {
  const boxShadow = await locator.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(boxShadow, `${label}: видимый фокус`).not.toBe("none");
}

// Активный контрол остаётся доступным, когда вьюпорт сжат открытой клавиатурой:
// свежая смена фокуса прокручивает элемент в видимую область. Фокус предварительно
// снимается нейтральным blur(): повторный focus() без смены активного элемента —
// no-op браузера без прокрутки, что не является поведением приложения.
async function expectReachableWithKeyboardOpen(
  page: Page,
  locator: Locator,
  label: string,
  also: Array<{ locator: Locator; label: string }> = [],
): Promise<void> {
  await page.setViewportSize({ width: VIEWPORT_WIDTH, height: KEYBOARD_OPEN_HEIGHT });
  try {
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await locator.focus();
    await expectWithinViewport(locator, label, KEYBOARD_OPEN_HEIGHT);
    for (const extra of also) {
      await expectWithinViewport(extra.locator, extra.label, KEYBOARD_OPEN_HEIGHT);
    }
  } finally {
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  }
}

async function expectWithinViewport(
  locator: Locator,
  label: string,
  viewportHeight: number,
): Promise<void> {
  const rect = await locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, height: box.height };
  });
  expect(rect.height, `${label}: отрисован`).toBeGreaterThan(0);
  expect(rect.top, `${label}: верх в пределах вьюпорта ${viewportHeight}px`).toBeGreaterThanOrEqual(0);
  expect(rect.bottom, `${label}: низ в пределах вьюпорта ${viewportHeight}px`).toBeLessThanOrEqual(
    viewportHeight,
  );
}

async function createGameViaUi(page: Page, name: string): Promise<string> {
  await page.goto("/");
  const createSection = page.locator("section", {
    has: page.getByRole("heading", { name: "Создать игру" }),
  });
  await createSection.getByLabel("Ваше имя").fill(name);
  await createSection.getByRole("button", { name: "Создать игру" }).click();
  await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
  const code = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u);
  return code;
}

test("360px: домашняя форма, лобби и ввод слова — измеренные цели, клавиатура, фокус", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
  });
  const page = await context.newPage();
  watchConsole(page, consoleErrors);

  try {
    const project = test.info().project.name;

    // --- Домашняя страница ---
    await page.goto("/");
    await expectNoHorizontalOverflow(page);
    const createSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Создать игру" }),
    });
    await expectMeasuredTarget(createSection.getByLabel("Ваше имя"), "дом: имя");
    await expectMeasuredTarget(
      createSection.getByRole("button", { name: "Создать игру" }),
      "дом: создание",
    );
    const joinSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Подключиться по коду" }),
    });
    await expectMeasuredTarget(joinSection.getByLabel("Ваше имя"), "дом: имя входа");
    await expectMeasuredTarget(joinSection.getByLabel("Код приглашения"), "дом: код входа");
    await expectMeasuredTarget(
      joinSection.getByRole("button", { name: "Подключиться" }),
      "дом: вход",
    );

    // Клавиатурное создание игры: ввод, Enter отправляет форму. В Chromium
    // дополнительно проверяем Tab-обход до кнопки: WebKit/Safari по умолчанию
    // не включает кнопки в Tab-порядок (настройка платформы, не приложения).
    await createSection.getByLabel("Ваше имя").click();
    await page.keyboard.type("Маша");
    await expectFocusRing(createSection.getByLabel("Ваше имя"), "дом: имя");
    const createButton = createSection.getByRole("button", { name: "Создать игру" });
    if (project === "chromium") {
      await page.keyboard.press("Tab");
      await expect(createButton).toBeFocused();
      await expectFocusRing(createButton, "дом: кнопка создания");
    }
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
    const code = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u);

    // --- Лобби ---
    const petya = await newScenarioContext();
    const vanya = await newScenarioContext();
    await joinGameViaApi(petya, code, "Петя");
    await joinGameViaApi(vanya, code, "Ваня");
    await expect(page.getByText("Участники (3/12)")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const inviteButton = page.getByRole("button", { name: "Скопировать приглашение" });
    await expectMeasuredTarget(inviteButton, "лобби: приглашение");
    // Свитч готовности: реализованная интерактивная область — его подпись.
    const readyLabel = page.getByText("Готовность: Маша");
    await expectMeasuredTarget(readyLabel, "лобби: подпись готовности");
    await expectMeasuredTarget(
      page.getByText("Скрывать имена адресатов до старта"),
      "лобби: подпись настройки",
    );
    const leaveTrigger = page.getByRole("button", { name: "Выйти из игры" });
    await expectMeasuredTarget(leaveTrigger, "лобби: выход");

    // Фокус с клавиатуры: первый Tab к кнопке приглашения с видимым кольцом
    // (Chromium; в WebKit кнопки вне Tab-порядка по умолчанию).
    if (project === "chromium") {
      await page.keyboard.press("Tab");
      await expect(inviteButton).toBeFocused();
      await expectFocusRing(inviteButton, "лобби: фокус на приглашении");
    }

    // Подпись реально переключает свитч (функциональное доказательство цели).
    await readyLabel.click();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Маша" }).getByText("Готов", { exact: true }),
    ).toBeVisible();

    // Диалог выхода: открыт, Escape закрывает с клавиатуры.
    await leaveTrigger.click();
    const leaveDialog = page.getByRole("alertdialog");
    await expect(leaveDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(leaveDialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();

    // Нижний контрол доступен при открытой клавиатуре (сжатый вьюпорт).
    await expectReachableWithKeyboardOpen(page, leaveTrigger, "лобби: выход");

    // --- ASSIGNING_WORDS ---
    await petya.post(`${API_PREFIX}/${code}/readiness`, {
      data: { ready: true },
      headers: originHeaders,
    });
    await vanya.post(`${API_PREFIX}/${code}/readiness`, {
      data: { ready: true },
      headers: originHeaders,
    });
    const startButton = page.getByRole("button", { name: "Начать игру" });
    await expect(startButton).toBeVisible();
    await expectMeasuredTarget(startButton, "лобби: старт");
    await startButton.click();
    await expect(
      page.getByRole("heading", { name: /Загадай слово|Введи загаданное слово/u }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const wordInput = page.locator("#word-input");
    const saveButton = page.getByRole("button", { name: "Сохранить слово" });
    await expectMeasuredTarget(wordInput, "ввод слова: поле");
    await expectMeasuredTarget(saveButton, "ввод слова: сохранение");
    await expectMeasuredTarget(
      page.getByRole("button", { name: "Отменить попытку" }),
      "ввод слова: отмена",
    );

    // Клавиатурный ввод слова: поле с фокусом, Enter сохраняет форму.
    // В Chromium — Tab-обход до кнопки сохранения с видимым фокусом.
    await wordInput.click();
    await page.keyboard.type("  телескоп  ");
    await expectFocusRing(wordInput, "ввод слова: поле");
    if (project === "chromium") {
      await page.keyboard.press("Tab");
      await expect(saveButton).toBeFocused();
      await expectFocusRing(saveButton, "ввод слова: сохранение");
    }
    await page.keyboard.press("Enter");
    await expect(
      page.locator("header").getByText("Слово сохранено", { exact: true }),
    ).toBeVisible();
    await expect(wordInput).toHaveValue("телескоп");
    await expectNoHorizontalOverflow(page);

    // Поле ввода и его действие доступны при открытой клавиатуре.
    await expectReachableWithKeyboardOpen(page, wordInput, "ввод слова: поле", [
      { locator: saveButton, label: "ввод слова: сохранение" },
    ]);

    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("360px: игра, диалоги и финал — клавиатура в диалогах, цели, карточки без таблицы", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
  });
  const page = await context.newPage();
  watchConsole(page, consoleErrors);

  try {
    const project = test.info().project.name;
    const code = await createGameViaUi(page, "Маша");

    const petya = await newScenarioContext();
    const vanya = await newScenarioContext();
    await joinGameViaApi(petya, code, "Петя");
    await joinGameViaApi(vanya, code, "Ваня");
    await page.locator("#ready-switch").click();
    await petya.post(`${API_PREFIX}/${code}/readiness`, {
      data: { ready: true },
      headers: originHeaders,
    });
    await vanya.post(`${API_PREFIX}/${code}/readiness`, {
      data: { ready: true },
      headers: originHeaders,
    });
    await page.getByRole("button", { name: "Начать игру" }).click();
    await expect(
      page.getByRole("heading", { name: /Загадай слово|Введи загаданное слово/u }),
    ).toBeVisible();

    await page.locator("#word-input").fill("пирамида");
    await page.getByRole("button", { name: "Сохранить слово" }).click();
    await expect(
      page.locator("header").getByText("Слово сохранено", { exact: true }),
    ).toBeVisible();
    await petya.put(`${API_PREFIX}/${code}/word`, {
      data: { word: "ракета" },
      headers: originHeaders,
    });
    await vanya.put(`${API_PREFIX}/${code}/word`, {
      data: { word: "барабан" },
      headers: originHeaders,
    });
    await expect(page.getByRole("heading", { name: "Игра идёт" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // --- PLAYING: цели и диалоги ---
    const guessTrigger = page.getByRole("button", { name: "Я угадал" });
    const finishTrigger = page.getByRole("button", { name: "Завершить игру" });
    await expectMeasuredTarget(guessTrigger, "игра: угадал");
    await expectMeasuredTarget(finishTrigger, "игра: завершение");

    // Диалог досрочного завершения закрывается с клавиатуры (Escape).
    await finishTrigger.click();
    const finishDialog = page.getByRole("alertdialog");
    await expect(finishDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(finishDialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Игра идёт" })).toBeVisible();

    // Нижний триггер доступен при открытой клавиатуре.
    await expectReachableWithKeyboardOpen(page, finishTrigger, "игра: завершение");

    // Диалог угадывания: фокус внутри, действие активируется с клавиатуры.
    // В Chromium — Tab-обход до действия с видимым фокусом; WebKit не включает
    // кнопки в Tab-порядок по умолчанию (платформа, не приложение).
    await guessTrigger.click();
    const guessDialog = page.getByRole("alertdialog");
    await expect(guessDialog).toBeVisible();
    const activeInDialog = await page.evaluate(
      () =>
        document.activeElement !== null &&
        document.activeElement.closest('[role="alertdialog"]') !== null,
    );
    expect(activeInDialog, "фокус перемещён в диалог").toBe(true);

    const dialogAction = guessDialog.getByRole("button", { name: "Я угадал" });
    if (project === "chromium") {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const actionFocused = await dialogAction.evaluate((el) => el === document.activeElement);
        if (actionFocused) break;
        await page.keyboard.press("Tab");
        const focused = page.locator(":focus");
        await expect(focused).toHaveCount(1);
        await expectFocusRing(focused, `диалог: фокус после Tab ${attempt + 1}`);
      }
      await expect(dialogAction).toBeFocused();
    }
    await dialogAction.press("Enter");
    await expect(page.getByText("Вы уже угадали своё слово")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // --- FINISHED: карточки, без таблицы и горизонтального скролла ---
    await petya.post(`${API_PREFIX}/${code}/guessed`, { headers: originHeaders });
    await vanya.post(`${API_PREFIX}/${code}/guessed`, { headers: originHeaders });
    await expect(page.getByRole("heading", { name: "Результаты" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await expect(page.locator("table")).toHaveCount(0);
    const resultCards = page.locator("ol > li");
    await expect(resultCards).toHaveCount(3);
    const firstCardBox = await resultCards.first().boundingBox();
    expect(firstCardBox).not.toBeNull();
    if (firstCardBox !== null) {
      expect(firstCardBox.width, "карточка результата в пределах 360px").toBeLessThanOrEqual(
        VIEWPORT_WIDTH,
      );
    }
    await expect(page.getByRole("heading", { name: "Все слова" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Я угадал" })).toHaveCount(0);

    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
