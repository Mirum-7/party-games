import { expect, test, type Page } from "@playwright/test";

import { newBrowserContext } from "./helpers";

// Регрессия обратной связи форм главной страницы: API-ошибки подключения
// должны показываться рядом с полями (role=alert), а pending состояние —
// сбрасываться, чтобы форму можно было повторить. Имя на главной — одно
// общее поле #player-name над обеими операциями: серверные fieldErrors.name
// показываются у него, ошибки кода — в карточке подключения. Комнатная форма
// входа (lobby.e2e.ts) показывает свои ошибки отдельно.

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
  await host.locator("#player-name").fill(name);
  await host.getByRole("button", { name: "Создать комнату" }).click();
  await expect(host.getByRole("heading", { name: "Лобби" })).toBeVisible();
  const code = new URL(host.url()).pathname.split("/").at(-1) ?? "";
  expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u);
  return code;
}

test("главная: ошибки подключения по коду показываются рядом с полями и сбрасывают pending", async ({
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

    await guest.goto("/");
    // Общее поле имени над обеими операциями; код — в карточке подключения.
    const nameInput = guest.getByLabel("Ваше имя");
    const joinSection = guest.locator("section", {
      has: guest.getByRole("heading", { name: "Подключиться по коду" }),
    });
    const codeInput = joinSection.getByLabel("Код приглашения");
    const joinButton = joinSection.getByRole("button", { name: "Подключиться" });
    await expect(joinButton).toBeVisible();

    // Неизвестный код: серверная ошибка показывается в карточке подключения.
    await nameInput.fill("Петя");
    await codeInput.fill("ZZZZ99");
    await joinButton.click();
    await expect(
      joinSection.getByRole("alert").filter({ hasText: "Комната не найдена" }),
    ).toBeVisible();

    // Pending сброшен: форма снова доступна для повторной попытки.
    await expect(joinButton).toBeEnabled();
    await expect(nameInput).toBeEnabled();
    await expect(codeInput).toBeEnabled();

    // Занятое имя в существующей комнате: серверное полевое сообщение
    // fieldErrors.name показывается у общего поля имени (в его контейнере,
    // а не где-либо на странице), введённые значения не стираются.
    await nameInput.fill("Маша");
    await codeInput.fill(code);
    await joinButton.click();
    const nameField = guest.locator("div").filter({ has: guest.locator("#player-name") });
    await expect(
      nameField.getByRole("alert").filter({ hasText: "Выберите другое имя" }),
      "полевое сообщение об ошибке имени показывается у общего поля имени",
    ).toBeVisible();
    await expect(joinButton).toBeEnabled();
    await expect(nameInput).toHaveValue("Маша");
    await expect(codeInput).toHaveValue(code);

    // Исправленные данные проходят: та же форма ведёт в лобби.
    await nameInput.fill("Петя");
    await codeInput.fill(code);
    await joinButton.click();
    await expect(guest.getByRole("heading", { name: "Лобби" })).toBeVisible();
    await expect(host.getByText("Участники (2/12)")).toBeVisible();

    expect(consoleErrors).toEqual([]);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
