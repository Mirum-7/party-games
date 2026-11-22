"use client";

import { Badge } from "@/components/ui/badge";

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

const STATUS_META: Record<ConnectionStatus, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  connected: { label: "Подключено", variant: "secondary" },
  reconnecting: { label: "Переподключение…", variant: "default" },
  disconnected: { label: "Нет соединения", variant: "destructive" },
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
