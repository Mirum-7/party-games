import { expect, test, type Browser, type Page } from "@playwright/test";

import { API_PREFIX, newScenarioContext } from "./helpers";
import {
  CANARY_WORDS,
  captureViewerSurfaces,
  expectCanary,
  expectSurfaceIntegrity,
  targetedCanaryFor,
  VIEWER_NAMES,
  type ViewerName,
  type ViewerSurfaces,
} from "./secret-canaries";

// Приёмка персональных проекций против реального production-сервера: четыре
// независимых браузерных контекста проходят полный цикл WORD_CHAIN через UI,
// а для каждой фазы и каждого зрителя сравниваются сырые тела трёх ответов
// с личной cookie зрителя: /state (JSON), серверный HTML и RSC-полезная
// нагрузка. Секреты — уникальные канарейки CANARY_WORDS: сравнение строк
// тел, а не имён полей, ловит слово в любом неожиданном месте ответа.

type Player = { name: ViewerName; page: Page };

async function openFourContexts(browser: Browser): Promise<{
  players: Player[];
  close: () => Promise<void>;
}> {
  const contexts = [
    await browser.newContext(),
    await browser.newContext(),
    await browser.newContext(),
    await browser.newContext(),
  ];
  const players: Player[] = [];
  for (let index = 0; index < contexts.length; index += 1) {
    players.push({ name: VIEWER_NAMES[index], page: await contexts[index].newPage() });
  }
  return {
    players,
    close: async () => {
      for (const context of contexts) await context.close();
    },
  };
}

function byName(players: Player[], name: ViewerName): Player {
  const found = players.find((player) => player.name === name);
  if (found === undefined) throw new Error(`player ${name} missing`);
  return found;
}

async function createRoomViaUi(masha: Page): Promise<string> {
  await masha.goto("/");
  const createSection = masha.locator("section", {
    has: masha.getByRole("heading", { name: "Создать игру" }),
  });
  await createSection.getByLabel("Ваше имя").fill("Маша");
  await createSection.getByRole("button", { name: "Создать игру" }).click();
  await expect(masha.getByRole("heading", { name: "Лобби" })).toBeVisible();
  const code = new URL(masha.url()).pathname.split("/").at(-1) ?? "";
  expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u);
  return code;
}

async function joinViaUi(page: Page, code: string, name: ViewerName): Promise<void> {
  await page.goto(`/game/${code}`);
  await expect(page.locator("#join-code")).toHaveValue(code);
  await page.getByLabel("Ваше имя").fill(name);
  await page.getByRole("button", { name: "Подключиться" }).click();
  await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
}

async function submitWordViaUi(page: Page, word: string, completesSetup = false): Promise<void> {
  await page.locator("#word-input").fill(word);
  await page.getByRole("button", { name: "Сохранить слово" }).click();
  const savedBadge = page.locator("header").getByText("Слово сохранено", { exact: true });
  // Последнее слово атомарно переводит игру в PLAYING: бейджа у последнего
  // автора нет, ожидаем переход экрана.
  await expect(
    completesSetup ? savedBadge.or(page.getByRole("heading", { name: "Игра идёт" })) : savedBadge,
  ).toBeVisible();
  if (completesSetup) {
    await expect(page.getByRole("heading", { name: "Игра идёт" })).toBeVisible();
  } else {
    await expect(savedBadge).toBeVisible();
  }
}

async function markGuessedViaUi(page: Page): Promise<void> {
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

async function captureAll(players: Player[], code: string): Promise<ViewerSurfaces[]> {
  const surfaces: ViewerSurfaces[] = [];
  for (const player of players) {
    surfaces.push(await captureViewerSurfaces(player.page, code));
  }
  return surfaces;
}

// Каждому зрителю — одинаковый набор: его собственное слово (как setup.word
// автора) видно только ему, слова других авторов в ASSIGNING_WORDS не видит
// никто. phase здесь ещё ASSIGNING_WORDS: последнее слово не введено.
function expectAssigningWordsProjection(
  players: Player[],
  surfaces: ViewerSurfaces[],
  submitted: readonly ViewerName[],
): void {
  for (let index = 0; index < players.length; index += 1) {
    const current = surfaces[index];
    const name = players[index].name;
    expectSurfaceIntegrity(current);
    expect(current.body.game.phase, `фаза для ${name}`).toBe("ASSIGNING_WORDS");
    expect(current.body.hints, `hints скрыты до PLAYING (${name})`).toBeNull();
    expect(current.body.setup, `setup для ${name}`).not.toBeNull();
    const ownWord = submitted.includes(name) ? CANARY_WORDS[name] : null;
    expect(current.body.setup?.word, `setup.word для ${name}`).toBe(ownWord);
    for (const viewerName of VIEWER_NAMES) {
      expectCanary(current, CANARY_WORDS[viewerName], viewerName === name && submitted.includes(name));
    }
  }
}

test("канарейки слов: LOBBY → ASSIGNING_WORDS → PLAYING → FINISHED в /state, HTML и RSC", async ({
  browser,
}) => {
  const { players, close } = await openFourContexts(browser);
  const masha = byName(players, "Маша");
  try {
    // 1. Маша создаёт комнату, остальные входят: LOBBY, слов ещё нет.
    const code = await createRoomViaUi(masha.page);
    for (const name of ["Петя", "Ваня", "Саша"] as const) {
      await joinViaUi(byName(players, name).page, code, name);
    }
    await expect(masha.page.getByText("Участники (4/12)")).toBeVisible();

    const lobbySurfaces = await captureAll(players, code);
    for (let index = 0; index < players.length; index += 1) {
      const current = lobbySurfaces[index];
      expectSurfaceIntegrity(current);
      expect(current.body.game.phase, `LOBBY для ${players[index].name}`).toBe("LOBBY");
      expect(current.body.setup).toBeNull();
      expect(current.body.hints).toBeNull();
      expect(current.body.results).toBeNull();
      for (const viewerName of VIEWER_NAMES) {
        expectCanary(current, CANARY_WORDS[viewerName], false);
      }
    }

    // 2. Все готовы, админ запускает: ASSIGNING_WORDS.
    for (const player of players) {
      await player.page.locator("#ready-switch").click();
    }
    await masha.page.getByRole("button", { name: "Начать игру" }).click();
    for (const player of players) {
      await expect(player.page.getByRole("heading", { name: /Загадай слово/u })).toBeVisible();
    }

    // 3. Первые трое вводят канарейки; последнее слово перевело бы игру в
    // PLAYING, поэтому Саша пока не вводит: фаза остаётся ASSIGNING_WORDS.
    const firstSubmitters = players.slice(0, 3);
    for (const player of firstSubmitters) {
      await submitWordViaUi(player.page, CANARY_WORDS[player.name]);
    }
    const assigningSurfaces = await captureAll(players, code);
    expectAssigningWordsProjection(
      players,
      assigningSurfaces,
      firstSubmitters.map((player) => player.name),
    );

    // 4. Последняя канарейка атомарно переводит всех в PLAYING: каждый видит
    // ровно чужие слова, а слово, загаданное для него, отсутствует везде.
    await submitWordViaUi(byName(players, "Саша").page, CANARY_WORDS.Саша, true);
    for (const player of players) {
      await expect(player.page.getByRole("heading", { name: "Игра идёт" })).toBeVisible();
    }

    const playingSurfaces = await captureAll(players, code);
    for (let index = 0; index < players.length; index += 1) {
      const current = playingSurfaces[index];
      const name = players[index].name;
      expectSurfaceIntegrity(current);
      expect(current.body.game.phase, `PLAYING для ${name}`).toBe("PLAYING");
      expect(current.body.setup, `setup пуст в PLAYING (${name})`).toBeNull();
      const viewerId = current.body.viewer.playerId;
      const hiddenHints = (current.body.hints ?? []).filter(
        (hint) => hint.target.id === viewerId,
      );
      expect(hiddenHints, `одно скрытое назначение для ${name}`).toHaveLength(1);
      expect(hiddenHints[0]).toMatchObject({ word: null, wordHidden: true });
      const visibleHints = (current.body.hints ?? []).filter(
        (hint) => hint.target.id !== viewerId,
      );
      expect(visibleHints, `три видимых назначения для ${name}`).toHaveLength(3);
      expect(
        visibleHints.every((hint) => hint.word !== null && hint.wordHidden === false),
      ).toBe(true);

      const ownCanary = targetedCanaryFor(current);
      expectCanary(current, ownCanary, false);
      for (const viewerName of VIEWER_NAMES) {
        if (CANARY_WORDS[viewerName] !== ownCanary) {
          expectCanary(current, CANARY_WORDS[viewerName], true);
        }
      }
    }

    // 5. Все угадывают: FINISHED раскрывает все слова каждому зрителю.
    for (const name of VIEWER_NAMES) {
      await markGuessedViaUi(byName(players, name).page);
    }
    for (const player of players) {
      await expect(player.page.getByRole("heading", { name: "Результаты" })).toBeVisible();
    }

    const finishedSurfaces = await captureAll(players, code);
    for (let index = 0; index < players.length; index += 1) {
      const current = finishedSurfaces[index];
      const name = players[index].name;
      expectSurfaceIntegrity(current);
      expect(current.body.game.phase, `FINISHED для ${name}`).toBe("FINISHED");
      expect(current.body.hints, `hints раскрыты для ${name}`).toHaveLength(4);
      expect(
        (current.body.hints ?? []).every((hint) => hint.word !== null && hint.wordHidden === false),
      ).toBe(true);
      expect(current.body.results, `рейтинг для ${name}`).toHaveLength(4);
      for (const viewerName of VIEWER_NAMES) {
        expectCanary(current, CANARY_WORDS[viewerName], true);
      }
    }

    // 6. Ошибки состояния тоже персональны и не кешируются.
    const anonymous = await newScenarioContext();
    const unauthenticated = await anonymous.get(`${API_PREFIX}/${code}/state`);
    expect(unauthenticated.status()).toBe(401);
    expect(unauthenticated.headers()["cache-control"]).toContain("no-store");
    const missing = await masha.page.request.get(`${API_PREFIX}/ZZZZZZ/state`);
    expect(missing.status()).toBe(404);
    expect(missing.headers()["cache-control"]).toContain("no-store");
  } finally {
    await close();
  }
});
