import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { HomeForms } from "@/components/game/home-forms";
import { normalizeInviteCode } from "@/components/game/join-form";

// Фокусные SSR-тесты разметки и чистых хелперов. Они не доказывают работу
// кликов, навигации или SSE — live E2E отложен до интеграции с Task 9.

function renderHomeForms() {
  const noop = () => Promise.resolve("K7Q2MN");
  return renderToString(
    <HomeForms onCreate={noop} onJoin={() => Promise.resolve()} />,
  );
}

describe("HomeForms", () => {
  test("показывает две разделённые операции: создать и подключиться", () => {
    const html = renderHomeForms();
    expect(html).toContain("Создать игру");
    expect(html).toContain("Подключиться по коду");
    // Два независимых формуляра, чтобы операции не смешивались.
    expect(html.match(/<form/g)?.length).toBe(2);
  });

  test("поля имени и кода имеют постоянные связанные label", () => {
    const html = renderHomeForms();
    expect(html).toContain("Ваше имя");
    expect(html).toContain("Код приглашения");
    expect(html).toMatch(/<label[^>]*for=/);
    expect(html).toMatch(/id="[^"]*name"/);
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
});

describe("normalizeInviteCode", () => {
  test("удаляет пробельные символы и переводит в верхний регистр", () => {
    expect(normalizeInviteCode(" k7 q2\nmn ")).toBe("K7Q2MN");
  });

  test("не портит уже нормализованный код", () => {
    expect(normalizeInviteCode("K7Q2MN")).toBe("K7Q2MN");
  });
});
