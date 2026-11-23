import { expect, type APIResponse, type Page } from "@playwright/test";

import type { GameStateResponse } from "../../shared/contracts/game";

import { API_PREFIX } from "./helpers";

// Четыре независимых браузерных контекста E2E и их имена на всех экранах.
export const VIEWER_NAMES = ["Маша", "Петя", "Ваня", "Саша"] as const;
export type ViewerName = (typeof VIEWER_NAMES)[number];

// Уникальные ASCII-канарейки-«слова»: не встречаются в словаре интерфейса и
// не пересекаются между собой, поэтому присутствие строки в теле ответа —
// однозначный признак утечки именно этого загаданного слова. Сравниваются
// сырые тела ответов, а не имена полей: слово может оказаться в любом поле.
export const CANARY_WORDS: Record<ViewerName, string> = {
  Маша: "SECRET_MASHA_01",
  Петя: "SECRET_PETYA_02",
  Ваня: "SECRET_VANYA_03",
  Саша: "SECRET_SASHA_04",
};

// Три поверхности одного зрителя одной фазы: персональный JSON /state,
// серверный HTML страницы комнаты и подлинный RSC-ответ. page.request
// разделяет cookie-jar браузерного контекста: все запросы идут с личной
// cookie зрителя. Next при RSC: 1 перенаправляет страницу на ?_rsc и отдаёт
// flight-пayload text/x-component — прямой запрос ?_rsc с тем же заголовком
// возвращает ту же полезную нагрузку (проверено против production-сервера).
export type ViewerSurfaces = {
  state: APIResponse;
  stateText: string;
  body: GameStateResponse;
  html: APIResponse;
  htmlText: string;
  rsc: APIResponse;
  rscText: string;
};

export async function captureViewerSurfaces(page: Page, code: string): Promise<ViewerSurfaces> {
  const state = await page.request.get(`${API_PREFIX}/${code}/state`);
  const stateText = await state.text();
  const html = await page.request.get(`/game/${code}`, { headers: { accept: "text/html" } });
  const htmlText = await html.text();
  const rsc = await page.request.get(`/game/${code}?_rsc`, { headers: { RSC: "1" } });
  const rscText = await rsc.text();
  return {
    state,
    stateText,
    body: JSON.parse(stateText) as GameStateResponse,
    html,
    htmlText,
    rsc,
    rscText,
  };
}

// Канарейка либо есть на всех трёх поверхностях, либо отсутствует на всех:
// персональные HTML и RSC встраивают тот же DTO, что и /state, и расхождение
// поверхностей само по себе сигнализирует о проблеме проекции.
export function expectCanary(surfaces: ViewerSurfaces, canary: string, present: boolean): void {
  const label = present ? "канарейка должна быть видна" : "утечка канарейки";
  expect(surfaces.stateText.includes(canary), `/state: ${label} ${canary}`).toBe(present);
  expect(surfaces.htmlText.includes(canary), `HTML: ${label} ${canary}`).toBe(present);
  expect(surfaces.rscText.includes(canary), `RSC: ${label} ${canary}`).toBe(present);
}

// Все три поверхности зрителя — успешные (200) незакешированные ответы;
// HTML и RSC — подлинные полезные нагрузки страницы комнаты (inline
// flight-данные и text/x-component соответственно), а не редиректы/страницы
// ошибок.
export function expectSurfaceIntegrity(surfaces: ViewerSurfaces): void {
  expect(surfaces.state.status(), "/state зрителя").toBe(200);
  expect(surfaces.html.status(), "HTML поверхность зрителя").toBe(200);
  expect(surfaces.rsc.status(), "RSC поверхность зрителя").toBe(200);
  expect(surfaces.state.headers()["cache-control"], "/state no-store").toContain("no-store");
  expect(surfaces.html.headers()["cache-control"], "HTML no-store").toContain("no-store");
  expect(surfaces.rsc.headers()["cache-control"], "RSC no-store").toContain("no-store");
  expect(surfaces.htmlText).toContain("self.__next_f.push");
  expect(surfaces.rsc.headers()["content-type"]).toContain("text/x-component");
  expect(surfaces.rscText).toContain("initialState");
}

// Слово, загаданное для этого зрителя (автор назначения → зритель).
export function targetedCanaryFor(surfaces: ViewerSurfaces): string {
  const viewerId = surfaces.body.viewer.playerId;
  const ownHint = (surfaces.body.hints ?? []).find((hint) => hint.target.id === viewerId);
  if (ownHint === undefined || !(ownHint.author.name in CANARY_WORDS)) {
    throw new Error(`назначение для зрителя ${viewerId} не найдено в hints`);
  }
  return CANARY_WORDS[ownHint.author.name as ViewerName];
}
