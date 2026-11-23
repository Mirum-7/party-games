import { describe, expect, mock, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { normalizeInviteCode } from "@/components/game/join-form";

// Фокусные SSR-тесты разметки домашней страницы и чистых хелперов.
// E2E-facing contract: создание комнаты и подключение по коду используют одно
// общее поле имени (#player-name); поведение в браузере покрывают E2E-сценарии.

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => Promise.resolve(true) }),
}));

const { default: HomePage } = await import("@/app/page");

function renderHomeForms() {
  return renderToString(<HomePage />);
}

describe("HomeForms", () => {
  test("одно общее поле имени на обе операции: создать и подключиться", () => {
    const html = renderHomeForms();
    expect(html.match(/id="player-name"/g)).toHaveLength(1);
    expect(html).toContain("Создать комнату");
    expect(html).toContain("Подключиться по коду");
    expect(html).toContain("Загадывайте слова друзьям");
    // Два независимых формуляра, чтобы операции не смешивались.
    expect(html.match(/<form/g)).toHaveLength(2);
  });

  test("поля имени и кода имеют постоянные связанные label", () => {
    const html = renderHomeForms();
    expect(html).toContain("Ваше имя");
    expect(html).toContain("Код приглашения");
    expect(html).toMatch(/<label[^>]*for="player-name"/);
    expect(html).toMatch(/<label[^>]*for=/);
    expect(html).toMatch(/id="player-name"/);
    expect(html).toMatch(/id="[^"]*code"/);
  });

  test("основные контролы имеют touch-таргет не менее 44px", () => {
    const html = renderHomeForms();
    expect(html).toContain("min-h-11");
    // Клавиатурный фокус должен быть видимым.
    expect(html).toContain("focus-visible");
  });

  test("мобильная колонка без горизонтального переполнения", () => {
    const html = renderHomeForms();
    expect(html).toContain("max-w-md");
    expect(html).toContain("flex-col");
  });

  test("подключиться — второстепенная кнопка, создание — primary", () => {
    const html = renderHomeForms();
    expect(html).toMatch(
      /<button[^>]*data-variant="default"[^>]*>Создать комнату<\/button>/,
    );
    expect(html).toMatch(
      /<button[^>]*data-variant="secondary"[^>]*>Подключиться<\/button>/,
    );
  });
});

describe("normalizeInviteCode", () => {
  test("удаляет пробельные символы и переводит в верхний регистр", () => {
    expect(normalizeInviteCode(" k7 q2\nmn ")).toBe("K7Q2MN");
  });

  test("не портит уже нормализованный код", () => {
    expect(normalizeInviteCode("K7Q2MN")).toBe("K7Q2MN");
  });
});
