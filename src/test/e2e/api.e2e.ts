import { expect, test } from "@playwright/test";

import type { GameStateResponse } from "../../shared/contracts/game";
import {
  API_PREFIX,
  createGameViaApi,
  createLobbyOfThree,
  expectApiError,
  expectNoStore,
  getStateViaApi,
  joinGameViaApi,
  newScenarioContext,
  nextScenarioIp,
  originHeaders,
  setCookieHeader,
  startAssigningWords,
  startPlaying,
} from "./helpers";

const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("POST /games: 201, персональный DTO и защищённая cookie сессии", async () => {
  const ctx = await newScenarioContext();
  const { response, state } = await createGameViaApi(ctx, "Маша");

  expect(response.status()).toBe(201);
  expectNoStore(response);
  expect(state.game.code).toMatch(CODE_PATTERN);
  expect(state.game.type).toBe("WORD_CHAIN");
  expect(state.game.phase).toBe("LOBBY");
  expect(state.game.minPlayers).toBe(3);
  expect(state.game.maxPlayers).toBe(12);
  expect(state.game.settings.hideTargetNamesDuringSetup).toBe(false);
  expect(state.game.startedAt).toBeNull();
  expect(state.viewer.playerId).toMatch(UUID_PATTERN);
  expect(state.players).toHaveLength(1);
  expect(state.players[0]).toMatchObject({
    name: "Маша",
    isHost: true,
    isReady: false,
    hasSubmittedWord: false,
    hasGuessed: false,
  });
  expect(state.setup).toBeNull();
  expect(state.hints).toBeNull();
  expect(state.results).toBeNull();
  expect(state.capabilities).toMatchObject({
    canEditSettings: true,
    canManagePlayers: true,
    canStart: false,
    canSubmitWord: false,
    canMarkGuessed: false,
    canFinish: false,
    canCancel: false,
    canRestart: false,
    canLeave: true,
  });

  const setCookie = setCookieHeader(response);
  expect(setCookie).toContain("wg_session=");
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(setCookie).toMatch(/Secure/i);
  expect(setCookie).toMatch(/SameSite=Lax/i);
  expect(setCookie).toMatch(/Path=\//i);
  expect(setCookie).toMatch(/Max-Age=604800/i);

  // Cookie действует: повторный запрос состояния той же сессией
  const me = await getStateViaApi(ctx, state.game.code);
  expect(me.response.status()).toBe(200);
  expect(me.state.viewer.playerId).toBe(state.viewer.playerId);
});

test("POST /games: 400 VALIDATION_ERROR с fieldErrors на некорректные поля", async () => {
  const ctx = await newScenarioContext();

  const missingName = await ctx.post(API_PREFIX, { data: {}, headers: originHeaders });
  const missingBody = await expectApiError(missingName, 400, "VALIDATION_ERROR");
  expect(missingBody.error.fieldErrors?.name).toBeTruthy();

  const unknownField = await ctx.post(API_PREFIX, {
    data: { name: "Маша", admin: true },
    headers: originHeaders,
  });
  const unknownBody = await expectApiError(unknownField, 400, "VALIDATION_ERROR");
  expect(unknownBody.error.fieldErrors?.admin).toBeTruthy();

  const badType = await ctx.post(API_PREFIX, {
    data: { name: "Маша", gameType: "CHESS" },
    headers: originHeaders,
  });
  await expectApiError(badType, 400, "VALIDATION_ERROR");

  const badNameType = await ctx.post(API_PREFIX, { data: { name: 42 }, headers: originHeaders });
  const badNameBody = await expectApiError(badNameType, 400, "VALIDATION_ERROR");
  expect(badNameBody.error.fieldErrors?.name).toBeTruthy();

  const longName = await ctx.post(API_PREFIX, {
    data: { name: "а".repeat(25) },
    headers: originHeaders,
  });
  const longNameBody = await expectApiError(longName, 400, "VALIDATION_ERROR");
  expect(longNameBody.error.fieldErrors?.name).toBeTruthy();
});

test("POST /games: 400 на неверный Content-Type, пустое или битое тело", async () => {
  const ctx = await newScenarioContext();

  const textPlain = await ctx.post(API_PREFIX, {
    data: "name=Маша",
    headers: { ...originHeaders, "content-type": "text/plain" },
  });
  await expectApiError(textPlain, 400, "VALIDATION_ERROR");

  const empty = await ctx.post(API_PREFIX, {
    data: "",
    headers: { ...originHeaders, "content-type": "application/json" },
  });
  await expectApiError(empty, 400, "VALIDATION_ERROR");

  const malformed = await ctx.post(API_PREFIX, {
    data: "{oops",
    headers: { ...originHeaders, "content-type": "application/json" },
  });
  await expectApiError(malformed, 400, "VALIDATION_ERROR");
});

test("POST /games: 400 ORIGIN_REJECTED без Origin и с чужим Origin", async () => {
  const ctx = await newScenarioContext();

  const absent = await ctx.post(API_PREFIX, { data: { name: "Маша" } });
  await expectApiError(absent, 400, "ORIGIN_REJECTED");

  const mismatch = await ctx.post(API_PREFIX, {
    data: { name: "Маша" },
    headers: { origin: "https://evil.example" },
  });
  await expectApiError(mismatch, 400, "ORIGIN_REJECTED");
});

test("POST /join: 200 и cookie; повторный join по cookie — no-op без смены личности", async () => {
  const host = await newScenarioContext();
  const created = await createGameViaApi(host, "Маша");
  const code = created.state.game.code;

  const pete = await newScenarioContext();
  const joined = await joinGameViaApi(pete, code, "Петя");
  expect(joined.response.status()).toBe(200);
  expectNoStore(joined.response);
  expect(setCookieHeader(joined.response)).toContain("wg_session=");
  expect(joined.state.players).toHaveLength(2);
  expect(joined.state.players.map((player) => player.name)).toEqual(["Маша", "Петя"]);
  const peteId = joined.state.viewer.playerId;

  const again = await joinGameViaApi(pete, code, "Другой Петя");
  expect(again.response.status()).toBe(200);
  expect(again.state.viewer.playerId).toBe(peteId);
  expect(again.state.players).toHaveLength(2);
  expect(again.state.players.map((player) => player.name)).toEqual(["Маша", "Петя"]);
});

test("POST /join: 404 на несуществующую комнату, 400 на некорректный код, 409 на занятое имя", async () => {
  const host = await newScenarioContext();
  const created = await createGameViaApi(host, "Маша");
  const code = created.state.game.code;

  const stranger = await newScenarioContext();
  const notFound = await joinGameViaApi(stranger, "ZZZZZZ", "Петя");
  await expectApiError(notFound.response, 404, "GAME_NOT_FOUND");

  const badCode = await joinGameViaApi(stranger, "ab1", "Петя");
  const badCodeBody = await expectApiError(badCode.response, 400, "VALIDATION_ERROR");
  expect(badCodeBody.error.fieldErrors?.code).toBeTruthy();

  const duplicate = await newScenarioContext();
  const taken = await joinGameViaApi(duplicate, code, "  маша ");
  const takenBody = await expectApiError(taken.response, 409, "NAME_TAKEN");
  expect(takenBody.error.fieldErrors?.name).toBeTruthy();
});

test("POST /join в комнату не в LOBBY возвращает 409 INVALID_GAME_STATE", async () => {
  const lobby = await createLobbyOfThree();
  await startAssigningWords(lobby);

  const late = await newScenarioContext();
  const joined = await joinGameViaApi(late, lobby.code, "Саша");
  await expectApiError(joined.response, 409, "INVALID_GAME_STATE");
});

test("GET /state: персональный DTO, no-store, код нормализуется, 401/403/404", async () => {
  const host = await newScenarioContext();
  const created = await createGameViaApi(host, "Маша");
  const code = created.state.game.code;

  const ok = await getStateViaApi(host, code.toLowerCase());
  expect(ok.response.status()).toBe(200);
  expectNoStore(ok.response);
  expect(ok.state.viewer.playerId).toBe(created.state.viewer.playerId);

  // GET не mutation: Origin не требуется
  const noOrigin = await host.get(`${API_PREFIX}/${code}/state`);
  expect(noOrigin.status()).toBe(200);

  const anonymous = await newScenarioContext();
  const unauthenticated = await getStateViaApi(anonymous, code);
  await expectApiError(unauthenticated.response, 401, "UNAUTHENTICATED");

  const outsider = await newScenarioContext();
  await createGameViaApi(outsider, "Петя");
  const forbidden = await getStateViaApi(outsider, code);
  await expectApiError(forbidden.response, 403, "FORBIDDEN");

  const missing = await getStateViaApi(host, "ZZZZZZ");
  await expectApiError(missing.response, 404, "GAME_NOT_FOUND");
});

test("PATCH /settings: только админ в LOBBY; повтор того же значения без ревизии", async () => {
  const lobby = await createLobbyOfThree();

  const forbidden = await lobby.second.patch(`${API_PREFIX}/${lobby.code}/settings`, {
    data: { hideTargetNamesDuringSetup: true },
    headers: originHeaders,
  });
  await expectApiError(forbidden, 403, "FORBIDDEN");

  const anonymous = await newScenarioContext();
  const unauthenticated = await anonymous.patch(`${API_PREFIX}/${lobby.code}/settings`, {
    data: { hideTargetNamesDuringSetup: true },
    headers: originHeaders,
  });
  await expectApiError(unauthenticated, 401, "UNAUTHENTICATED");

  const updated = await lobby.host.patch(`${API_PREFIX}/${lobby.code}/settings`, {
    data: { hideTargetNamesDuringSetup: true },
    headers: originHeaders,
  });
  expect(updated.status()).toBe(200);
  const state = (await updated.json()) as GameStateResponse;
  expect(state.game.settings.hideTargetNamesDuringSetup).toBe(true);

  const sameAgain = await lobby.host.patch(`${API_PREFIX}/${lobby.code}/settings`, {
    data: { hideTargetNamesDuringSetup: true },
    headers: originHeaders,
  });
  expect(sameAgain.status()).toBe(200);
  expect(((await sameAgain.json()) as GameStateResponse).game.revision).toBe(state.game.revision);
});

test("PATCH /settings после старта возвращает 409 INVALID_GAME_STATE", async () => {
  const lobby = await createLobbyOfThree();
  await startAssigningWords(lobby);

  const conflict = await lobby.host.patch(`${API_PREFIX}/${lobby.code}/settings`, {
    data: { hideTargetNamesDuringSetup: true },
    headers: originHeaders,
  });
  await expectApiError(conflict, 409, "INVALID_GAME_STATE");
});

test("POST /readiness: своя готовность, личность не из тела, строгая валидация, 401/403", async () => {
  const lobby = await createLobbyOfThree();

  const ready = await lobby.second.post(`${API_PREFIX}/${lobby.code}/readiness`, {
    data: { ready: true },
    headers: originHeaders,
  });
  expect(ready.status()).toBe(200);
  const state = (await ready.json()) as GameStateResponse;
  expect(state.viewer.playerId).toBe(lobby.secondId);
  expect(state.players.find((player) => player.id === lobby.secondId)?.isReady).toBe(true);
  expect(state.players.find((player) => player.id === lobby.hostId)?.isReady).toBe(false);

  const repeat = await lobby.second.post(`${API_PREFIX}/${lobby.code}/readiness`, {
    data: { ready: true },
    headers: originHeaders,
  });
  expect(repeat.status()).toBe(200);
  expect(((await repeat.json()) as GameStateResponse).game.revision).toBe(state.game.revision);

  const withPlayerId = await lobby.second.post(`${API_PREFIX}/${lobby.code}/readiness`, {
    data: { ready: false, playerId: lobby.hostId },
    headers: originHeaders,
  });
  const withPlayerIdBody = await expectApiError(withPlayerId, 400, "VALIDATION_ERROR");
  expect(withPlayerIdBody.error.fieldErrors?.playerId).toBeTruthy();

  const badType = await lobby.second.post(`${API_PREFIX}/${lobby.code}/readiness`, {
    data: { ready: "yes" },
    headers: originHeaders,
  });
  const badTypeBody = await expectApiError(badType, 400, "VALIDATION_ERROR");
  expect(badTypeBody.error.fieldErrors?.ready).toBeTruthy();

  const empty = await lobby.second.post(`${API_PREFIX}/${lobby.code}/readiness`, {
    data: "",
    headers: { ...originHeaders, "content-type": "application/json" },
  });
  await expectApiError(empty, 400, "VALIDATION_ERROR");

  const outsider = await newScenarioContext();
  await createGameViaApi(outsider, "Саша");
  const forbidden = await outsider.post(`${API_PREFIX}/${lobby.code}/readiness`, {
    data: { ready: true },
    headers: originHeaders,
  });
  await expectApiError(forbidden, 403, "FORBIDDEN");

  const anonymous = await newScenarioContext();
  const unauthenticated = await anonymous.post(`${API_PREFIX}/${lobby.code}/readiness`, {
    data: { ready: true },
    headers: originHeaders,
  });
  await expectApiError(unauthenticated, 401, "UNAUTHENTICATED");
});

test("mutation без тела отклоняют любое содержимое запроса", async () => {
  const lobby = await createLobbyOfThree();

  const jsonBody = await lobby.host.post(`${API_PREFIX}/${lobby.code}/start`, {
    data: {},
    headers: { ...originHeaders, "content-type": "application/json" },
  });
  await expectApiError(jsonBody, 400, "VALIDATION_ERROR");

  const textBody = await lobby.host.post(`${API_PREFIX}/${lobby.code}/start`, {
    data: "start",
    headers: { ...originHeaders, "content-type": "text/plain" },
  });
  await expectApiError(textBody, 400, "VALIDATION_ERROR");
});

test("mutation без Origin отклоняются независимо от маршрута", async () => {
  const lobby = await createLobbyOfThree();

  const noOrigin = await lobby.host.post(`${API_PREFIX}/${lobby.code}/guessed`);
  await expectApiError(noOrigin, 400, "ORIGIN_REJECTED");
});

test("POST /start: 403 не-админу, 409 до готовности, 200 админу в ASSIGNING_WORDS", async () => {
  const host = await newScenarioContext();
  const created = await createGameViaApi(host, "Маша");
  const code = created.state.game.code;
  const second = await newScenarioContext();
  await joinGameViaApi(second, code, "Петя");

  const notEnough = await host.post(`${API_PREFIX}/${code}/start`, { headers: originHeaders });
  await expectApiError(notEnough, 409, "NOT_ENOUGH_PLAYERS");

  const third = await newScenarioContext();
  await joinGameViaApi(third, code, "Ваня");
  const notReady = await host.post(`${API_PREFIX}/${code}/start`, { headers: originHeaders });
  await expectApiError(notReady, 409, "NOT_ALL_READY");

  for (const player of [host, second, third]) {
    await player.post(`${API_PREFIX}/${code}/readiness`, {
      data: { ready: true },
      headers: originHeaders,
    });
  }
  const forbidden = await second.post(`${API_PREFIX}/${code}/start`, { headers: originHeaders });
  await expectApiError(forbidden, 403, "FORBIDDEN");

  const started = await host.post(`${API_PREFIX}/${code}/start`, { headers: originHeaders });
  expect(started.status()).toBe(200);
  const state = (await started.json()) as GameStateResponse;
  expect(state.game.phase).toBe("ASSIGNING_WORDS");
  expect(state.game.startedAt).toBeTruthy();
  expect(state.setup?.target).toBeTruthy();
  expect(state.setup?.targetHidden).toBe(false);
  expect(state.setup?.word).toBeNull();
  expect(state.hints).toBeNull();
  expect(state.capabilities.canSubmitWord).toBe(true);

  const repeat = await host.post(`${API_PREFIX}/${code}/start`, { headers: originHeaders });
  await expectApiError(repeat, 409, "INVALID_GAME_STATE");
});

test("PUT /word: upsert с нормализацией, повтор без ревизии, валидация слова", async () => {
  const lobby = await createLobbyOfThree();
  await startAssigningWords(lobby);

  const tooLong = await lobby.host.put(`${API_PREFIX}/${lobby.code}/word`, {
    data: { word: "а".repeat(81) },
    headers: originHeaders,
  });
  const tooLongBody = await expectApiError(tooLong, 400, "VALIDATION_ERROR");
  expect(tooLongBody.error.fieldErrors?.word).toBeTruthy();

  const first = await lobby.host.put(`${API_PREFIX}/${lobby.code}/word`, {
    data: { word: "  Самолёт  " },
    headers: originHeaders,
  });
  expect(first.status()).toBe(200);
  const firstState = (await first.json()) as GameStateResponse;
  expect(firstState.setup?.word).toBe("Самолёт");
  expect(firstState.players[0].hasSubmittedWord).toBe(true);
  expect(firstState.game.phase).toBe("ASSIGNING_WORDS");
  const revision = firstState.game.revision;

  const same = await lobby.host.put(`${API_PREFIX}/${lobby.code}/word`, {
    data: { word: "Самолёт" },
    headers: originHeaders,
  });
  expect(same.status()).toBe(200);
  expect(((await same.json()) as GameStateResponse).game.revision).toBe(revision);

  const edit = await lobby.host.put(`${API_PREFIX}/${lobby.code}/word`, {
    data: { word: "Поезд" },
    headers: originHeaders,
  });
  expect(edit.status()).toBe(200);
  expect(((await edit.json()) as GameStateResponse).setup?.word).toBe("Поезд");
});

test("PUT /word: 409 вне ASSIGNING_WORDS, 403 чужаку", async () => {
  const lobby = await createLobbyOfThree();

  const inLobby = await lobby.host.put(`${API_PREFIX}/${lobby.code}/word`, {
    data: { word: "Самолёт" },
    headers: originHeaders,
  });
  await expectApiError(inLobby, 409, "INVALID_GAME_STATE");

  await startAssigningWords(lobby);
  const outsider = await newScenarioContext();
  await createGameViaApi(outsider, "Саша");
  const forbidden = await outsider.put(`${API_PREFIX}/${lobby.code}/word`, {
    data: { word: "Самолёт" },
    headers: originHeaders,
  });
  await expectApiError(forbidden, 403, "FORBIDDEN");
});

test("PLAYING: подсказки скрывают ровно собственное слово каждого зрителя", async () => {
  const lobby = await createLobbyOfThree();
  await startPlaying(lobby, ["самолёт", "поезд", "корабль"]);

  const viewers = [
    { ctx: lobby.host, ownId: lobby.hostId },
    { ctx: lobby.second, ownId: lobby.secondId },
    { ctx: lobby.third, ownId: lobby.thirdId },
  ];
  for (const { ctx, ownId } of viewers) {
    const { state } = await getStateViaApi(ctx, lobby.code);
    expect(state.game.phase).toBe("PLAYING");
    expect(state.setup).toBeNull();
    expect(state.hints).toHaveLength(3);
    const own = (state.hints ?? []).filter((hint) => hint.target.id === ownId);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ word: null, wordHidden: true });
    const others = (state.hints ?? []).filter((hint) => hint.target.id !== ownId);
    expect(others).toHaveLength(2);
    expect(
      others.every(
        (hint) => hint.wordHidden === false && typeof hint.word === "string" && hint.word.length > 0,
      ),
    ).toBe(true);
    expect(state.results).toBeNull();
    expect(state.capabilities.canMarkGuessed).toBe(true);
  }
});

test("скрытие адресатов: setup.targetHidden до старта, полные подсказки в PLAYING", async () => {
  const lobby = await createLobbyOfThree();
  await lobby.host.patch(`${API_PREFIX}/${lobby.code}/settings`, {
    data: { hideTargetNamesDuringSetup: true },
    headers: originHeaders,
  });
  await startAssigningWords(lobby);

  const { state } = await getStateViaApi(lobby.host, lobby.code);
  expect(state.setup?.target).toBeNull();
  expect(state.setup?.targetHidden).toBe(true);

  const players = [lobby.host, lobby.second, lobby.third];
  const words = ["самолёт", "поезд", "корабль"];
  for (let index = 0; index < players.length; index += 1) {
    const response = await players[index].put(`${API_PREFIX}/${lobby.code}/word`, {
      data: { word: words[index] },
      headers: originHeaders,
    });
    expect(response.status()).toBe(200);
  }
  const playing = await getStateViaApi(lobby.second, lobby.code);
  expect(playing.state.game.phase).toBe("PLAYING");
  // В PLAYING собственное слово зрителя всё ещё скрыто, остальные видимы.
  const own = (playing.state.hints ?? []).filter((hint) => hint.target.id === lobby.secondId);
  expect(own).toHaveLength(1);
  expect(own[0]).toMatchObject({ word: null, wordHidden: true });
  const others = (playing.state.hints ?? []).filter((hint) => hint.target.id !== lobby.secondId);
  expect(others.every((hint) => hint.wordHidden === false && hint.word !== null)).toBe(true);
});

test("POST /guessed: идемпотентен, последнее угадывание завершает игру", async () => {
  const lobby = await createLobbyOfThree();
  await startPlaying(lobby, ["самолёт", "поезд", "корабль"]);

  const first = await lobby.second.post(`${API_PREFIX}/${lobby.code}/guessed`, {
    headers: originHeaders,
  });
  expect(first.status()).toBe(200);
  let state = (await first.json()) as GameStateResponse;
  expect(state.game.phase).toBe("PLAYING");
  expect(state.results).toBeNull();
  expect(state.players.find((player) => player.id === lobby.secondId)?.hasGuessed).toBe(true);
  const revision = state.game.revision;

  const repeat = await lobby.second.post(`${API_PREFIX}/${lobby.code}/guessed`, {
    headers: originHeaders,
  });
  expect(repeat.status()).toBe(200);
  expect(((await repeat.json()) as GameStateResponse).game.revision).toBe(revision);

  await lobby.host.post(`${API_PREFIX}/${lobby.code}/guessed`, { headers: originHeaders });
  const last = await lobby.third.post(`${API_PREFIX}/${lobby.code}/guessed`, {
    headers: originHeaders,
  });
  expect(last.status()).toBe(200);
  state = (await last.json()) as GameStateResponse;
  expect(state.game.phase).toBe("FINISHED");
  expect(state.results).toHaveLength(3);
  const places = (state.results ?? [])
    .map((result) => result.place)
    .sort((a, b) => (a ?? 0) - (b ?? 0));
  expect(places).toEqual([1, 2, 3]);
  const winner = (state.results ?? []).find((result) => result.place === 1);
  expect(winner?.playerId).toBe(lobby.secondId);
  expect(winner?.score).toBe(3);
  expect(winner?.durationMs).toBeGreaterThanOrEqual(0);
  expect(
    (state.hints ?? []).every((hint) => hint.wordHidden === false && hint.word !== null),
  ).toBe(true);

  const afterFinish = await lobby.third.post(`${API_PREFIX}/${lobby.code}/guessed`, {
    headers: originHeaders,
  });
  expect(afterFinish.status()).toBe(200);
  expect(((await afterFinish.json()) as GameStateResponse).game.revision).toBe(state.game.revision);
});

test("POST /guessed вне PLAYING возвращает 409 INVALID_GAME_STATE", async () => {
  const lobby = await createLobbyOfThree();

  const inLobby = await lobby.host.post(`${API_PREFIX}/${lobby.code}/guessed`, {
    headers: originHeaders,
  });
  await expectApiError(inLobby, 409, "INVALID_GAME_STATE");

  await startAssigningWords(lobby);
  const inAssigning = await lobby.host.post(`${API_PREFIX}/${lobby.code}/guessed`, {
    headers: originHeaders,
  });
  await expectApiError(inAssigning, 409, "INVALID_GAME_STATE");
});

test("POST /finish: 403 не-админу, 200 админу, не угадавшие получают 0 без места", async () => {
  const lobby = await createLobbyOfThree();

  const inLobby = await lobby.host.post(`${API_PREFIX}/${lobby.code}/finish`, {
    headers: originHeaders,
  });
  await expectApiError(inLobby, 409, "INVALID_GAME_STATE");

  await startPlaying(lobby, ["самолёт", "поезд", "корабль"]);

  const forbidden = await lobby.second.post(`${API_PREFIX}/${lobby.code}/finish`, {
    headers: originHeaders,
  });
  await expectApiError(forbidden, 403, "FORBIDDEN");

  await lobby.second.post(`${API_PREFIX}/${lobby.code}/guessed`, { headers: originHeaders });
  const finished = await lobby.host.post(`${API_PREFIX}/${lobby.code}/finish`, {
    headers: originHeaders,
  });
  expect(finished.status()).toBe(200);
  const state = (await finished.json()) as GameStateResponse;
  expect(state.game.phase).toBe("FINISHED");
  expect(state.results).toHaveLength(3);
  const winner = (state.results ?? []).find((result) => result.playerId === lobby.secondId);
  expect(winner).toMatchObject({ place: 1, score: 3 });
  const missing = (state.results ?? []).filter((result) => result.place === null);
  expect(missing).toHaveLength(2);
  expect(missing.every((result) => result.score === 0 && result.durationMs === null)).toBe(true);

  const repeat = await lobby.host.post(`${API_PREFIX}/${lobby.code}/finish`, {
    headers: originHeaders,
  });
  await expectApiError(repeat, 409, "INVALID_GAME_STATE");
});

test("POST /cancel: 403 не-админу, 200 админу возвращает в LOBBY и очищает попытку", async () => {
  const lobby = await createLobbyOfThree();
  await startAssigningWords(lobby);
  await lobby.host.put(`${API_PREFIX}/${lobby.code}/word`, {
    data: { word: "самолёт" },
    headers: originHeaders,
  });

  const forbidden = await lobby.second.post(`${API_PREFIX}/${lobby.code}/cancel`, {
    headers: originHeaders,
  });
  await expectApiError(forbidden, 403, "FORBIDDEN");

  const cancelled = await lobby.host.post(`${API_PREFIX}/${lobby.code}/cancel`, {
    headers: originHeaders,
  });
  expect(cancelled.status()).toBe(200);
  const state = (await cancelled.json()) as GameStateResponse;
  expect(state.game.phase).toBe("LOBBY");
  expect(state.game.startedAt).toBeNull();
  expect(state.setup).toBeNull();
  expect(state.hints).toBeNull();
  expect(state.results).toBeNull();
  expect(state.players.every((player) => !player.isReady && !player.hasSubmittedWord)).toBe(true);

  const repeat = await lobby.host.post(`${API_PREFIX}/${lobby.code}/cancel`, {
    headers: originHeaders,
  });
  await expectApiError(repeat, 409, "INVALID_GAME_STATE");

  await startAssigningWords(lobby);
  const { state: restarted } = await getStateViaApi(lobby.host, lobby.code);
  expect(restarted.game.phase).toBe("ASSIGNING_WORDS");
});

test("POST /restart: 409 в ACTIVE, 403 не-админу в FINISHED, 200 админу возвращает в LOBBY, повтор — no-op", async () => {
  const lobby = await createLobbyOfThree();
  await startPlaying(lobby, ["самолёт", "поезд", "корабль"]);

  // В ACTIVE (PLAYING) админу — 409: раунд не сброшен, ревизия прежняя.
  const { state: beforeConflict } = await getStateViaApi(lobby.host, lobby.code);
  const inPlaying = await lobby.host.post(`${API_PREFIX}/${lobby.code}/restart`, {
    headers: originHeaders,
  });
  await expectApiError(inPlaying, 409, "INVALID_GAME_STATE");
  const { state: afterConflict } = await getStateViaApi(lobby.host, lobby.code);
  expect(afterConflict.game.revision).toBe(beforeConflict.game.revision);
  expect(afterConflict.game.phase).toBe("PLAYING");
  expect(afterConflict.hints).toHaveLength(3);

  // Досрочное завершение → FINISHED.
  const finished = await lobby.host.post(`${API_PREFIX}/${lobby.code}/finish`, {
    headers: originHeaders,
  });
  expect(finished.status()).toBe(200);
  const finishedState = (await finished.json()) as GameStateResponse;
  expect(finishedState.game.phase).toBe("FINISHED");
  expect(finishedState.capabilities.canRestart).toBe(true);

  // Без cookie — 401; без Origin — 400 ORIGIN_REJECTED.
  const anonymous = await newScenarioContext();
  const unauthenticated = await anonymous.post(`${API_PREFIX}/${lobby.code}/restart`, {
    headers: originHeaders,
  });
  await expectApiError(unauthenticated, 401, "UNAUTHENTICATED");

  const noOrigin = await lobby.host.post(`${API_PREFIX}/${lobby.code}/restart`);
  await expectApiError(noOrigin, 400, "ORIGIN_REJECTED");

  // Не-админ в FINISHED — 403, состояние комнаты неизменно.
  const forbidden = await lobby.second.post(`${API_PREFIX}/${lobby.code}/restart`, {
    headers: originHeaders,
  });
  await expectApiError(forbidden, 403, "FORBIDDEN");
  const { state: afterForbidden } = await getStateViaApi(lobby.host, lobby.code);
  expect(afterForbidden.game.revision).toBe(finishedState.game.revision);
  expect(afterForbidden.game.phase).toBe("FINISHED");

  // Админ в FINISHED — 200: попытка очищена, состав, код и настройки сохранены.
  const restarted = await lobby.host.post(`${API_PREFIX}/${lobby.code}/restart`, {
    headers: originHeaders,
  });
  expect(restarted.status()).toBe(200);
  expectNoStore(restarted);
  const state = (await restarted.json()) as GameStateResponse;
  expect(state.game.phase).toBe("LOBBY");
  expect(state.game.revision).toBe(finishedState.game.revision + 1);
  expect(state.game.startedAt).toBeNull();
  expect(state.game.finishedAt).toBeNull();
  expect(state.setup).toBeNull();
  expect(state.hints).toBeNull();
  expect(state.results).toBeNull();
  expect(state.players.map((player) => player.id)).toEqual([
    lobby.hostId,
    lobby.secondId,
    lobby.thirdId,
  ]);
  expect(state.players.every((player) => !player.isReady && !player.hasSubmittedWord && !player.hasGuessed)).toBe(
    true,
  );
  expect(state.capabilities.canRestart).toBe(false);
  expect(state.capabilities.canLeave).toBe(true);

  // Повторный restart в LOBBY — no-op: 200 без новой ревизии.
  const repeat = await lobby.host.post(`${API_PREFIX}/${lobby.code}/restart`, {
    headers: originHeaders,
  });
  expect(repeat.status()).toBe(200);
  expectNoStore(repeat);
  expect(((await repeat.json()) as GameStateResponse).game.revision).toBe(state.game.revision);
});

test("DELETE /players/{playerId}: только админ, удалённый теряет доступ (401)", async () => {
  const lobby = await createLobbyOfThree();

  const forbidden = await lobby.second.delete(`${API_PREFIX}/${lobby.code}/players/${lobby.thirdId}`, {
    headers: originHeaders,
  });
  await expectApiError(forbidden, 403, "FORBIDDEN");

  const self = await lobby.host.delete(`${API_PREFIX}/${lobby.code}/players/${lobby.hostId}`, {
    headers: originHeaders,
  });
  await expectApiError(self, 403, "FORBIDDEN");

  const missing = await lobby.host.delete(
    `${API_PREFIX}/${lobby.code}/players/9f2a4b1c-8d3e-4a5f-9b7c-1234567890ab`,
    { headers: originHeaders },
  );
  await expectApiError(missing, 404, "PLAYER_NOT_FOUND");

  const malformed = await lobby.host.delete(`${API_PREFIX}/${lobby.code}/players/not-a-uuid`, {
    headers: originHeaders,
  });
  await expectApiError(malformed, 404, "PLAYER_NOT_FOUND");
  const afterMalformed = await getStateViaApi(lobby.host, lobby.code);
  expect(afterMalformed.state.players).toHaveLength(3);

  const removed = await lobby.host.delete(`${API_PREFIX}/${lobby.code}/players/${lobby.thirdId}`, {
    headers: originHeaders,
  });
  expect(removed.status()).toBe(200);
  const state = (await removed.json()) as GameStateResponse;
  expect(state.viewer.playerId).toBe(lobby.hostId);
  expect(state.players.map((player) => player.id)).toEqual([lobby.hostId, lobby.secondId]);

  const kickedOut = await getStateViaApi(lobby.third, lobby.code);
  await expectApiError(kickedOut.response, 401, "UNAUTHENTICATED");

  const withBody = await lobby.host.delete(`${API_PREFIX}/${lobby.code}/players/${lobby.secondId}`, {
    data: {},
    headers: { ...originHeaders, "content-type": "application/json" },
  });
  await expectApiError(withBody, 400, "VALIDATION_ERROR");
});

test("POST /leave: 204 очищает cookie; последний игрок удаляет комнату", async () => {
  const lobby = await createLobbyOfThree();

  const anonymous = await newScenarioContext();
  const unauthenticated = await anonymous.post(`${API_PREFIX}/${lobby.code}/leave`, {
    headers: originHeaders,
  });
  await expectApiError(unauthenticated, 401, "UNAUTHENTICATED");

  const outsider = await newScenarioContext();
  await createGameViaApi(outsider, "Петя");
  const forbidden = await outsider.post(`${API_PREFIX}/${lobby.code}/leave`, {
    headers: originHeaders,
  });
  await expectApiError(forbidden, 403, "FORBIDDEN");

  const left = await lobby.third.post(`${API_PREFIX}/${lobby.code}/leave`, {
    headers: originHeaders,
  });
  expect(left.status()).toBe(204);
  const cleared = setCookieHeader(left);
  expect(cleared).toMatch(/wg_session=/i);
  expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);

  const gone = await getStateViaApi(lobby.third, lobby.code);
  await expectApiError(gone.response, 401, "UNAUTHENTICATED");

  await lobby.second.post(`${API_PREFIX}/${lobby.code}/leave`, { headers: originHeaders });
  const last = await lobby.host.post(`${API_PREFIX}/${lobby.code}/leave`, {
    headers: originHeaders,
  });
  expect(last.status()).toBe(204);

  const rejoiner = await newScenarioContext();
  const rejoin = await joinGameViaApi(rejoiner, lobby.code, "Саша");
  await expectApiError(rejoin.response, 404, "GAME_NOT_FOUND");
});

test("429 RATE_LIMITED после 30 созданий с одного IP; другой IP не затронут", async () => {
  const limited = await newScenarioContext(nextScenarioIp());
  for (let index = 0; index < 30; index += 1) {
    const response = await limited.post(API_PREFIX, {
      data: { name: `Игрок ${index}` },
      headers: originHeaders,
    });
    expect(response.status(), `create #${index + 1}`).toBe(201);
  }

  const blocked = await limited.post(API_PREFIX, {
    data: { name: "Лишний" },
    headers: originHeaders,
  });
  const body = await expectApiError(blocked, 429, "RATE_LIMITED");
  expect(body.error.fieldErrors).toBeUndefined();

  const other = await newScenarioContext();
  const { response } = await createGameViaApi(other, "Другой IP");
  expect(response.status()).toBe(201);
});
