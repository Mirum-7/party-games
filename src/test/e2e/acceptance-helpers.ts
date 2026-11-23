import { expect, request, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

import type { GameStateResponse } from "../../shared/contracts/game";
import {
  API_PREFIX,
  APP_ORIGIN,
  createGameViaApi,
  joinGameViaApi,
  newScenarioContext,
  nextScenarioIp,
  originHeaders,
} from "./helpers";

// Общие построения acceptance-наборов (finish-cancel/permissions/limits):
// независимые браузерные контексты, UI-проходы production-экранов и API-команды.
// Файл намеренно не имеет суффикса *.e2e.ts: Playwright его не подбирает.

export type ConsoleErrorList = string[];

function watchConsole(page: Page, errors: ConsoleErrorList): void {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Браузер сам логирует неуспешные fetch как "Failed to load resource";
    // ожидаемые API-ошибки проверяются утверждениями на UI.
    if (message.text().startsWith("Failed to load resource")) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(String(error));
  });
}

export type IndependentContexts = {
  contexts: BrowserContext[];
  pages: Page[];
  consoleErrors: ConsoleErrorList;
  close: () => Promise<void>;
};

// N полностью независимых браузерных контекстов (отдельные cookie-хранилища),
// порядок страниц соответствует порядку имён.
export async function openIndependentContexts(
  browser: Browser,
  names: readonly string[],
): Promise<IndependentContexts> {
  const consoleErrors: ConsoleErrorList = [];
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    watchConsole(page, consoleErrors);
    contexts.push(context);
    pages.push(page);
  }
  return {
    contexts,
    pages,
    consoleErrors,
    close: async () => {
      for (const context of contexts) await context.close();
    },
  };
}

// --- UI-проходы production-экранов ------------------------------------------

export async function createGameViaUi(page: Page, name: string): Promise<string> {
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

export async function joinViaUi(page: Page, code: string, name: string): Promise<void> {
  await page.goto(`/game/${code}`);
  await expect(page.locator("#join-code")).toHaveValue(code);
  await page.getByLabel("Ваше имя").fill(name);
  await page.getByRole("button", { name: "Подключиться" }).click();
  await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
}

export async function setReadyViaUi(page: Page): Promise<void> {
  await page.locator("#ready-switch").click();
}

export async function startGameViaUi(hostPage: Page): Promise<void> {
  await hostPage.getByRole("button", { name: "Начать игру" }).click();
  await expect(hostPage.getByRole("heading", { name: /Загадай слово|Введи загаданное слово/u })).toBeVisible();
}

// Первые n-1 участников остаются во вводе слов со бейджем «Слово сохранено»,
// последнее слово атомарно переводит всех в PLAYING.
export async function submitWordViaUi(page: Page, word: string, isLastSubmitter: boolean): Promise<void> {
  await page.locator("#word-input").fill(word);
  await page.getByRole("button", { name: "Сохранить слово" }).click();
  if (isLastSubmitter) {
    await expect(page.getByRole("heading", { name: "Игра идёт" })).toBeVisible();
  } else {
    await expect(
      page.locator("header").getByText("Слово сохранено", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("#word-input")).toHaveValue(word);
  }
}

export async function guessViaUi(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Я угадал" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Я угадал" })
    .click();
  await expect(
    page
      .getByText("Вы уже угадали своё слово")
      .or(page.getByRole("heading", { name: "Результаты" })),
  ).toBeVisible();
}

// Подтверждённое досрочное завершение админом; все участники переходят к финалу.
export async function finishGameViaUi(hostPage: Page, allPages: readonly Page[]): Promise<void> {
  await hostPage.getByRole("button", { name: "Завершить игру" }).click();
  await hostPage
    .getByRole("alertdialog")
    .getByRole("button", { name: "Завершить игру" })
    .click();
  for (const page of allPages) {
    await expect(page.getByRole("heading", { name: "Результаты" })).toBeVisible();
  }
}

// --- Те же личности через прямой API -----------------------------------------

// API-контекст с cookie выбранного браузерного контекста: утверждения можно
// выполнять от имени того же игрока, который кликает по UI. Cookie берётся из
// storageState (HttpOnly-cookie туда входят) и передаётся заголовком только
// в этом тестовом контексте.
export async function apiAs(browserContext: BrowserContext, ip: string = nextScenarioIp()): Promise<APIRequestContext> {
  const storage = await browserContext.storageState();
  const session = storage.cookies.find((cookie) => cookie.name === "wg_session");
  if (!session) throw new Error("wg_session cookie отсутствует в браузерном контексте");
  return request.newContext({
    baseURL: APP_ORIGIN,
    extraHTTPHeaders: {
      "x-forwarded-for": ip,
      cookie: `${session.name}=${session.value}`,
    },
    ignoreHTTPSErrors: true,
  });
}

// --- Комнаты целиком через API ------------------------------------------------

export type RoomMember = {
  name: string;
  ctx: APIRequestContext;
  id: string;
};

export type ApiRoom = {
  code: string;
  members: RoomMember[]; // members[0] — админ
};

// Комната из N независимых API-контекстов (у каждого своя cookie и свой IP,
// поэтому rate limit между сценариями не складывается).
export async function createLobbyApi(names: readonly [string, ...string[]]): Promise<ApiRoom> {
  const [hostName, ...guestNames] = names;
  const host = await newScenarioContext();
  const created = await createGameViaApi(host, hostName);
  expect(created.response.status()).toBe(201);
  const code = created.state.game.code;
  const members: RoomMember[] = [{ name: hostName, ctx: host, id: created.state.viewer.playerId }];

  for (const name of guestNames) {
    const ctx = await newScenarioContext();
    const joined = await joinGameViaApi(ctx, code, name);
    expect(joined.response.status()).toBe(200);
    members.push({ name, ctx, id: joined.state.viewer.playerId });
  }
  return { code, members };
}

export async function readyAllApi(room: ApiRoom): Promise<void> {
  for (const member of room.members) {
    const response = await member.ctx.post(`${API_PREFIX}/${room.code}/readiness`, {
      data: { ready: true },
      headers: originHeaders,
    });
    expect(response.status()).toBe(200);
  }
}

// LOBBY → ASSIGNING_WORDS.
export async function startApi(room: ApiRoom): Promise<void> {
  const response = await room.members[0].ctx.post(`${API_PREFIX}/${room.code}/start`, {
    headers: originHeaders,
  });
  expect(response.status()).toBe(200);
  const state = (await response.json()) as GameStateResponse;
  expect(state.game.phase).toBe("ASSIGNING_WORDS");
}

// ASSIGNING_WORDS → PLAYING: слово от каждого участника (порядок — порядок входа).
export async function submitWordsApi(room: ApiRoom, words: readonly string[]): Promise<void> {
  expect(words).toHaveLength(room.members.length);
  for (let index = 0; index < room.members.length; index += 1) {
    const response = await room.members[index].ctx.put(`${API_PREFIX}/${room.code}/word`, {
      data: { word: words[index] },
      headers: originHeaders,
    });
    expect(response.status()).toBe(200);
  }
  const state = (await (await room.members[0].ctx.get(`${API_PREFIX}/${room.code}/state`)).json()) as GameStateResponse;
  expect(state.game.phase).toBe("PLAYING");
}

// LOBBY → PLAYING: готовность всех, старт, слово от каждого участника.
export async function toPlayingApi(room: ApiRoom, words: readonly string[]): Promise<void> {
  await readyAllApi(room);
  await startApi(room);
  await submitWordsApi(room, words);
}
