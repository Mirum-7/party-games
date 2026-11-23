"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createGame, joinGame, ApiClientError } from "@/components/game/api-client";
import { normalizeInviteCode } from "@/components/game/join-form";

export type HomeFormsProps = {
  // onCreate возвращает код созданной комнаты для навигации.
  onCreate: (name: string) => Promise<string>;
  onJoin: (name: string, code: string) => Promise<void>;
};

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback;
}

// Серверные ошибки валидации имени показываются у общего поля #player-name.
function serverNameError(cause: unknown): string | null {
  if (cause instanceof ApiClientError) {
    return cause.fieldErrors?.name?.[0] ?? null;
  }
  return null;
}

// Две явно разделённые операции — «Создать комнату» и «Подключиться по коду» —
// используют одно общее поле имени, чтобы гость вводил его один раз.
export function HomeForms({ onCreate, onJoin }: HomeFormsProps) {
  const [name, setName] = React.useState("");
  const [code, setCode] = React.useState("");
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [joinError, setJoinError] = React.useState<string | null>(null);
  const [createPending, setCreatePending] = React.useState(false);
  const [joinPending, setJoinPending] = React.useState(false);

  // Обе операции меняют гостевую cookie, поэтому во время любой из них
  // блокируем обе формы и общее поле, чтобы исключить конкурирующий submit.
  const pending = createPending || joinPending;

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("Введите имя");
      return;
    }
    setCreatePending(true);
    setNameError(null);
    setCreateError(null);
    try {
      await onCreate(trimmedName);
    } catch (cause) {
      const fieldError = serverNameError(cause);
      if (fieldError) {
        setNameError(fieldError);
      } else {
        setCreateError(errorMessage(cause, "Не удалось создать комнату"));
      }
      setCreatePending(false);
    }
  }

  async function handleJoin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("Введите имя");
      return;
    }
    const normalizedCode = normalizeInviteCode(code);
    if (!normalizedCode) {
      setJoinError("Введите код приглашения");
      return;
    }
    setJoinPending(true);
    setNameError(null);
    setJoinError(null);
    try {
      await onJoin(trimmedName, normalizedCode);
    } catch (cause) {
      const fieldError = serverNameError(cause);
      if (fieldError) {
        setNameError(fieldError);
      } else {
        setJoinError(errorMessage(cause, "Не удалось подключиться"));
      }
      setJoinPending(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="player-name">Ваше имя</Label>
        <Input
          id="player-name"
          name="name"
          autoComplete="name"
          maxLength={24}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={pending}
          className="min-h-11"
        />
        {nameError ? (
          <p role="alert" className="text-sm text-destructive">
            {nameError}
          </p>
        ) : null}
      </div>
      <section aria-labelledby="create-title" className="flex flex-col gap-3">
        <h2 id="create-title" className="text-lg font-semibold">
          Создать комнату
        </h2>
        <form onSubmit={handleCreate} className="flex flex-col gap-3" noValidate>
          {createError ? (
            <p role="alert" className="text-sm text-destructive">
              {createError}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} className="min-h-11 w-full">
            {createPending ? "Создаём…" : "Создать комнату"}
          </Button>
        </form>
      </section>
      <section aria-labelledby="join-title" className="flex flex-col gap-3">
        <h2 id="join-title" className="text-lg font-semibold">
          Подключиться по коду
        </h2>
        <form onSubmit={handleJoin} className="flex flex-col gap-3" noValidate>
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
          {joinError ? (
            <p role="alert" className="text-sm text-destructive">
              {joinError}
            </p>
          ) : null}
          <Button type="submit" variant="secondary" disabled={pending} className="min-h-11 w-full">
            {joinPending ? "Подключаемся…" : "Подключиться"}
          </Button>
        </form>
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
