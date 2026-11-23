import { expect, test, type Page } from "@playwright/test";

import { newBrowserContext } from "./helpers";

// Live-интеграция GameRoom на уровне лобби: два независимых браузерных
// контекста. Проверяет серверный рендер комнаты по cookie, форму входа с
// предзаполненным кодом, синхронизацию готовности через SSE, перезагрузку
// с сохранением личности, выход (204 → возврат на главную) и узкий экран.

function watchConsole(page: Page, errors: string[]): void {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Браузер сам логирует неуспешные fetch как "Failed to load resource":
    // ожидаемые API-ошибки (409 NAME_TAKEN и т.п.) утверждениями на UI.
    if (message.text().startsWith("Failed to load resource")) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(String(error));
  });
}

async function createGameViaUi(host: Page, name: string): Promise<string> {
  await host.goto("/");
  await host.locator("#player-name").fill(name);
  await host.getByRole("button", { name: "Создать комнату" }).click();
  await expect(host.getByRole("heading", { name: "Лобби" })).toBeVisible();
  const code = new URL(host.url()).pathname.split("/").at(-1) ?? "";
  expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u);
  return code;
}

test("лобби: вход по коду, синхронизация готовности, перезагрузка и выход", async ({
  browser,
}) => {
  const consoleErrors: string[] = [];
  const hostContext = await newBrowserContext(browser, { viewport: { width: 360, height: 740 } });
  const guestContext = await newBrowserContext(browser);
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  watchConsole(host, consoleErrors);
  watchConsole(guest, consoleErrors);

  try {
    const code = await createGameViaUi(host, "Маша");
    await expect(host.getByText("Участники (1/12)")).toBeVisible();
    await expect(host.getByText("Маша", { exact: true })).toBeVisible();
    await expect(host.getByText("Хост")).toBeVisible();

    // Гость открывает комнату без cookie: предзаполненная форма входа.
    await guest.goto(`/game/${code}`);
    await expect(guest.locator("#join-code")).toHaveValue(code);
    await guest.getByLabel("Ваше имя").fill("Петя");
    await guest.getByRole("button", { name: "Подключиться" }).click();
    await expect(guest.getByRole("heading", { name: "Лобби" })).toBeVisible();

    // Оба видят состав комнаты (host — на узком экране без горизонтального
    // скролла).
    await expect(host.getByText("Участники (2/12)")).toBeVisible();
    await expect(host.getByText("Петя", { exact: true })).toBeVisible();
    await expect(guest.getByText("Участники (2/12)")).toBeVisible();
    expect(await host.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    // Готовность гостя синхронизируется на хоста через SSE, без перезагрузки.
    await guest.locator("#ready-button").click();
    await expect(
      host.getByRole("listitem").filter({ hasText: "Петя" }).getByText("Готов", { exact: true }),
    ).toBeVisible();
    await expect(guest.getByText("Готов", { exact: true })).toBeVisible();

    // Перезагрузка сохраняет личность: форма входа не появляется снова.
    await guest.reload();
    await expect(guest.getByRole("heading", { name: "Лобби" })).toBeVisible();
    await expect(guest.locator("#join-code")).toHaveCount(0);
    await expect(
      guest.getByRole("listitem").filter({ hasText: "Петя" }),
    ).toBeVisible();

    // Диалог выхода: сначала отмена, затем подтверждение → возврат на главную.
    await guest.getByRole("button", { name: "Выйти из игры" }).click();
    const leaveDialog = guest.getByRole("alertdialog");
    await leaveDialog.getByRole("button", { name: "Отмена" }).click();
    await expect(guest.getByRole("heading", { name: "Лобби" })).toBeVisible();
    await guest.getByRole("button", { name: "Выйти из игры" }).click();
    await guest
      .getByRole("alertdialog")
      .getByRole("button", { name: "Выйти" })
      .click();
    await expect(guest.getByRole("heading", { name: "Words Game" })).toBeVisible();
    await expect(guest).toHaveURL(/\/$/u);

    // Хост видит уход участника.
    await expect(host.getByText("Участники (1/12)")).toBeVisible();

    expect(consoleErrors).toEqual([]);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test("лобби: кнопка копирования записывает только код комнаты", async ({ browser }) => {
  const consoleErrors: string[] = [];
  const context = await newBrowserContext(browser);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          document.documentElement.dataset.copiedText = text;
          return Promise.resolve();
        },
      },
    });
  });
  const page = await context.newPage();
  watchConsole(page, consoleErrors);

  try {
    const code = await createGameViaUi(page, "Маша");
    await page.getByRole("button", { name: "Скопировать приглашение" }).click();

    await expect(page.locator("html")).toHaveAttribute("data-copied-text", code);
    await expect(page.getByRole("button", { name: "Код скопирован" })).toBeVisible();
    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("лобби: отказ доступа к буферу обмена показывает ошибку без исключения", async ({
  browser,
}) => {
  const consoleErrors: string[] = [];
  const context = await newBrowserContext(browser);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new DOMException("Доступ запрещён", "NotAllowedError")),
      },
    });
  });
  const page = await context.newPage();
  watchConsole(page, consoleErrors);

  try {
    await createGameViaUi(page, "Маша");
    await page.getByRole("button", { name: "Скопировать приглашение" }).click();

    await expect(
      page.getByRole("alert").filter({ hasText: "Не удалось скопировать приглашение" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Скопировать приглашение" })).toBeVisible();
    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("комната: форма входа без членства, 404 для неизвестного кода, ошибка занятого имени", async ({
  browser,
}) => {
  const consoleErrors: string[] = [];
  const hostContext = await newBrowserContext(browser);
  const guestContext = await newBrowserContext(browser);
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  watchConsole(host, consoleErrors);
  watchConsole(guest, consoleErrors);

  try {
    // Неизвестный код — серверный 404, данных комнаты не раскрывается.
    const missing = await guest.goto("/game/ZZZZ99");
    expect(missing?.status()).toBe(404);

    const code = await createGameViaUi(host, "Маша");

    // Устройство без членства получает форму входа с предзаполненным кодом.
    await guest.goto(`/game/${code}`);
    await expect(guest.locator("#join-code")).toHaveValue(code);
    await expect(guest.getByRole("button", { name: "Подключиться" })).toBeVisible();

    // Занятое имя — ошибка рядом с полем, форма остаётся.
    await guest.getByLabel("Ваше имя").fill("Маша");
    await guest.getByRole("button", { name: "Подключиться" }).click();
    await expect(
      guest.getByRole("alert").filter({ hasText: "Это имя уже занято в комнате" }),
    ).toBeVisible();
    await expect(guest.locator("#join-code")).toHaveValue(code);

    // Другое имя проходит.
    await guest.getByLabel("Ваше имя").fill("Оля");
    await guest.getByRole("button", { name: "Подключиться" }).click();
    await expect(guest.getByRole("heading", { name: "Лобби" })).toBeVisible();

    // Участник другой комнаты по cookie получает форму входа, а не чужое лобби.
    const otherContext = await newBrowserContext(browser);
    const other = await otherContext.newPage();
    watchConsole(other, consoleErrors);
    try {
      const otherCode = await createGameViaUi(other, "Галя");
      await host.goto(`/game/${otherCode}`);
      await expect(host.locator("#join-code")).toHaveValue(otherCode);
      await expect(host.getByRole("button", { name: "Подключиться" })).toBeVisible();
      // Текущая комната хоста по-прежнему открыта по его cookie.
      await host.goto(`/game/${code}`);
      await expect(host.getByRole("heading", { name: "Лобби" })).toBeVisible();
    } finally {
      await otherContext.close();
    }

    expect(consoleErrors).toEqual([]);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test("лобби: хост удаляет участника из его строки; гость теряет членство и может войти снова", async ({
  browser,
}) => {
  const consoleErrors: string[] = [];
  const hostContext = await newBrowserContext(browser);
  const guestContext = await newBrowserContext(browser);
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  watchConsole(host, consoleErrors);
  watchConsole(guest, consoleErrors);

  try {
    const code = await createGameViaUi(host, "Маша");
    await guest.goto(`/game/${code}`);
    await guest.getByLabel("Ваше имя").fill("Петя");
    await guest.getByRole("button", { name: "Подключиться" }).click();
    await expect(guest.getByRole("heading", { name: "Лобби" })).toBeVisible();
    await expect(host.getByText("Участники (2/12)")).toBeVisible();

    // Кнопка удаления — в строке Пети; удалить себя нельзя.
    const kickButton = host.getByRole("button", { name: "Удалить участника «Петя»" });
    await expect(
      host.getByRole("listitem").filter({ has: kickButton }),
      "кнопка удаления находится в строке Пети",
    ).toBeVisible();
    await expect(host.getByRole("button", { name: "Удалить участника «Маша»" })).toHaveCount(0);

    // Сначала отмена диалога: состав не меняется.
    await kickButton.click();
    const kickDialog = host.getByRole("alertdialog");
    await expect(kickDialog).toContainText("Удалить участника «Петя»?");
    await kickDialog.getByRole("button", { name: "Отмена" }).click();
    await expect(host.getByText("Участники (2/12)")).toBeVisible();

    // Подтверждение исключает Петю; у гостя членство потеряно — персональный
    // /state отвечает 403, клиент показывает баннер обновления состояния.
    await kickButton.click();
    await host
      .getByRole("alertdialog")
      .getByRole("button", { name: "Удалить" })
      .click();
    await expect(host.getByText("Участники (1/12)")).toBeVisible();
    await expect(host.getByText("Петя", { exact: true })).toHaveCount(0);
    await expect(
      guest.getByRole("alert").filter({ hasText: "Не удалось обновить состояние игры" }),
    ).toBeVisible();

    // Исключённый по прежнему коду входит как новый игрок.
    await guest.reload();
    await expect(guest.locator("#join-code")).toHaveValue(code);
    await guest.getByLabel("Ваше имя").fill("Петя");
    await guest.getByRole("button", { name: "Подключиться" }).click();
    await expect(guest.getByRole("heading", { name: "Лобби" })).toBeVisible();
    await expect(host.getByText("Участники (2/12)")).toBeVisible();

    expect(consoleErrors).toEqual([]);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
