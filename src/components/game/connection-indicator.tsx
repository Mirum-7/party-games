"use client";

import { Badge } from "@/components/ui/badge";
import type { ConnectionStatus } from "@/components/game/sync-reducer";

export type { ConnectionStatus };

const STATUS_META: Record<ConnectionStatus, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  connecting: { label: "Подключение…", variant: "default" },
  connected: { label: "Подключено", variant: "secondary" },
  reconnecting: { label: "Переподключение…", variant: "default" },
};

// Ненавязчивый индикатор состояния синхронизации; не блокирует интерфейс.
export function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.variant} className="shrink-0">
      {meta.label}
    </Badge>
  );
}
