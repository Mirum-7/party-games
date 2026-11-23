import { Lock } from "lucide-react";
import { cn } from "cn";

import type { HintItem } from "@/shared/contracts/game";

export type HintListProps = {
  viewerPlayerId: string;
  hints: readonly HintItem[];
  prioritizeViewer?: boolean;
};

// Список назначений «автор → адресат» со словом второй строкой. Собственное
// слово зрителя в PLAYING приходит персональным DTO со word=null и
// wordHidden=true: здесь оно никогда не попадает в разметку — ни в текст, ни в
// атрибуты. prioritizeViewer поднимает строки зрителя первыми стабильной
// сортировкой копии, порядок DTO не меняется.
export function HintList({
  viewerPlayerId,
  hints,
  prioritizeViewer = false,
}: HintListProps) {
  const orderedHints = prioritizeViewer
    ? [...hints].sort(
        (a, b) =>
          Number(b.target.id === viewerPlayerId) -
          Number(a.target.id === viewerPlayerId),
      )
    : hints;

  return (
    <ul className="flex flex-col gap-2">
      {orderedHints.map((hint) => {
        const isViewerTarget = hint.target.id === viewerPlayerId;
        const hiddenViewerWord = prioritizeViewer && isViewerTarget && hint.wordHidden;
        return (
          <li
            key={hint.assignmentId}
            className={cn(
              "flex min-h-11 items-center gap-2 rounded-md border px-3 py-2",
              hiddenViewerWord && "border-warning/50 bg-warning/15",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-muted-foreground">
                {hint.author.name}
                <span aria-hidden="true"> → </span>
                {isViewerTarget ? "вам" : hint.target.name}
              </span>
              <span className="block break-words text-base font-medium">
                {hiddenViewerWord ? (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                    Ваше слово скрыто
                  </span>
                ) : hint.wordHidden ? (
                  <span className="text-muted-foreground">слово скрыто</span>
                ) : (
                  (hint.word ?? "—")
                )}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
