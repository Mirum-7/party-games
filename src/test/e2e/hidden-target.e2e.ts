import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  CANARY_WORDS,
  captureViewerSurfaces,
  expectCanary,
  expectSurfaceIntegrity,
  VIEWER_NAMES,
  type ViewerName,
  type ViewerSurfaces,
} from "./secret-canaries";

// Приёмка скрытия адресатов (hideTargetNamesDuringSetup): четыре независимых
// браузерных контекста проходят сценарий через реальный UI. В ASSIGNING_WORDS
// для каждого автора сервер обязан отдавать setup.target=null и
// targetHidden=true, а связка автор→адресат не должна просачиваться ни в DOM,
// ни в серверный HTML, ни в RSC-полезную нагрузку — при этом обычный состав
// участников виден всем. После перехода в PLAYING назначения раскрываются
// через персональные подсказки. Проверка ассоциации выполняется по
// структурированному setup и полезным нагрузкам: имена адресатов намеренно
// остаются видны в общем списке участников, поэтому отсутствие имени как
// строки — ложный критерий, проверяется отсутствие самой связки.

// Обычные слова (не канарейки): этот сьют проверяет скрытие адресатов, а не
// утечки слов. Набор отличается от projection-leakage, чтобы сьюты не
// пересекались по секретам.
const WORDS: Record<ViewerName, string> = {
  Маша: "компас",
  Петя: "фонарь",
  Ваня: "мост",
  Саша: "сад",
};

const ROSTER_RE = /^Участники \(4\/12\)$/u;
const HIDDEN_NOTICE = "Адресат будет назван после начала угадывания.";
// Не-null ссылка на адресата в полезных нагрузках: в HTML flight-данные
// экранированы (\"), в RSC — нет. Её появление до PLAYING — утечка связки.
const TARGET_REF_PLAIN = '"target":{"id"';
const TARGET_REF_ESCAPED = '\\"target\\":{\\"id\\"';

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

async function createRoomAndEnableHiddenTargets(masha: Page): Promise<string> {
  await masha.goto("/");
  const createSection = masha.locator("section", {
    has: masha.getByRole("heading", { name: "Создать игру" }),
  });
  await createSection.getByLabel("Ваше имя").fill("Маша");
  await createSection.getByRole("button", { name: "Создать игру" }).click();
  await expect(masha.getByRole("heading", { name: "Лобби" })).toBeVisible();
  const code = new URL(masha.url()).pathname.split("/").at(-1) ?? "";
  expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u);
  await masha.locator("#hide-targets-switch").click();
  await expect(masha.getByText("Участники (1/12)")).toBeVisible();
  return code;
}

async function joinViaUi(page: Page, code: string, name: ViewerName): Promise<void> {
  await page.goto(`/game/${code}`);
  await expect(page.locator("#join-code")).toHaveValue(code);
  await page.getByLabel("Ваше имя").fill(name);
  await page.getByRole("button", { name: "Подключиться" }).click();
  await expect(page.getByRole("heading", { name: "Лобби" })).toBeVisible();
}

// Назначение, загаданное для зрителя: автор, имя и слово связки.
function viewerAssignment(surfaces: ViewerSurfaces): {
  authorName: string;
  authorWord: string;
  viewerName: string;
} {
  const body = surfaces.body;
  const ownHint = (body.hints ?? []).find((hint) => hint.target.id === body.viewer.playerId);
  const viewerName = body.players.find((player) => player.id === body.viewer.playerId)?.name;
  if (ownHint === undefined || viewerName === undefined) {
    throw new Error(`назначение для зрителя ${body.viewer.playerId} не найдено в hints`);
  }
  return { authorName: ownHint.author.name, authorWord: WORDS[ownHint.author.name as ViewerName], viewerName };
}

test("скрытие адресатов: нет связки автор→адресат в UI/HTML/RSC до PLAYING, раскрытие через подсказки", async ({
  browser,
}) => {
  const { players, close } = await openFourContexts(browser);
  const masha = byName(players, "Маша");
  try {
    // 1. Маша создаёт комнату и включает скрытие адресатов до старта; через
    // SSE настройка доходит до остальных до входа.
    const code = await createRoomAndEnableHiddenTargets(masha.page);
    for (const name of ["Петя", "Ваня", "Саша"] as const) {
      await joinViaUi(byName(players, name).page, code, name);
    }
    for (const player of players) {
      await expect(player.page.getByText(ROSTER_RE)).toBeVisible();
      const surfaces = await captureViewerSurfaces(player.page, code);
      expect(surfaces.body.game.settings.hideTargetNamesDuringSetup, `настройка для ${player.name}`).toBe(
        true,
      );
    }
    // Переключатель настройки рендерится только у админа.
    const settingsSwitch = masha.page.getByLabel("Скрывать имена адресатов до старта");
    await expect(settingsSwitch).toBeVisible();
    await expect(settingsSwitch).toBeChecked();

    // 2. Все готовы, админ запускает — все в ASSIGNING_WORDS.
    for (const player of players) {
      await player.page.locator("#ready-switch").click();
    }
    await masha.page.getByRole("button", { name: "Начать игру" }).click();
    for (const player of players) {
      await expect(player.page.getByRole("heading", { name: "Введи загаданное слово" })).toBeVisible();
    }

    // 3. Каждый автор: структурированный setup скрывает адресата, UI не
    // называет адресата (шапка без имени + текст-заглушка), а HTML и RSC не
    // содержат не-null ссылки target. Состав участников при этом виден всем.
    for (const player of players) {
      const surfaces = await captureViewerSurfaces(player.page, code);
      expectSurfaceIntegrity(surfaces);
      expect(surfaces.body.game.phase, `ASSIGNING_WORDS для ${player.name}`).toBe("ASSIGNING_WORDS");
      expect(surfaces.body.setup).toMatchObject({ target: null, targetHidden: true, word: null });
      expect(surfaces.body.hints, `hints скрыты до PLAYING (${player.name})`).toBeNull();

      const page = player.page;
      await expect(page.getByText(HIDDEN_NOTICE)).toBeVisible();
      await expect(
        page.getByRole("heading", { name: /^Загадай слово /u }),
        `заголовок без имени адресата (${player.name})`,
      ).toHaveCount(0);
      for (const viewerName of VIEWER_NAMES) {
        await expect(
          page.getByRole("listitem").filter({ hasText: viewerName }),
          `состав участников виден (${player.name})`,
        ).toBeVisible();
        expect(surfaces.htmlText.includes(viewerName), `HTML: roster ${viewerName} (${player.name})`).toBe(true);
      }

      expect(
        surfaces.htmlText.includes(TARGET_REF_ESCAPED),
        `HTML: не-null target до PLAYING (${player.name})`,
      ).toBe(false);
      expect(
        surfaces.rscText.includes(TARGET_REF_PLAIN),
        `RSC: не-null target до PLAYING (${player.name})`,
      ).toBe(false);
      expect(surfaces.rscText).toContain('"setup":{"target":null,"targetHidden":true');
      expect(surfaces.htmlText).toContain('\\"setup\\":{\\"target\\":null,\\"targetHidden\\":true');
      for (const viewerName of VIEWER_NAMES) {
        expectCanary(surfaces, CANARY_WORDS[viewerName], false);
      }
    }

    // 4. Слова вводятся через UI; последнее переводит всех в PLAYING, где
    // назначения раскрываются персональными подсказками.
    const firstSubmitters = players.slice(0, 3);
    for (const player of firstSubmitters) {
      await player.page.locator("#word-input").fill(WORDS[player.name]);
      await player.page.getByRole("button", { name: "Сохранить слово" }).click();
      await expect(
        player.page.locator("header").getByText("Слово сохранено", { exact: true }),
      ).toBeVisible();
    }
    const sasha = byName(players, "Саша");
    await sasha.page.locator("#word-input").fill(WORDS.Саша);
    await sasha.page.getByRole("button", { name: "Сохранить слово" }).click();
    for (const player of players) {
      await expect(player.page.getByRole("heading", { name: "Игра идёт" })).toBeVisible();
    }

    // 5. После PLAYING связка автор→адресат видна каждому: собственное
    // назначение показывает автора со скрытым словом, остальные — целиком.
    for (const player of players) {
      const surfaces = await captureViewerSurfaces(player.page, code);
      expectSurfaceIntegrity(surfaces);
      expect(surfaces.body.game.phase, `PLAYING для ${player.name}`).toBe("PLAYING");
      expect(surfaces.body.hints, `hints раскрыты для ${player.name}`).toHaveLength(4);
      const assignment = viewerAssignment(surfaces);
      expect(assignment.authorName, `автор назначения для ${player.name}`).not.toBe(player.name);

      const page = player.page;
      const ownHint = page.locator("li").filter({ hasText: "вам" });
      await expect(ownHint, `одна подсказка «вам» для ${player.name}`).toHaveCount(1);
      await expect(ownHint).toContainText(assignment.authorName);
      await expect(ownHint).toContainText("слово скрыто");
      await expect(page.locator("body")).not.toContainText(assignment.authorWord);
      for (const viewerName of VIEWER_NAMES) {
        if (viewerName !== assignment.authorName) {
          await expect(page.locator("body")).toContainText(WORDS[viewerName]);
        }
      }

      // Структурированная связка в полезных нагрузках: ровно одно скрытое
      // слово (собственное), остальные слова раскрыты.
      const hiddenJson = surfaces.body.hints?.filter((hint) => hint.wordHidden === true) ?? [];
      expect(hiddenJson, `одно скрытое слово для ${player.name}`).toHaveLength(1);
      const occurrences = surfaces.rscText.split('"word":null').length - 1;
      expect(occurrences, `одно «word»:null в RSC для ${player.name}`).toBe(1);
      expect(
        surfaces.rscText.includes(
          `"target":{"id":"${surfaces.body.viewer.playerId}","name":"${assignment.viewerName}"},"word":null,"wordHidden":true`,
        ),
        `RSC: связка «автор → зритель» для ${player.name}`,
      ).toBe(true);
      expect(
        surfaces.htmlText.includes(
          `\\"target\\":{\\"id\\":\\"${surfaces.body.viewer.playerId}\\",\\"name\\":\\"${assignment.viewerName}\\"},\\"word\\":null,\\"wordHidden\\":true`,
        ),
        `HTML: связка «автор → зритель» для ${player.name}`,
      ).toBe(true);
    }
  } finally {
    await close();
  }
});
