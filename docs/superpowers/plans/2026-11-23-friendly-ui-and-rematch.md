# Friendly UI and Rematch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Обновить дружелюбность и цветовую иерархию всех экранов и добавить атомарный повторный раунд/выход после `FINISHED` с сохранением текущих игровых инвариантов.

**Architecture:** `WORD_CHAIN` предоставляет `GameDefinition.resetAttempt`, а Core вызывает его через composition root. Restart и leave выполняются через существующий `runGameCommand`; UI использует текущие персональные DTO и не получает новых секретных полей. Работа распределяется на независимые файловые пакеты, затем интегрируется через `GameRoom` и E2E.

**Tech Stack:** Next.js 16, React 19, TypeScript strict, Tailwind CSS 4, shadcn/ui, lucide-react, Prisma 7, PostgreSQL, Bun test, Playwright.

## Global Constraints

- Источник требований: `docs/superpowers/specs/2026-11-23-friendly-ui-and-rematch-design.md`.
- Перед кодом читать `AGENTS.md` и источники истины из него.
- Не добавлять зависимости, миграции, историю раундов, постоянный рейтинг и rematch-голосование.
- Не разрешать leave/remove в `ASSIGNING_WORDS` и `PLAYING`.
- Собственное слово не добавлять в DTO, RSC, DOM, SSE или логи до `FINISHED`.
- Каждая команда выполняется под блокировкой `Game`; фактическое изменение даёт одну ревизию и одно SSE после commit.
- Текст UI — русский, обращение на «вы», сенсорные цели не меньше 44×44 px, минимальная ширина 360 px.
- Новые тесты добавляются в существующую инфраструктуру; implementation follows TDD where a behavior change is introduced.
- Не выполнять git commit/push/reset/rebase: пользователь не запрашивал изменение Git-истории. Checkpoint — список изменённых файлов и результат тестов.
- Не оставлять временные файлы, screenshots, логи или тестовые артефакты в репозитории.

---

### Task 1: Shared reset, restart API and capabilities

**Files:**
- Create: `src/server/games/word-chain/attempt.ts`
- Create: `src/app/api/v1/games/[code]/restart/route.ts`
- Create: `src/test/integration/restart.test.ts`
- Modify: `src/server/core/games/types.ts`
- Modify: `src/server/core/games/projection.ts`
- Modify: `src/server/games/word-chain/service.ts`
- Modify: `src/server/games/registry.ts`
- Modify: `src/shared/contracts/game.ts`
- Modify: `src/components/game/api-client.ts`
- Modify: capability fixtures in `src/test/unit/{api-client,sync-reducer,sync-controller,use-game-state,connection-indicator,lobby,game-room}.test.*`, `src/test/unit/word-chain/screens.test.tsx`, `src/test/integration/projection.test.ts`, `src/test/e2e/api.e2e.ts`

**Interfaces:**
- Produces: `resetWordChainAttempt(tx: TransactionClient, gameId: string): Promise<void>`.
- Produces: `GameDefinition.resetAttempt(tx, gameId): Promise<void>`.
- Produces: `restartWordChain({code, playerId, realtime}): Promise<CommandResult<{restarted: boolean}>>`.
- Produces: `Capabilities.canRestart: boolean`; `canLeave` is true in `LOBBY | FINISHED`.
- Later tasks consume `POST /api/v1/games/{code}/restart` through `mutate("POST", "/restart")`.

- [ ] **Step 1: Write failing integration tests**

Create `restart.test.ts` using the existing `createGame`, `joinGame`, `setReadiness`, `startWordChain`, `submitWord`, `finishWordChain`, `prisma` and spy realtime patterns. Include this core assertion after creating a three-player finished room:

```ts
const before = await prisma.game.findUniqueOrThrow({
  where: { id: room.gameId },
  include: { players: true, wordChain: true },
});
const result = await restartWordChain({
  code: room.code,
  playerId: room.hostId,
  realtime,
});
expect(result.changed).toBe(true);
expect(result.value).toEqual({ restarted: true });
expect(result.revision).toBe(before.revision + 1);
const after = await prisma.game.findUniqueOrThrow({
  where: { id: room.gameId },
  include: { players: true, wordChain: true },
});
expect(after.status).toBe("LOBBY");
expect(after.startedAt).toBeNull();
expect(after.finishedAt).toBeNull();
expect(after.wordChain?.phase).toBeNull();
expect(after.wordChain?.playingStartedAt).toBeNull();
expect(after.wordChain?.hideTargetNamesDuringSetup).toBe(true);
expect(after.players.every((player) => !player.isReady)).toBe(true);
expect(await prisma.wordAssignment.count({ where: { gameId: room.gameId } })).toBe(0);
expect(await prisma.gameResult.count({ where: { gameId: room.gameId } })).toBe(0);
expect(published).toEqual([{ gameId: room.gameId, revision: result.revision }]);
```

Add tests for non-host 403, `ACTIVE` 409, no-op in `LOBBY` preserving newly set readiness, and `Promise.all` of two restarts producing one revision increment. Add projection assertions: host in `FINISHED` has `canRestart: true, canLeave: true`; non-host and every other phase have `canRestart: false`.

- [ ] **Step 2: Verify the tests fail**

Run: `bun test src/test/integration/restart.test.ts`
Expected: FAIL because `restartWordChain` and `canRestart` do not exist.

- [ ] **Step 3: Implement reset and restart**

Create `attempt.ts`:

```ts
import "server-only";

import type { TransactionClient } from "@/server/db";

export async function resetWordChainAttempt(
  tx: TransactionClient,
  gameId: string,
): Promise<void> {
  await tx.wordAssignment.deleteMany({ where: { gameId } });
  await tx.gameResult.deleteMany({ where: { gameId } });
  await tx.player.updateMany({ where: { gameId }, data: { isReady: false } });
  await tx.game.update({
    where: { id: gameId },
    data: { status: "LOBBY", startedAt: null, finishedAt: null },
  });
  await tx.wordChainGame.update({
    where: { gameId },
    data: { phase: null, playingStartedAt: null },
  });
}
```

Add to `GameDefinition`:

```ts
resetAttempt(tx: TransactionClient, gameId: string): Promise<void>;
```

Set `resetAttempt: resetWordChainAttempt` in `wordChainGameDefinition`. Replace the duplicated reset body in `cancelWordChain` with `await resetWordChainAttempt(tx, game.id)` after its existing checks.

Add `restartWordChain` to `service.ts`:

```ts
export async function restartWordChain(input: {
  code: string;
  playerId: string;
  realtime: GameRealtime;
}): Promise<CommandResult<{ restarted: boolean }>> {
  const code = normalizeCodeOrThrow(input.code);
  return runGameCommand({
    code,
    realtime: input.realtime,
    action: "restart",
    command: async (tx, game) => {
      await requireMember(tx, game.id, input.playerId);
      requireHost(game, input.playerId);
      if (game.status === "LOBBY") {
        return { changed: false, value: { restarted: false } };
      }
      if (game.status !== "FINISHED") {
        throw new GameCommandError("INVALID_GAME_STATE", 409, INVALID_PHASE_MESSAGE);
      }
      await resetWordChainAttempt(tx, game.id);
      return { changed: true, value: { restarted: true } };
    },
  });
}
```

Create the route using `runGameMutation` with `bodySchema: null`, rate-limit key `POST /api/v1/games/{code}/restart`, and return `playerId` after awaiting `restartWordChain`. Re-export it from `registry.ts` alongside `cancelWordChain`.

- [ ] **Step 4: Extend DTO and client schema**

Add `canRestart: boolean` to `Capabilities` and the Zod object. In Core projection set:

```ts
canRestart: isHost && projected.phase === "FINISHED",
canLeave: inLobby || projected.phase === "FINISHED",
```

Update all capability fixtures. Expected defaults are `canRestart: false`; update `canLeave` expectations in `FINISHED` to true. Do not add game-specific capabilities to `projectWordChain`.

- [ ] **Step 5: Run focused checks**

Run: `bun test src/test/integration/restart.test.ts src/test/integration/projection.test.ts src/test/unit/api-client.test.ts src/test/unit/word-chain/projection.test.ts`
Expected: PASS.

Run: `bun run typecheck`
Expected: PASS after every fixture includes `canRestart`.

- [ ] **Step 6: Checkpoint**

Report files and test output; do not commit.

---

### Task 2: Friendly visual primitives and shared rows/dialogs

**Files:**
- Create: `src/components/game/confirm-dialog.tsx`
- Create: `src/components/game/player-row.tsx`
- Create: `src/test/unit/player-row.test.tsx`
- Modify: `src/app/globals.css`
- Modify: `src/components/ui/button.tsx`
- Modify: `src/components/ui/badge.tsx`

**Interfaces:**
- Produces: `ConfirmDialog({trigger, title, description, actionLabel, actionVariant, onAction})`.
- Produces: `PlayerRow({player, isViewer, status, action})`.
- Produces: Button `variant="success"` and Badge `variant="success" | "warning"`.

- [ ] **Step 1: Write failing SSR tests**

```tsx
const html = renderToString(
  <PlayerRow
    player={{ id: "p1", name: "Маша", isHost: true, isReady: true, hasSubmittedWord: false, hasGuessed: false }}
    isViewer={true}
    status={<Badge variant="success">Готов</Badge>}
  />,
);
expect(html).toContain("Маша");
expect(html).toContain("Хост");
expect(html).toContain("Вы");
expect(html).toContain("Готов");
```

Add assertions that status is visible without relying on a color class and that a supplied action is rendered inside the same `li`.

- [ ] **Step 2: Verify tests fail**

Run: `bun test src/test/unit/player-row.test.tsx`
Expected: FAIL because `PlayerRow` does not exist.

- [ ] **Step 3: Implement shared components**

`ConfirmDialog` accepts a single React button as `trigger` and uses `AlertDialogTrigger asChild`:

```tsx
export type ConfirmDialogProps = {
  trigger: React.ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  actionVariant?: "default" | "destructive" | "success";
  onAction: () => void | Promise<void>;
};

export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{props.trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">Отмена</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: props.actionVariant ?? "default", className: "min-h-11" })}
            onClick={() => void props.onAction()}
          >
            {props.actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

`PlayerRow` renders an `li` with a deterministic avatar color derived only from `player.id`, first Unicode character of the trimmed name, `Хост`/`Вы` badges, a flexible `status: React.ReactNode` and optional `action: React.ReactNode`. Use `min-w-0`, `break-words`/`truncate` appropriately and keep action target at least `size-11`.

- [ ] **Step 4: Add semantic colors**

Introduce accessible violet `primary`, emerald `success` and amber `warning` tokens with foregrounds in `:root` and `.dark`, and expose them through `@theme inline`. Use a light violet-gray page background. Add `success` to Button and `success`/`warning` to Badge using the semantic classes, not raw per-screen colors.

- [ ] **Step 5: Run focused checks**

Run: `bun test src/test/unit/player-row.test.tsx src/test/unit/connection-indicator.test.tsx`
Expected: PASS.

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Report files and test output; do not commit.

---

### Task 3: One name on the home page

**Files:**
- Modify: `src/components/game/home-forms.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/test/unit/home-forms.test.tsx`

**Interfaces:**
- Keeps `HomeFormsProps.onCreate(name)` and `onJoin(name, code)` unchanged.
- Keeps standalone `JoinForm` unchanged for `/game/{code}` membership joining.
- Produces one `#player-name` shared by both home operations.

- [ ] **Step 1: Change tests first**

Replace the old duplicate-name assertions:

```tsx
const html = renderHomeForms();
expect(html.match(/id="player-name"/g)).toHaveLength(1);
expect(html).toContain("Создать комнату");
expect(html).toContain("Подключиться по коду");
expect(html).toContain("Загадывайте слова друзьям");
expect(html.match(/<form/g)).toHaveLength(2);
```

Add an E2E-facing contract note: creation and joining use the same input; browser behavior is verified in Task 8.

- [ ] **Step 2: Verify old tests fail**

Run: `bun test src/test/unit/home-forms.test.tsx`
Expected: FAIL on the single shared name and new copy.

- [ ] **Step 3: Implement controlled shared state**

Use `name`, `code`, `nameError`, `createError`, `joinError`, `createPending`, `joinPending` in `HomeForms`. The shared input is outside both forms. `pending = createPending || joinPending` disables both forms and the shared input. Both submit handlers normalize the same `name.trim()` and set missing-name errors at `#player-name`.

For `ApiClientError`, display `fieldErrors?.name?.[0]` at the shared input. Keep code/general errors in the join card and creation errors in the create card. Preserve values after errors. Do not import or render the standalone `JoinForm`; import only `normalizeInviteCode`.

Use two sections with headings «Создать комнату» and «Подключиться по коду». Update the page description to «Загадывайте слова друзьям, объясняйте вживую и угадывайте своё».

- [ ] **Step 4: Run focused checks**

Run: `bun test src/test/unit/home-forms.test.tsx`
Expected: PASS.

Run: `bun run lint src/components/game/home-forms.tsx src/app/page.tsx src/test/unit/home-forms.test.tsx`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Report files and test output; do not commit.

---

### Task 4: Leave from FINISHED

**Files:**
- Create: `src/test/integration/finished-leave.test.ts`
- Modify: `src/server/core/players/service.ts`
- Modify: `src/app/api/v1/games/[code]/leave/route.ts`
- Modify: `src/test/integration/lobby.test.ts`

**Interfaces:**
- Consumes: `GameDefinition.resetAttempt` from Task 1.
- Changes `leaveGame` input by adding `resolveDefinition: (type: GameType) => GameDefinition`.
- Keeps `POST /leave` response 204 and existing client helper unchanged.

- [ ] **Step 1: Write failing integration tests**

Cover non-host leave, host leave, last-player leave, rejoin and active-phase rejection. The core test starts with a finished room and asserts:

```ts
const result = await leaveGame({
  code: room.code,
  playerId: room.guestId,
  realtime,
  resolveDefinition: getGameDefinition,
});
expect(result.value.roomDeleted).toBe(false);
const game = await prisma.game.findUniqueOrThrow({
  where: { id: room.gameId },
  include: { players: true, wordChain: true },
});
expect(game.status).toBe("LOBBY");
expect(game.players.map((player) => player.id)).not.toContain(room.guestId);
expect(game.players.every((player) => !player.isReady)).toBe(true);
expect(await prisma.wordAssignment.count({ where: { gameId: room.gameId } })).toBe(0);
expect(await prisma.gameResult.count({ where: { gameId: room.gameId } })).toBe(0);
expect(published).toHaveLength(1);
```

For rejoin, call `joinGame` with `playerId: null`; assert a new id and `isReady = false`. For host leave, assert successor `(joinedAt, id)`. For last leave, assert room deletion and no publish. Add concurrent restart/leave coverage with Task 1's command and assert one consistent final state.

- [ ] **Step 2: Verify tests fail**

Run: `bun test src/test/integration/finished-leave.test.ts`
Expected: FAIL with `INVALID_GAME_STATE` or a signature mismatch.

- [ ] **Step 3: Implement phase-aware leave**

After `requireMember`, replace unconditional `requireLobby(game)` with:

```ts
if (game.status === "FINISHED") {
  await input.resolveDefinition(game.type).resetAttempt(tx, game.id);
} else {
  requireLobby(game);
}
await assertNoGameRecords(tx, game.id, input.playerId);
```

Keep the existing successor/host-transfer/last-player code unchanged and after this post-condition. Add imports for `GameType` and `GameDefinition`; extend input with the resolver. Pass `getGameDefinition` from the route. This ensures `resetAttempt → assertNoGameRecords → delete` and a domain 409 if the post-condition fails.

- [ ] **Step 4: Run focused checks**

Run: `bun test src/test/integration/finished-leave.test.ts src/test/integration/lobby.test.ts src/test/integration/restart.test.ts`
Expected: PASS.

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Report files and test output; do not commit.

---

### Task 5: Lobby visual hierarchy and row-level removal

**Files:**
- Modify: `src/components/game/lobby.tsx`
- Modify: `src/test/unit/lobby.test.tsx`

**Interfaces:**
- Consumes `PlayerRow` and `ConfirmDialog` from Task 2.
- Keeps all `LobbyProps` callback names unchanged.
- Produces `#ready-button`; removes `#ready-switch` only on the home lobby UI.

- [ ] **Step 1: Update tests first**

Assert `Удалить участника «Петя»` occurs in the same list item as `Петя`, and no separate button list exists after the roster. Assert visible «Пока не готов», «Вы готовы», «Ждём начала игры хостом», success/warning badges and `#ready-button`. Preserve tests for start block reasons, settings permissions and pending disabling.

- [ ] **Step 2: Verify tests fail**

Run: `bun test src/test/unit/lobby.test.tsx`
Expected: FAIL on row action, readiness button and copy.

- [ ] **Step 3: Implement the lobby**

Use `PlayerRow` for every participant. Host passes a `ConfirmDialog` whose trigger is:

```tsx
<Button
  type="button"
  variant="ghost"
  className="size-11 shrink-0 text-destructive hover:bg-destructive/10"
  aria-label={`Удалить участника «${player.name}»`}
  disabled={mutationPending}
>
  <UserMinus aria-hidden="true" />
</Button>
```

Dialog title is `Удалить участника «${player.name}»?`, action is destructive and calls `onRemove(player.id)`. Remove the mapped deletion buttons below the roster.

Replace the readiness switch with a full-width `Button id="ready-button"`: `onClick={() => void onToggleReady(!(viewerPlayer?.isReady ?? false))}`, success variant when ready, and text «Я готов» / «Вы готовы». Keep the host settings switch. Show non-host waiting copy and use the accent invitation card. Copy success text is «Код скопирован»; preserve the clipboard fallback.

- [ ] **Step 4: Run focused checks**

Run: `bun test src/test/unit/lobby.test.tsx src/test/unit/game-room.test.tsx`
Expected: PASS after fixture/prop compatibility from Task 1.

- [ ] **Step 5: Checkpoint**

Report files and test output; do not commit.

---

### Task 6: Word setup, playing and hint readability

**Files:**
- Modify: `src/components/game/word-chain/word-setup.tsx`
- Modify: `src/components/game/word-chain/playing-room.tsx`
- Modify: `src/components/game/word-chain/hint-list.tsx`
- Modify: `src/components/game/connection-indicator.tsx`
- Modify: `src/test/unit/word-chain/screens.test.tsx`
- Modify: `src/test/unit/connection-indicator.test.tsx`

**Interfaces:**
- Consumes `PlayerRow`, `ConfirmDialog`, semantic variants.
- Adds optional `HintList.prioritizeViewer?: boolean`, default `false`.
- Keeps `WordSetupProps` and `PlayingRoomProps` callback signatures unchanged.

- [ ] **Step 1: Update tests first**

Required assertions:

```tsx
expect(html).toContain("Загадайте слово для игрока: Петя");
expect(html).toContain("Слова сохранены: 2 из 3");
expect(html).toContain("Ваше слово скрыто");
expect(html).toContain("Угадали 1 из 3");
expect(html.indexOf("вам")).toBeLessThan(html.indexOf("радуга"));
expect(html).not.toContain(OWN_SECRET);
```

Verify final `HintList` without `prioritizeViewer` preserves input order. Verify no-winner and other final behavior remains in Task 7's tests, not here.

- [ ] **Step 2: Verify tests fail**

Run: `bun test src/test/unit/word-chain/screens.test.tsx src/test/unit/connection-indicator.test.tsx`
Expected: FAIL on new copy/order/progress.

- [ ] **Step 3: Implement hint behavior**

Compute a stable order without mutating the DTO:

```ts
const orderedHints = prioritizeViewer
  ? [...hints].sort((a, b) => Number(b.target.id === viewerPlayerId) - Number(a.target.id === viewerPlayerId))
  : hints;
```

Modern JS sort is stable, so other hints keep server order. When `prioritizeViewer && isViewerTarget`, render warning background, `Lock` and «Ваше слово скрыто» only if `hint.wordHidden`; never synthesize a word. Other rows use a two-line author/target and word layout with `break-words`.

- [ ] **Step 4: Implement screens**

WordSetup uses «Загадайте слово для игрока: {name}» for a visible target and «Введите загаданное слово» for a hidden target, one field label, length/edit hint, `hasSubmittedWord` progress and `PlayerRow` statuses «Слово готово» / «Ждём слово». PlayingRoom adds `hasGuessed` progress, success «Я угадал», a success spectator card and moves destructive finish below hints into an admin zone. ConnectionIndicator uses a small visible status dot plus text; reconnecting uses warning.

- [ ] **Step 5: Run focused checks**

Run: `bun test src/test/unit/word-chain/screens.test.tsx src/test/unit/connection-indicator.test.tsx`
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Report files and test output; do not commit.

---

### Task 7: Final actions, winner/ranking and GameRoom wiring

**Files:**
- Modify: `src/components/game/word-chain/final-results.tsx`
- Modify: `src/components/game/game-room.tsx`
- Modify: `src/test/unit/word-chain/screens.test.tsx`
- Modify: `src/test/unit/game-room.test.tsx`

**Interfaces:**
- Adds `GameRoomViewProps.onRestart: () => Promise<void>`.
- Changes `FinalResultsProps` to `{state, mutationPending, onRestart, onLeave}`.
- Uses existing `handleLeave` for final main-menu navigation and `mutate("POST", "/restart")` for rematch.

- [ ] **Step 1: Write failing tests**

Cover host/non-host actions, confirmation copy, no-winner early finish, viewer highlight, visible score labels and pending disabling. Extend `makeView` with `onRestart`. Assert FINISHED renders «Игра завершена» and «Сыграть ещё с этим составом» when `canRestart`, while non-host sees the host explanation and «В главное меню».

- [ ] **Step 2: Verify tests fail**

Run: `bun test src/test/unit/word-chain/screens.test.tsx src/test/unit/game-room.test.tsx`
Expected: FAIL on missing props/actions.

- [ ] **Step 3: Implement final screen**

Place actions before ranking. Host restart uses `ConfirmDialog`; its description explicitly says words/results are deleted and players/code/settings preserved. Non-host sees «Хост может вернуть всех в лобби для нового раунда». Everyone with `canLeave` gets a final-exit dialog containing the approved warning that others return to lobby and results are cleared.

Render winner only when `results?.some((item) => item.place === 1)`. Keep server result order. Use compact rows, top-three accents, viewer primary border, score icon with `aria-label={`Очки: ${item.score}`}` and final hints with `prioritizeViewer={false}`.

- [ ] **Step 4: Wire GameRoom**

Add `onRestart` to view props and callbacks:

```ts
const handleRestart = React.useCallback(
  () => runGuarded(() => mutate("POST", "/restart")),
  [mutate, runGuarded],
);
```

Pass it through `GameRoomView`; render `<FinalResults state={game} mutationPending={mutationPending} onRestart={onRestart} onLeave={onLeave} />`. Keep navigation to `/` only in the existing successful `handleLeave` after 204.

- [ ] **Step 5: Run focused checks**

Run: `bun test src/test/unit/word-chain/screens.test.tsx src/test/unit/game-room.test.tsx src/test/unit/api-client.test.ts`
Expected: PASS.

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Report files and test output; do not commit.

---

### Task 8: Browser acceptance and mobile alignment

**Files:**
- Create: `src/test/e2e/rematch.e2e.ts`
- Modify: `src/test/e2e/acceptance-helpers.ts`
- Modify: `src/test/e2e/mobile.e2e.ts`
- Modify: other existing E2E selectors only where new copy/controls require it

**Interfaces:**
- Consumes all prior UI and APIs.
- Uses four independent browser contexts per rematch scenario.
- Uses production Next behind the existing test-only TLS proxy; no new test servers or scripts.

- [ ] **Step 1: Align shared helpers with actual UI**

`createGameViaUi` fills `#player-name` and clicks «Создать комнату». `setReadyViaUi` clicks `#ready-button`. Heading regexes expect exactly «Загадайте слово для игрока:|Введите загаданное слово». Final expectations use «Игра завершена». Update readiness, score and status assertions without weakening them into class-only checks.

- [ ] **Step 2: Add rematch E2E**

Scenario A uses four contexts: complete a round, host confirms rematch, all see the same-code lobby with no readiness/words/results; one guest leaves and joins another existing lobby; remaining players see removal; fewer than three cannot start; a new player joins; all ready and a second round reaches `PLAYING` with clean setup/results.

Scenario B uses a fresh four-context room: finish a round, a guest exits directly from `FINISHED`, remaining players see `LOBBY`, old words are absent, guest reaches `/` and can create/join. Repeat host exit in another fresh room and assert host transfer. Capture `consoleErrors` and require `[]`.

- [ ] **Step 3: Extend mobile checks**

Keep measured bounding-box assertions, keyboard-open viewport and focus-ring checks. Add the row-level kick target, shared name, final rematch/main-menu targets and no-horizontal-overflow assertions. Do not replace measured checks with class checks.

- [ ] **Step 4: Run browser tests**

Run: `bun run test:e2e -- src/test/e2e/rematch.e2e.ts src/test/e2e/mobile.e2e.ts`
Expected: PASS on chromium and webkit.

Run the existing affected suites (`full-cycle`, `finish-cancel`, `home-join`, `lobby`, `recovery`, `projection-leakage`) and expect PASS.

- [ ] **Step 5: Checkpoint**

Report files and test output; do not commit. Remove generated artifacts not needed for diagnostics.

---

### Task 9: Source-of-truth documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-11-22-words-game-design.md`
- Modify: `docs/superpowers/specs/2026-11-23-friendly-ui-and-rematch-design.md`
- Modify: `docs/api.md`
- Modify: `docs/data-model.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Documents the implemented Task 1–8 behavior; no new runtime contract.

- [ ] **Step 1: Update product rules**

Document `FINISHED → LOBBY`, host-only restart, leave from `FINISHED`, reset semantics and final actions. Remove «несколько раундов» from non-goals; history and cumulative rating remain non-goals. Add restart to the role table and update the final UX section and acceptance criteria.

- [ ] **Step 2: Update API/data/architecture**

Add `/restart`, `canRestart`, `canLeave` phases, reset post-condition and `GameDefinition.resetAttempt`. Document `reset → assertNoGameRecords → delete`, one revision/SSE, no schema migration and resolver injection after locking. Keep secret-word and SSE constraints unchanged.

Mark the new UI/rematch spec «реализовано» only after all checks pass; until then use «в реализации».

- [ ] **Step 3: Verify documentation**

Run: `git diff --check`
Expected: PASS.

Check there are no `TODO`, `TBD`, placeholders or contradictions in limits, scoring, phases, capabilities and copy. Confirm `AGENTS.md` remains unchanged.

- [ ] **Step 4: Checkpoint**

Report files and documentation checks; do not commit.

---

## Integration and final verification

1. Run independent server/security and UI/a11y review agents over the actual working tree. Address Critical/Important findings before final checks.
2. Run `bun run lint` and `bun run typecheck` — expected PASS.
3. Run `bun test` — expected PASS, including integration against the disposable `_test` DB.
4. Run `bun run build` — expected PASS.
5. Run `bun run test:e2e` — expected PASS on configured projects, including four-context rematch and 360 px mobile.
6. Exercise the real browser flow: home with one name, row-level removal, full four-player round, rematch, direct final exit and joining/creating another lobby.
7. Inspect `git status --short`; remove only artifacts created by this implementation that are not deliverables. Do not delete pre-existing user files.
8. Report implemented behavior, exact checks and any unverified limitations. Do not claim completion with red or unrun required checks.
