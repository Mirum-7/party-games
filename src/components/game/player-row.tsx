import * as React from "react";
import { cn } from "cn";

import { Badge } from "@/components/ui/badge";
import type { PlayerSummary } from "@/shared/contracts/game";

export type PlayerRowProps = {
  player: PlayerSummary;
  isViewer: boolean;
  status: React.ReactNode;
  action?: React.ReactNode;
};

const AVATAR_PALETTES = [
  "bg-violet-100 text-violet-700 dark:bg-violet-400/20 dark:text-violet-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300",
  "bg-amber-100 text-amber-800 dark:bg-amber-400/20 dark:text-amber-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-400/20 dark:text-rose-300",
  "bg-sky-100 text-sky-700 dark:bg-sky-400/20 dark:text-sky-300",
  "bg-orange-100 text-orange-700 dark:bg-orange-400/20 dark:text-orange-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-400/20 dark:text-teal-300",
  "bg-pink-100 text-pink-700 dark:bg-pink-400/20 dark:text-pink-300",
];

function avatarPalette(id: string): string {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return AVATAR_PALETTES[hash % AVATAR_PALETTES.length];
}

export function PlayerRow({ player, isViewer, status, action }: PlayerRowProps) {
  const initial = Array.from(player.name.trim())[0] ?? "?";

  return (
    <li className="flex min-h-11 items-center gap-3 py-1.5">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-full text-base font-semibold",
          avatarPalette(player.id),
        )}
      >
        {initial}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium leading-tight">{player.name}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1">
          {player.isHost ? <Badge variant="secondary">Хост</Badge> : null}
          {isViewer ? <Badge variant="outline">Вы</Badge> : null}
          {status}
        </span>
      </span>
      {action ? (
        <span className="flex size-11 shrink-0 items-center justify-center [&>*]:size-full">
          {action}
        </span>
      ) : null}
    </li>
  );
}
