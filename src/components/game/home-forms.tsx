"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createGame, joinGame, ApiClientError } from "@/components/game/api-client";
import { JoinForm, normalizeInviteCode } from "@/components/game/join-form";

export type HomeFormsProps = {
  // onCreate возвращает код созданной комнаты для навигации.
  onCreate: (name: string) => Promise<string>;
  onJoin: (name: string, code: string) => Promise<void>;
};

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback;
}

// Две явно разделённые операции: создание игры и вход по коду.
export function HomeForms({ onCreate, onJoin }: HomeFormsProps) {
  const [createName, setCreateName] = React.useState("");
  const [createPending, setCreatePending] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [joinPending, setJoinPending] = React.useState(false);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createPending) return;
    if (!createName.trim()) {
      setCreateError("Введите имя");
      return;
    }
    setCreatePending(true);
    setCreateError(null);
    try {
      await onCreate(createName.trim());
    } catch (cause) {
      setCreateError(errorMessage(cause, "Не удалось создать игру"));
      setCreatePending(false);
    }
  }

  async function handleJoin(name: string, code: string) {
    setJoinPending(true);
    try {
      await onJoin(name, code);
    } finally {
      // Ошибку показывает JoinForm: проброс нужен, чтобы его catch сработал.
      setJoinPending(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <section aria-labelledby="create-title" className="flex flex-col gap-3">
        <h2 id="create-title" className="text-lg font-semibold">
          Создать игру
        </h2>
        <form onSubmit={handleCreate} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-name">Ваше имя</Label>
            <Input
              id="create-name"
              name="name"
              autoComplete="name"
              maxLength={24}
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              disabled={createPending}
              className="min-h-11"
            />
          </div>
          {createError ? (
            <p role="alert" className="text-sm text-destructive">
              {createError}
            </p>
          ) : null}
          <Button type="submit" disabled={createPending} className="min-h-11 w-full">
            {createPending ? "Создаём…" : "Создать игру"}
          </Button>
        </form>
      </section>
      <section aria-labelledby="join-title" className="flex flex-col gap-3">
        <h2 id="join-title" className="text-lg font-semibold">
          Подключиться по коду
        </h2>
        <JoinForm onJoin={handleJoin} pending={joinPending} />
      </section>
    </div>
  );
}

// Готовая связка для домашней страницы: реальные API-вызовы и навигация
// в /game/{code} после успеха.
export function HomeFormsFlow() {
  const router = useRouter();

  const handleCreate = React.useCallback(
    async (name: string) => {
      const code = await createGame(name);
      router.push(`/game/${encodeURIComponent(code)}`);
      return code;
    },
    [router],
  );

  const handleJoin = React.useCallback(
    async (name: string, code: string) => {
      const normalized = normalizeInviteCode(code);
      await joinGame(normalized, name);
      router.push(`/game/${encodeURIComponent(normalized)}`);
    },
    [router],
  );

  return <HomeForms onCreate={handleCreate} onJoin={handleJoin} />;
}
