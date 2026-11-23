import type { HintItem } from "@/shared/contracts/game";

export type HintListProps = {
  viewerPlayerId: string;
  hints: readonly HintItem[];
};

// Список назначений «автор → адресат: слово». Собственное слово зрителя в
// PLAYING приходит персональным DTO со word=null и wordHidden=true: здесь оно
// никогда не попадает в разметку — ни в текст, ни в атрибуты.
export function HintList({ viewerPlayerId, hints }: HintListProps) {
  return (
    <ul className="flex flex-col gap-2">
      {hints.map((hint) => {
        const isViewerTarget = hint.target.id === viewerPlayerId;
        return (
          <li
            key={hint.assignmentId}
            className="flex min-h-11 items-center gap-1 rounded-md border px-3 py-2"
          >
            <span className="min-w-0 flex-1">
              <span className="font-medium">{hint.author.name}</span>
              <span aria-hidden="true"> → </span>
              <span className="font-medium">{isViewerTarget ? "вам" : hint.target.name}</span>
              <span aria-hidden="true">: </span>
              {hint.wordHidden ? (
                <span className="text-muted-foreground">слово скрыто</span>
              ) : (
                <span className="break-words">{hint.word ?? "—"}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
