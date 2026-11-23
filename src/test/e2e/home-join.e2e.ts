import { expect, test, type Page } from "@playwright/test";

// Регрессия обратной связи формы входа на главной странице: API-ошибки
// подключения должны показываться рядом с полями (role=alert), а pending
// состояние — сбрасываться, чтобы форму можно было повторить. Комнатная
// форма входа (lobby.e2e.ts) уже показывает эти ошибки; здесь проверяем
// домашнюю, где HomeForms оборачивает JoinForm.

function watchConsole(page: Page, errors: string[]): void {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Браузер сам логирует неуспешные fetch как "Failed to load resource":
    // ожидаемые API-ошибки (404 GAME_NOT_FOUND, 409 NAME_TAKEN) утверждаются на UI.
    if (message.text().startsWith("Failed to load resource")) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(String(error));
  });
}

async function createGameViaUi(host: Page, name: string): Promise<string> {
  await host.goto("/");
  const createSection = host.locator("section", {
    has: host.getByRole("heading", { name: "Создать игру" }),
  });
  await createSection.getByLabel("Ваше имя").fill(name);
  await createSection.getByRole("button", { name: "Создать игру" }).click();
  await expect(host.getByRole("heading", { name: "Лобби" })).toBeVisible();
  const code = new URL(host.url()).pathname.split("/").at(-1) ?? "";
  expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u);
  return code;
}

test("главная: ошибки подключения по коду показываются рядом с полями и сбрасывают pending", async ({
  browser,
}) => {
  const consoleErrors: string[] = [];
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  watchConsole(host, consoleErrors);
  watchConsole(guest, consoleErrors);

  try {
    const code = await createGameViaUi(host, "Маша");

    await guest.goto("/");
    const joinSection = guest.locator("section", {
      has: guest.getByRole("heading", { name: "Подключиться по коду" }),
    });
    const joinButton = joinSection.getByRole("button", { name: "Подключиться" });
    await expect(joinButton).toBeVisible();

    // Неизвестный код: серверная ошибка показывается рядом с полями.
    await joinSection.getByLabel("Ваше имя").fill("Петя");
    await joinSection.getByLabel("Код приглашения").fill("ZZZZ99");
    await joinButton.click();
    await expect(
      joinSection.getByRole("alert").filter({ hasText: "Комната не найдена" }),
    ).toBeVisible();

    // Pending сброшен: форма снова доступна для повторной попытки.
    await expect(joinButton).toBeEnabled();
    await expect(joinSection.getByLabel("Ваше имя")).toBeEnabled();
    await expect(joinSection.getByLabel("Код приглашения")).toBeEnabled();

    // Занятое имя в существующей комнате: стабильное русское сообщение сервера.
    await joinSection.getByLabel("Ваше имя").fill("Маша");
    await joinSection.getByLabel("Код приглашения").fill(code);
    await joinButton.click();
    await expect(
      joinSection.getByRole("alert").filter({ hasText: "Это имя уже занято в комнате" }),
    ).toBeVisible();
    await expect(joinButton).toBeEnabled();

    // Исправленные данные проходят: та же форма ведёт в лобби.
    await joinSection.getByLabel("Ваше имя").fill("Петя");
    await joinSection.getByLabel("Код приглашения").fill(code);
    await joinButton.click();
    await expect(guest.getByRole("heading", { name: "Лобби" })).toBeVisible();
    await expect(host.getByText("Участники (2/12)")).toBeVisible();

    expect(consoleErrors).toEqual([]);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
