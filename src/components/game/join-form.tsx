"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiClientError } from "@/components/game/api-client";

// Та же семантика, что у серверного normalizeRoomCode: убираем все
// пробельные символы и переводим в верхний регистр.
export function normalizeInviteCode(value: string): string {
  return value.replace(/\s+/gu, "").toUpperCase();
}

export type JoinFormProps = {
  onJoin: (name: string, code: string) => Promise<void>;
  pending?: boolean;
  // Начальное значение кода: форма на странице комнаты предзаполнена из адреса.
  initialCode?: string;
};

// Переиспользуемая форма входа по коду приглашения: на домашней странице и
// позже на серверной странице комнаты. Новое устройство всегда вводит имя.
export function JoinForm({ onJoin, pending = false, initialCode = "" }: JoinFormProps) {
  const [name, setName] = React.useState("");
  const [code, setCode] = React.useState(initialCode);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!name.trim()) {
      setError("Введите имя");
      return;
    }
    if (!normalizeInviteCode(code)) {
      setError("Введите код приглашения");
      return;
    }
    try {
      await onJoin(name.trim(), normalizeInviteCode(code));
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "Не удалось подключиться");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-3" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="join-name">Ваше имя</Label>
        <Input
          id="join-name"
          name="name"
          autoComplete="name"
          maxLength={24}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={pending}
          className="min-h-11"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="join-code">Код приглашения</Label>
        <Input
          id="join-code"
          name="code"
          autoComplete="off"
          autoCapitalize="characters"
          inputMode="text"
          maxLength={16}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          disabled={pending}
          className="min-h-11"
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="min-h-11 w-full">
        {pending ? "Подключаемся…" : "Подключиться"}
      </Button>
    </form>
  );
}
