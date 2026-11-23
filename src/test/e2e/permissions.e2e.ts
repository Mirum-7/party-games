import { expect, test, type APIRequestContext } from "@playwright/test";

import {
  API_PREFIX,
  createGameViaApi,
  createLobbyOfThree,
  expectApiError,
  getStateViaApi,
  newScenarioContext,
  originHeaders,
  startAssigningWords,
} from "./helpers";
import { submitWordsApi } from "./acceptance-helpers";

// Acceptance: прямая API-авторизация. Не-админ (и посторонний участник другой
// комнаты) получает 403 на settings/start/remove/finish/cancel независимо от
// capabilities в DTO; состояние комнаты при этом не меняется. Личность
// вызывающего берётся только из cookie: playerId в телах запросов отклоняется
// валидацией.

type RoomSnapshot = {
  revision: number;
  phase: string;
  playerNames: string[];
  settingsHidden: boolean;
};

async function snapshotRoom(ctx: APIRequestContext, code: string): Promise<RoomSnapshot> {
  const { state } = await getStateViaApi(ctx, code);
  return {
    revision: state.game.revision,
    phase: state.game.phase,
    playerNames: state.players.map((player) => player.name),
    settingsHidden: state.game.settings.hideTargetNamesDuringSetup,
  };
}

function expectUnchanged(before: RoomSnapshot, after: RoomSnapshot): void {
  expect(after).toEqual(before);
}

test("не-админ: settings/start/remove/finish/cancel напрямую — 403, состояние комнаты неизменно", async () => {
  const lobby = await createLobbyOfThree();
  const { host, second, third, code } = lobby;
  const base = await snapshotRoom(host, code);

  // Права в DTO не-админа отключены (UI по ним лишь скрывает контролы).
  const { state: secondView } = await getStateViaApi(second, code);
  expect(secondView.capabilities).toMatchObject({
    canEditSettings: false,
    canManagePlayers: false,
    canStart: false,
    canFinish: false,
    canCancel: false,
  });

  const settings = await second.patch(`${API_PREFIX}/${code}/settings`, {
    data: { hideTargetNamesDuringSetup: true },
    headers: originHeaders,
  });
  await expectApiError(settings, 403, "FORBIDDEN");

  const start = await second.post(`${API_PREFIX}/${code}/start`, { headers: originHeaders });
  await expectApiError(start, 403, "FORBIDDEN");

  const remove = await second.delete(`${API_PREFIX}/${code}/players/${third}`, { headers: originHeaders });
  await expectApiError(remove, 403, "FORBIDDEN");

  const finish = await second.post(`${API_PREFIX}/${code}/finish`, { headers: originHeaders });
  await expectApiError(finish, 403, "FORBIDDEN");

  const cancel = await second.post(`${API_PREFIX}/${code}/cancel`, { headers: originHeaders });
  await expectApiError(cancel, 403, "FORBIDDEN");

  expectUnchanged(base, await snapshotRoom(host, code));
});

test("посторонний участник другой комнаты: все управляющие команды — 403", async () => {
  const lobby = await createLobbyOfThree();
  const outsider = await newScenarioContext();
  await createGameViaApi(outsider, "Галя");
  const base = await snapshotRoom(lobby.host, lobby.code);

  const settings = await outsider.patch(`${API_PREFIX}/${lobby.code}/settings`, {
    data: { hideTargetNamesDuringSetup: true },
    headers: originHeaders,
  });
  await expectApiError(settings, 403, "FORBIDDEN");

  const start = await outsider.post(`${API_PREFIX}/${lobby.code}/start`, { headers: originHeaders });
  await expectApiError(start, 403, "FORBIDDEN");

  const remove = await outsider.delete(`${API_PREFIX}/${lobby.code}/players/${lobby.second}`, {
    headers: originHeaders,
  });
  await expectApiError(remove, 403, "FORBIDDEN");

  const finish = await outsider.post(`${API_PREFIX}/${lobby.code}/finish`, { headers: originHeaders });
  await expectApiError(finish, 403, "FORBIDDEN");

  const cancel = await outsider.post(`${API_PREFIX}/${lobby.code}/cancel`, { headers: originHeaders });
  await expectApiError(cancel, 403, "FORBIDDEN");

  expectUnchanged(base, await snapshotRoom(lobby.host, lobby.code));
});

test("не-админ остаётся без прав во всех фазах: cancel в ASSIGNING_WORDS и finish в PLAYING — 403", async () => {
  const lobby = await createLobbyOfThree();
  const room = {
    code: lobby.code,
    members: [
      { name: "Маша", ctx: lobby.host, id: lobby.hostId },
      { name: "Петя", ctx: lobby.second, id: lobby.secondId },
      { name: "Ваня", ctx: lobby.third, id: lobby.thirdId },
    ],
  };
  await startAssigningWords(lobby);

  const cancel = await lobby.second.post(`${API_PREFIX}/${lobby.code}/cancel`, { headers: originHeaders });
  await expectApiError(cancel, 403, "FORBIDDEN");
  const inAssigning = await snapshotRoom(lobby.host, lobby.code);
  expect(inAssigning.phase).toBe("ASSIGNING_WORDS");

  await submitWordsApi(room, ["самолёт", "поезд", "корабль"]);
  const inPlaying = await snapshotRoom(lobby.host, lobby.code);
  expect(inPlaying.phase).toBe("PLAYING");

  const finish = await lobby.second.post(`${API_PREFIX}/${lobby.code}/finish`, { headers: originHeaders });
  await expectApiError(finish, 403, "FORBIDDEN");
  // Отклонённая команда не меняет состояние: ревизия как после ввода слов.
  expect(await snapshotRoom(lobby.host, lobby.code)).toEqual(inPlaying);
});

test("playerId вызывающего в теле запроса отклоняется: личность только из cookie", async () => {
  const lobby = await createLobbyOfThree();

  const readiness = await lobby.second.post(`${API_PREFIX}/${lobby.code}/readiness`, {
    data: { ready: true, playerId: lobby.hostId },
    headers: originHeaders,
  });
  const readinessBody = await expectApiError(readiness, 400, "VALIDATION_ERROR");
  expect(readinessBody.error.fieldErrors?.playerId).toBeTruthy();

  const settings = await lobby.host.patch(`${API_PREFIX}/${lobby.code}/settings`, {
    data: { hideTargetNamesDuringSetup: true, playerId: lobby.secondId },
    headers: originHeaders,
  });
  const settingsBody = await expectApiError(settings, 400, "VALIDATION_ERROR");
  expect(settingsBody.error.fieldErrors?.playerId).toBeTruthy();

  // Ничего из перечисленного не применилось: готовность второго не включилась,
  // настройка не изменилась.
  const untouched = await getStateViaApi(lobby.host, lobby.code);
  expect(untouched.state.players.find((player) => player.id === lobby.secondId)?.isReady).toBe(false);
  expect(untouched.state.game.settings.hideTargetNamesDuringSetup).toBe(false);

  await startAssigningWords(lobby);
  const word = await lobby.second.put(`${API_PREFIX}/${lobby.code}/word`, {
    data: { word: "самолёт", playerId: lobby.hostId },
    headers: originHeaders,
  });
  const wordBody = await expectApiError(word, 400, "VALIDATION_ERROR");
  expect(wordBody.error.fieldErrors?.playerId).toBeTruthy();

  // Слово не сохранилось.
  const { state } = await getStateViaApi(lobby.host, lobby.code);
  expect(state.players.every((player) => !player.hasSubmittedWord)).toBe(true);
});

test("аноним без cookie получает 401 на управляющие команды", async () => {
  const lobby = await createLobbyOfThree();
  const anonymous = await newScenarioContext();

  const settings = await anonymous.patch(`${API_PREFIX}/${lobby.code}/settings`, {
    data: { hideTargetNamesDuringSetup: true },
    headers: originHeaders,
  });
  await expectApiError(settings, 401, "UNAUTHENTICATED");

  const start = await anonymous.post(`${API_PREFIX}/${lobby.code}/start`, { headers: originHeaders });
  await expectApiError(start, 401, "UNAUTHENTICATED");

  const finish = await anonymous.post(`${API_PREFIX}/${lobby.code}/finish`, { headers: originHeaders });
  await expectApiError(finish, 401, "UNAUTHENTICATED");
});

test("админ сохраняет полные права в любой своей фазе", async () => {
  const lobby = await createLobbyOfThree();
  const room = {
    code: lobby.code,
    members: [
      { name: "Маша", ctx: lobby.host, id: lobby.hostId },
      { name: "Петя", ctx: lobby.second, id: lobby.secondId },
      { name: "Ваня", ctx: lobby.third, id: lobby.thirdId },
    ],
  };
  const { state: lobbyView } = await getStateViaApi(lobby.host, lobby.code);
  expect(lobbyView.capabilities).toMatchObject({
    canEditSettings: true,
    canManagePlayers: true,
    canStart: false, // ещё не все готовы
    canFinish: false,
    canCancel: false,
  });

  await startAssigningWords(lobby);
  const { state: assigningView } = await getStateViaApi(lobby.host, lobby.code);
  expect(assigningView.capabilities.canCancel).toBe(true);
  expect(assigningView.capabilities.canFinish).toBe(false);

  await submitWordsApi(room, ["самолёт", "поезд", "корабль"]);
  const { state: playingView } = await getStateViaApi(lobby.host, lobby.code);
  expect(playingView.capabilities.canFinish).toBe(true);
  expect(playingView.capabilities.canCancel).toBe(false);
  expect(playingView.capabilities.canMarkGuessed).toBe(true);
});
