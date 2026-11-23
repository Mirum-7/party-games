import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { PlayerRow } from "@/components/game/player-row";
import { Badge } from "@/components/ui/badge";
import type { PlayerSummary } from "@/shared/contracts/game";

function makePlayer(overrides: Partial<PlayerSummary> = {}): PlayerSummary {
  return {
    id: "p1",
    name: "Маша",
    isHost: true,
    isReady: true,
    hasSubmittedWord: false,
    hasGuessed: false,
    ...overrides,
  };
}

function avatarClassOf(html: string): string {
  const match = html.match(/class="([^"]*rounded-full[^"]*)"/);
  if (!match) throw new Error("аватар не найден в разметке");
  return match[1];
}

function avatarTextOf(html: string): string | null {
  const match = html.match(/aria-hidden="true"[^>]*>([^<]*)</);
  return match ? match[1] : null;
}

describe("PlayerRow", () => {
  test("рендерит имя, «Хост», «Вы» и текст статуса", () => {
    const html = renderToString(
      <PlayerRow
        player={makePlayer()}
        isViewer={true}
        status={<Badge variant="success">Готов</Badge>}
      />,
    );
    expect(html).toContain("Маша");
    expect(html).toContain("Хост");
    expect(html).toContain("Вы");
    // Статус виден как текст, без опоры на цветовой класс.
    expect(html).toContain("Готов");
  });

  test("действие и статус находятся внутри одного li", () => {
    const html = renderToString(
      <PlayerRow
        player={makePlayer()}
        isViewer={false}
        status={<Badge variant="success">Готов</Badge>}
        action={<button type="button">Удалить</button>}
      />,
    );
    const liStart = html.indexOf("<li");
    const liEnd = html.indexOf("</li>");
    expect(liStart).toBeGreaterThanOrEqual(0);
    expect(liEnd).toBeGreaterThan(liStart);
    const liBody = html.slice(liStart, liEnd);
    expect(liBody).toContain("Маша");
    expect(liBody).toContain("Готов");
    expect(liBody).toContain("Удалить");
    expect(html.match(/<li[\s>]/g)).toHaveLength(1);
  });

  test("область действия — 44×44, интерактивный потомок заполняет её целиком", () => {
    const html = renderToString(
      <PlayerRow
        player={makePlayer()}
        isViewer={false}
        status={null}
        action={<button type="button">Удалить</button>}
      />,
    );
    // React экранирует «>» и «&» в атрибутах — нормализуем для читаемости.
    const normalized = html.replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(normalized).toContain("[&>*]:size-full");
    const wrapperMatch = normalized.match(/class="([^"]*\[&>\*\]:size-full[^"]*)"/);
    expect(wrapperMatch).not.toBeNull();
    const wrapperClass = wrapperMatch?.[1] ?? "";
    expect(wrapperClass).toContain("items-center");
    expect(wrapperClass).toContain("justify-center");
    expect(wrapperClass).toContain("size-11");
  });

  test("цвет аватара определяется только player.id", () => {
    const first = renderToString(
      <PlayerRow player={makePlayer({ name: "Маша" })} isViewer={false} status={null} />,
    );
    const second = renderToString(
      <PlayerRow player={makePlayer({ name: "Совсем другое имя" })} isViewer={false} status={null} />,
    );
    expect(avatarClassOf(first)).toBe(avatarClassOf(second));
  });

  test("аватар — первая буква имени без пробелов; Unicode-символы целы", () => {
    const trimmed = renderToString(
      <PlayerRow player={makePlayer({ name: "   Маша" })} isViewer={false} status={null} />,
    );
    expect(avatarTextOf(trimmed)).toBe("М");
    const emoji = renderToString(
      <PlayerRow player={makePlayer({ name: "😀 Улыбка" })} isViewer={false} status={null} />,
    );
    expect(avatarTextOf(emoji)).toBe("😀");
  });

  test("не показывает «Вы» чужому игроку и «Хост» не-хосту", () => {
    const html = renderToString(
      <PlayerRow player={makePlayer({ isHost: false })} isViewer={false} status={null} />,
    );
    expect(html).not.toContain("Вы");
    expect(html).not.toContain("Хост");
  });

  test("строка имеет минимальную сенсорную высоту", () => {
    const html = renderToString(
      <PlayerRow player={makePlayer()} isViewer={true} status={null} />,
    );
    expect(html).toContain("<li");
    expect(html).toContain("min-h-11");
  });
});
