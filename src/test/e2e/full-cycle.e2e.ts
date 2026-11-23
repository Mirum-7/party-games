import { expect, test, type Browser, type Page } from "@playwright/test";

// Полный live-цикл WORD_CHAIN: ровно четыре независимых браузерных контекста
// (Маша/Петя/Ваня/Саша). Создание → три входа → готовность → старт → слова →
// автоматический PLAYING → персональные подсказки → последовательные
// угадывания → финал с местами 1–4 и очками 4–1. Ваня идёт на viewport 360 px.

const NAMES = ["Маша", "Петя", "Ваня", "Саша"] as const;
const WORDS: Record<(typeof NAMES)[number], string> = {
  Маша: "пирамида",
  Петя: "ракета",
  Ваня: "телескоп",
  Саша: "барабан",
};

function watchConsole(page: Page, errors: string[]): void {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Браузер сам логирует неуспешные fetch как "Failed to load resource";
    // ожидаемые API-ошибки утверждениями на UI, здесь — только ошибки приложения.
    if (message.text().startsWith("Failed to load resource")) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(String(error));
  });
}

type Player = { name: (typeof NAMES)[number]; page: Page };

async function openFourContexts(browser: Browser): Promise<{
  players: Player[];
  consoleErrors: string[];
  close: () => Promise<void>;
}> {
  const consoleErrors: string[] = [];
  const contexts = [
    await browser.newContext(),
    await browser.newContext(),
    await browser.newContext({ viewport: { width: 360, height: 740 } }),
    await browser.newContext(),
  ];
  const players: Player[] = [];
  for (let index = 0; index < contexts.length; index += 1) {
    const page = await contexts[index].newPage();
    watchConsole(page, consoleErrors);
    players.push({ name: NAMES[index], page });
  }
  return {
    players,
    consoleErrors,
    close: async () => {
      for (const context of contexts) await context.close();
    },
  };
}

function byName(players: Player[], name: (typeof NAMES)[number]): Player {
  const found = players.find((player) => player.name === name);
  if (found === undefined) throw new Error(`player ${name} missing`);
  return found;
}

async function expectNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

async function guessOwnWord(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Я угадал" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Я угадал" })
    .click();
  // Обычно следует экран зрителя; последнее угадывание сразу завершает игру.
  await expect(
    page
      .getByText("Вы уже угадали своё слово")
      .or(page.getByRole("heading", { name: "Результаты" })),
  ).toBeVisible();
}

test("полный цикл WORD_CHAIN: четыре контекста от лобби до финала", async ({ browser }) => {
  const { players, consoleErrors, close } = await openFourContexts(browser);
  const masha = byName(players, "Маша");
  const vanya = byName(players, "Ваня");
  const sasha = byName(players, "Саша");

  try {
    // 1. Маша создаёт комнату.
    await masha.page.goto("/");
    const createSection = masha.page.locator("section", {
      has: masha.page.getByRole("heading", { name: "Создать игру" }),
    });
    await createSection.getByLabel("Ваше имя").fill("Маша");
    await createSection.getByRole("button", { name: "Создать игру" }).click();
    await expect(masha.page.getByRole("heading", { name: "Лобби" })).toBeVisible();
    const code = new URL(masha.page.url()).pathname.split("/").at(-1) ?? "";
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u);

    // 2. Петя, Ваня и Саша входят по коду комнаты.
    for (const name of ["Петя", "Ваня", "Саша"] as const) {
      const page = byName(players, name).page;
      await page.goto(`/game/${code}`);
      await expect(page.locator("#join-code")).toHaveValue(code);
      await page.getByLabel("Ваше имя").fill(name);
      await page.getByRole("button", { name: "Подключиться" }).click();
      await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
    }
    await expect(masha.page.getByText("Участники (4/12)")).toBeVisible();

    // 3. Все отмечают готовность; готовность синхронизируется через SSE.
    for (const player of players) {
      await player.page.locator("#ready-switch").click();
    }
    for (const player of players) {
      await expect(
        player.page.getByRole("listitem").filter({ hasText: "Саша" }).getByText("Готов", { exact: true }),
      ).toBeVisible();
    }

    // Кнопка запуска появляется только у админа, когда все готовы.
    const startButton = masha.page.getByRole("button", { name: "Начать игру" });
    await expect(startButton).toBeVisible();
    await expect(sasha.page.getByRole("button", { name: "Начать игру" })).toHaveCount(0);

    // 4. Админ запускает — все переходят к вводу слова.
    await startButton.click();
    for (const player of players) {
      await expect(
        player.page.getByRole("heading", { name: /Загадай слово/u }),
      ).toBeVisible();
    }

    // Админ открывает диалог отмены и возвращается назад.
    await masha.page.getByRole("button", { name: "Отменить попытку" }).click();
    await masha.page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Назад" })
      .click();
    await expect(
      masha.page.getByRole("heading", { name: /Загадай слово/u }),
    ).toBeVisible();

    // 5. Каждый вводит уникальное слово; Ваня — с лишними пробелами: после
    // сохранения поле синхронизируется с нормализованным значением сервера.
    // Первые трое остаются во вводе слов; последнее слово атомарно переводит
    // игру в PLAYING, поэтому для последнего автора ожидаем переход вместо
    // бейджа сохранения.
    const submitters = players.slice(0, 3);
    const lastSubmitter = players[3];
    for (let index = 0; index < submitters.length; index += 1) {
      const player = submitters[index];
      const raw = player.name === "Ваня" ? "  телескоп  " : WORDS[player.name];
      await player.page.locator("#word-input").fill(raw);
      await player.page.getByRole("button", { name: "Сохранить слово" }).click();
      const savedBadge = player.page
        .locator("header")
        .getByText("Слово сохранено", { exact: true });
      await expect(
        savedBadge.or(player.page.getByRole("heading", { name: "Игра идёт" })),
      ).toBeVisible();
      await expect(savedBadge).toBeVisible();
      await expect(player.page.locator("#word-input")).toHaveValue(WORDS[player.name]);
      // Факт готовности слова виден остальным без перезагрузки.
      const other = players[index + 1];
      await expect(
        other.page
          .getByRole("listitem")
          .filter({ hasText: player.name })
          .getByText("Слово сохранено", { exact: true }),
      ).toBeVisible();
    }

    // Перезагрузка в фазе слов сохраняет и личность, и нормализованное слово.
    await vanya.page.reload();
    await expect(
      vanya.page.getByRole("heading", { name: /Загадай слово/u }),
    ).toBeVisible();
    await expect(vanya.page.locator("#word-input")).toHaveValue(WORDS.Ваня);
    await expect(
      vanya.page.locator("header").getByText("Слово сохранено", { exact: true }),
    ).toBeVisible();

    // Последнее слово атомарно переводит всех в PLAYING.
    await lastSubmitter.page.locator("#word-input").fill(WORDS[lastSubmitter.name]);
    await lastSubmitter.page.getByRole("button", { name: "Сохранить слово" }).click();
    for (const player of players) {
      await expect(player.page.getByRole("heading", { name: "Игра идёт" })).toBeVisible();
    }

    // 6. Персональные подсказки: у каждого ровно одна скрытая запись «вам»,
    // и скрытое слово отсутствует в его DOM, остальные слова видны.
    for (const player of players) {
      const page = player.page;
      const ownHint = page.locator("li").filter({ hasText: "вам" });
      await expect(ownHint).toHaveCount(1);
      await expect(ownHint).toContainText("слово скрыто");
      const hintText = (await ownHint.innerText()).replace("вам", "");
      const author = NAMES.find((name) => name !== player.name && hintText.includes(name));
      expect(author, `автор назначения для ${player.name}`).toBeDefined();
      const hiddenWord = WORDS[author as (typeof NAMES)[number]];
      await expect(page.locator("body")).not.toContainText(hiddenWord);
      for (const name of NAMES) {
        if (WORDS[name] !== hiddenWord) {
          await expect(page.locator("body")).toContainText(WORDS[name]);
        }
      }
    }

    // 7. Последовательные угадывания: Маша, Петя, Ваня, Саша.
    await guessOwnWord(masha.page);
    await guessOwnWord(byName(players, "Петя").page);
    await expectNoHorizontalOverflow(vanya.page, 360);
    await guessOwnWord(vanya.page);
    await guessOwnWord(sasha.page);

    // Последнее угадывание завершает игру у всех.
    for (const player of players) {
      await expect(player.page.getByRole("heading", { name: "Результаты" })).toBeVisible();
    }
    await expectNoHorizontalOverflow(vanya.page, 360);

    // 8. Финал: места 1–4 и очки 4–1 в порядке угадывания.
    const expected: Array<[string, string, string]> = [
      ["1", "Маша", "4"],
      ["2", "Петя", "3"],
      ["3", "Ваня", "2"],
      ["4", "Саша", "1"],
    ];
    for (const player of players) {
      const rows = player.page.locator("ol > li");
      await expect(rows).toHaveCount(4);
      for (let index = 0; index < expected.length; index += 1) {
        const [place, name, score] = expected[index];
        await expect(rows.nth(index)).toContainText(`${place} место`);
        await expect(rows.nth(index)).toContainText(name);
        await expect(rows.nth(index)).toContainText(`Очки: ${score}`);
      }
      // После финала все слова раскрыты.
      await expect(player.page.getByRole("heading", { name: "Все слова" })).toBeVisible();
      for (const name of NAMES) {
        await expect(player.page.locator("body")).toContainText(WORDS[name]);
      }
    }

    // Перезагрузка после финала сохраняет личность и результаты.
    await masha.page.reload();
    await expect(masha.page.getByRole("heading", { name: "Результаты" })).toBeVisible();
    await expect(masha.page.locator("ol > li").first()).toContainText("1 место");

    expect(consoleErrors).toEqual([]);
  } finally {
    await close();
  }
});
