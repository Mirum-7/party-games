import { expect, test } from "@playwright/test";

import type { GameStateResponse, ResultItem } from "../../shared/contracts/game";
import {
  API_PREFIX,
  expectApiError,
  getStateViaApi,
  joinGameViaApi,
  newScenarioContext,
  originHeaders,
} from "./helpers";
import {
  apiAs,
  createGameViaUi,
  createLobbyApi,
  guessViaUi,
  joinViaUi,
  openIndependentContexts,
  setReadyViaUi,
  startGameViaUi,
  submitWordViaUi,
  toPlayingApi,
} from "./acceptance-helpers";

// Acceptance: лимиты входа/запуска и жёсткость угадывания. Видимая причина
// недоступности старта, доменные ошибки NOT_ENOUGH_PLAYERS/NOT_ALL_READY,
// GAME_FULL на тринадцатом входе, NAME_TAKEN без учёта регистра и NFKC,
// отказ входа после старта, no-op повторного входа своего участника, а также
// идемпотентность и гонки угадывания, включая гонку с досрочным завершением.

test("старт меньше трёх и без полной готовности: видимая причина на экране админа и доменные ошибки API", async ({
  browser,
}) => {
  const { contexts, pages, consoleErrors, close } = await openIndependentContexts(browser, [
    "Маша",
    "Петя",
    "Ваня",
  ]);
  const [mashaPage, petePage, vanyaPage] = pages;

  try {
    const code = await createGameViaUi(mashaPage, "Маша");
    await joinViaUi(petePage, code, "Петя");
    const startButton = mashaPage.getByRole("button", { name: "Начать игру" });

    // Меньше трёх участников: кнопка запуска админа заблокирована с причиной,
    // причина связана с кнопкой через aria-describedby.
    await expect(startButton).toBeVisible();
    await expect(startButton).toBeDisabled();
    await expect(startButton).toHaveAccessibleDescription("Для старта нужно минимум 3 участника");
    await expect(mashaPage.getByText("Для старта нужно минимум 3 участника")).toBeVisible();

    const mashaApi = await apiAs(contexts[0]);
    const notEnough = await mashaApi.post(`${API_PREFIX}/${code}/start`, { headers: originHeaders });
    await expectApiError(notEnough, 409, "NOT_ENOUGH_PLAYERS");

    // Третий вошёл, но не готов: причина сменилась.
    await joinViaUi(vanyaPage, code, "Ваня");
    await setReadyViaUi(mashaPage);
    await setReadyViaUi(petePage);
    await expect(mashaPage.getByText("Не все участники готовы")).toBeVisible();
    await expect(startButton).toBeDisabled();
    await expect(startButton).toHaveAccessibleDescription("Не все участники готовы");

    const notReady = await mashaApi.post(`${API_PREFIX}/${code}/start`, { headers: originHeaders });
    await expectApiError(notReady, 409, "NOT_ALL_READY");

    // Все готовы: причина исчезла, кнопка активна, описание очищено.
    await setReadyViaUi(vanyaPage);
    await expect(mashaPage.getByText("Не все участники готовы")).toHaveCount(0);
    await expect(startButton).toBeEnabled();
    await expect(startButton).toHaveAccessibleDescription("");

    expect(consoleErrors).toEqual([]);
  } finally {
    await close();
  }
});

test("тринадцатый вход в полную комнату отклонён GAME_FULL", async () => {
  const room = await createLobbyApi([
    "Игрок 1",
    "Игрок 2",
    "Игрок 3",
    "Игрок 4",
    "Игрок 5",
    "Игрок 6",
    "Игрок 7",
    "Игрок 8",
    "Игрок 9",
    "Игрок 10",
    "Игрок 11",
    "Игрок 12",
  ]);
  expect(room.members).toHaveLength(12);

  const late = await newScenarioContext();
  const joined = await joinGameViaApi(late, room.code, "Лишний");
  await expectApiError(joined.response, 409, "GAME_FULL");

  const { state } = await getStateViaApi(room.members[0].ctx, room.code);
  expect(state.players).toHaveLength(12);
  expect(state.players.map((player) => player.name)).not.toContain("Лишний");
});

test("имя уже занято без учёта регистра и после NFKC-нормализации: NAME_TAKEN", async () => {
  // Регистр и внешние пробелы не различают имя.
  const cyrillic = await createLobbyApi(["Маша"]);
  const lowerCase = await joinGameViaApi(await newScenarioContext(), cyrillic.code, "мАША");
  await expectApiError(lowerCase.response, 409, "NAME_TAKEN");
  const padded = await joinGameViaApi(await newScenarioContext(), cyrillic.code, "  маша  ");
  await expectApiError(padded.response, 409, "NAME_TAKEN");

  // NFKC: é как одна кодовая точка и e + combining acute — одно имя;
  // лигатура ﬀ нормализуется к ff.
  const accents = await createLobbyApi(["élan"]);
  const combining = await joinGameViaApi(await newScenarioContext(), accents.code, "élan");
  await expectApiError(combining.response, 409, "NAME_TAKEN");
  const ligature = await createLobbyApi(["ﬀокус"]);
  const folded = await joinGameViaApi(await newScenarioContext(), ligature.code, "ffокус");
  await expectApiError(folded.response, 409, "NAME_TAKEN");

  // Состав комнат не изменился.
  for (const room of [cyrillic, accents, ligature]) {
    const { state } = await getStateViaApi(room.members[0].ctx, room.code);
    expect(state.players).toHaveLength(1);
  }
});

test("вход после старта отклонён; повторный вход своего участника — no-op", async () => {
  const room = await createLobbyApi(["Маша", "Петя", "Ваня"]);
  await toPlayingApi(room, ["самолёт", "поезд", "корабль"]);

  const late = await newScenarioContext();
  const joined = await joinGameViaApi(late, room.code, "Саша");
  await expectApiError(joined.response, 409, "INVALID_GAME_STATE");

  // Участник с действующей cookie повторно входит без дубликата и без смены
  // личности, даже если прислал другое имя.
  const pete = room.members[1];
  const again = await joinGameViaApi(pete.ctx, room.code, "Другой Петя");
  expect(again.response.status()).toBe(200);
  expect(again.state.viewer.playerId).toBe(pete.id);
  expect(again.state.players).toHaveLength(3);
  expect(again.state.players.map((player) => player.name)).toEqual(["Маша", "Петя", "Ваня"]);
});

test("двойная отправка и повтор угадывания после FINISHED сохраняют первый результат и ревизию", async ({
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
    for (const page of pages) await setReadyViaUi(page);
    await startGameViaUi(mashaPage);
    for (let index = 0; index < pages.length; index += 1) {
      await submitWordViaUi(pages[index], words[index], index === pages.length - 1);
    }

    const peteApi = await apiAs(contexts[1]);
    const base = await getStateViaApi(peteApi, code);
    const revisionBase = base.state.game.revision;

    // Реальный двойной submit: UI-клик по подтверждению отправляет запрос, и
    // повтор того же игрока через API уходит, пока UI-запрос ещё в полёте.
    await petePage.getByRole("button", { name: "Я угадал" }).click();
    await petePage.getByRole("alertdialog").getByRole("button", { name: "Я угадал" }).click();
    const apiReplay = await peteApi.post(`${API_PREFIX}/${code}/guessed`, { headers: originHeaders });
    expect(apiReplay.status(), "API-повтор принят идемпотентно").toBe(200);

    await expect(petePage.getByText("Вы уже угадали своё слово")).toBeVisible();
    const afterDouble = await getStateViaApi(peteApi, code);
    // Принято ровно одно событие: ревизия выросла на единицу независимо от
    // порядка двух запросов.
    expect(afterDouble.state.game.revision).toBe(revisionBase + 1);
    expect(
      afterDouble.state.players.find((player) => player.id === afterDouble.state.viewer.playerId)?.hasGuessed,
    ).toBe(true);

    // Остальные угадывают — игра завершается сама.
    await guessViaUi(vanyaPage);
    await guessViaUi(sashaPage);
    await guessViaUi(mashaPage);
    for (const page of pages) {
      await expect(page.getByRole("heading", { name: "Результаты" })).toBeVisible();
    }

    const finishedA = await getStateViaApi(peteApi, code);
    expect(finishedA.state.game.phase).toBe("FINISHED");
    const revisionFinished = finishedA.state.game.revision;
    const resultsA = finishedA.state.results ?? [];
    const peteResult = resultsA.find((result) => result.place === 1);
    expect(peteResult?.score).toBe(4);

    // Повтор угадывания уже после FINISHED: 200, те же место/очки/время,
    // ревизия не двигается.
    const replayAfterFinish = await peteApi.post(`${API_PREFIX}/${code}/guessed`, { headers: originHeaders });
    expect(replayAfterFinish.status()).toBe(200);
    const finishedB = await getStateViaApi(peteApi, code);
    expect(finishedB.state.game.revision).toBe(revisionFinished);
    expect(finishedB.state.results).toEqual(resultsA satisfies ResultItem[]);

    expect(consoleErrors).toEqual([]);
  } finally {
    await close();
  }
});

test("одновременные угадывания независимых игроков получают уникальные последовательные места", async () => {
  const room = await createLobbyApi(["Маша", "Петя", "Ваня", "Саша"]);
  await toPlayingApi(room, ["самолёт", "поезд", "телескоп", "барабан"]);

  const { state: base } = await getStateViaApi(room.members[0].ctx, room.code);
  expect(base.game.phase).toBe("PLAYING");
  const revisionBase = base.game.revision;

  const accepted = await Promise.all(
    room.members.map((member) =>
      member.ctx.post(`${API_PREFIX}/${room.code}/guessed`, { headers: originHeaders }),
    ),
  );
  for (const response of accepted) expect(response.status()).toBe(200);

  const { state: finished } = await getStateViaApi(room.members[0].ctx, room.code);
  expect(finished.game.phase).toBe("FINISHED");
  // Каждое принятое событие увеличило ревизию ровно на единицу.
  expect(finished.game.revision).toBe(revisionBase + 4);

  const results = finished.results ?? [];
  expect(results).toHaveLength(4);
  const places = results.map((result) => result.place);
  expect([...places].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4]);
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    expect(result.place).toBe(index + 1);
    expect(result.score).toBe(4 - index); // N - place + 1
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  }
  // Места уникальны и принадлежат ровно одному игроку.
  expect(new Set(places).size).toBe(4);
  expect(new Set(results.map((result) => result.playerId)).size).toBe(4);
});

test("гонка угадывания и досрочного завершения согласована при любом порядке блокировки", async () => {
  const observedOrders: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const room = await createLobbyApi(["Маша", "Петя", "Ваня", "Саша"]);
    await toPlayingApi(room, ["самолёт", "поезд", "телескоп", "барабан"]);
    const host = room.members[0];
    const guesser = room.members[1];

    const { state: base } = await getStateViaApi(host.ctx, room.code);
    const revisionBase = base.game.revision;

    const [guessResponse, finishResponse] = await Promise.all([
      guesser.ctx.post(`${API_PREFIX}/${room.code}/guessed`, { headers: originHeaders }),
      host.ctx.post(`${API_PREFIX}/${room.code}/finish`, { headers: originHeaders }),
    ]);

    // Завершение админа всегда успешно; угадывание либо успело войти в
    // транзакцию до завершения (200), либо отклонено как результат после
    // FINISHED (409 INVALID_GAME_STATE).
    expect(finishResponse.status(), `попытка ${attempt}: finish`).toBe(200);
    expect([200, 409], `попытка ${attempt}: допустимый исход guessed`).toContain(guessResponse.status());

    const { state: final } = await getStateViaApi(host.ctx, room.code);
    expect(final.game.phase).toBe("FINISHED");
    const results = final.results ?? [];
    expect(results).toHaveLength(4);
    const placed = results.filter((result) => result.place !== null);

    if (guessResponse.status() === 200) {
      // Угадывание зафиксировано первым: угадал занял единственное место,
      // завершение добавило нулевые результата остальным.
      observedOrders.push("guessed-first");
      expect(final.game.revision).toBe(revisionBase + 2);
      expect(placed).toHaveLength(1);
      expect(placed[0]).toMatchObject({ playerId: guesser.id, place: 1, score: 4 });
      expect(placed[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(
        results
          .filter((result) => result.playerId !== guesser.id)
          .every((result) => result.place === null && result.score === 0 && result.durationMs === null),
      ).toBe(true);
    } else {
      // Завершение зафиксировано первым: угадывание после FINISHED отклонено,
      // все четверо получают нулевые результаты.
      observedOrders.push("finish-first");
      const body = (await guessResponse.json()) as GameStateResponse | { error: { code: string } };
      expect("error" in body ? body.error.code : "").toBe("INVALID_GAME_STATE");
      expect(final.game.revision).toBe(revisionBase + 1);
      expect(placed).toHaveLength(0);
      expect(results.every((result) => result.place === null && result.score === 0)).toBe(true);
    }
    // Места всегда уникальны и последовательны.
    const placeNumbers = placed.map((result) => result.place);
    expect(new Set(placeNumbers).size).toBe(placed.length);
  }

  console.log(`race outcomes: ${observedOrders.join(", ")}`);
});
