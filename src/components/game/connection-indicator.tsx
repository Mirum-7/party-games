"use client";

import { cn } from "cn";

import { Badge } from "@/components/ui/badge";
import type { ConnectionStatus } from "@/components/game/sync-reducer";

export type { ConnectionStatus };

const STATUS_META: Record<
  ConnectionStatus,
  { label: string; variant: "secondary" | "success" | "warning"; dot: string }
> = {
  connecting: {
    label: "Подключение…",
    variant: "secondary",
    dot: "bg-muted-foreground/60 animate-pulse motion-reduce:animate-none",
  },
  connected: { label: "Подключено", variant: "success", dot: "bg-success" },
  reconnecting: {
    label: "Переподключение…",
    variant: "warning",
    dot: "bg-warning animate-pulse motion-reduce:animate-none",
  },
};

// Ненавязчивый индикатор состояния синхронизации; не блокирует интерфейс.
// Маленькая видимая точка дублирует цветовой смысл статуса для скорости чтения.
export function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.variant} className="shrink-0">
      <span aria-hidden="true" className={cn("size-2 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  );
}
