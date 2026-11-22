# Words Game MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать полный играбельный MVP `WORD_CHAIN`: от создания комнаты и гостевого входа до честного распределения, скрытых персональных подсказок, результатов, SSE-восстановления и mobile-first UI.

**Architecture:** Модульный монолит Next.js 16 с PostgreSQL/Prisma 7. Core владеет комнатами, игроками, сессиями, ревизиями и realtime-интерфейсом; `src/server/games/registry.ts` и `src/server/games/state.ts` являются composition root; модуль `word-chain` владеет правилами, действиями и игровыми проекциями. Все команды существующей комнаты выполняются в интерактивной транзакции после `SELECT ... FOR UPDATE`, а персональный DTO создаётся на сервере отдельно для каждого зрителя.

**Tech Stack:** Bun 1.4.2, Next.js 16.4.6, React 19, TypeScript strict, PostgreSQL, Prisma 7 + `@prisma/adapter-pg`, Zod 4, iron-session 9, Tailwind 4, shadcn/ui, Bun test, Playwright.

## Context

Репозиторий содержит только scaffold: чистый `main` на commit `142e238`, настроенные Prisma Client singleton, Tailwind/shadcn theme, две placeholder-страницы и один unit-тест `cn()`. Модели, миграции, API, игровые правила, сессии, SSE и игровые компоненты отсутствуют. Спецификация и архитектура уже согласованы; повторный brainstorming не требуется.

Источники истины, обязательные для каждого implementer в объёме его задачи:

- `docs/superpowers/specs/2026-11-22-words-game-design.md` — правила и UX;
- `docs/architecture.md` — границы модулей, cookie, SSE, транзакции;
- `docs/data-model.md` — модели, ограничения и последовательности команд;
- `docs/api.md` — HTTP, DTO, SSE и ошибки;
- `docs/development.md` — команды и обязательные проверки.

## Approach

Работа делится на 13 последовательных, независимо проверяемых задач. Каждую задачу выполняет новый coding agent через TDD; после неё отдельный reviewer проверяет одновременно соответствие спецификации и качество кода. Реализация не идёт параллельно в одном worktree: параллельно допускаются только независимые read-only ревью. Рефакторинг выполняется отдельным малым изменением после ревью, с теми же зелёными проверками, без расширения области MVP.

## Global Constraints

- Только `WORD_CHAIN`; участников строго от 3 до 12; новые игроки после старта запрещены.
- При запуске ровно один направленный цикл: каждый автор и адресат встречаются один раз, self-loop и подциклы запрещены; Fisher–Yates использует криптографически стойкий unbiased RNG, не `Math.random()`.
- Собственное слово игрока отсутствует в его JSON, SSE, HTML и RSC-полезной нагрузке до `FINISHED`; маскирование в React/CSS защитой не считается.
- При `hideTargetNamesDuringSetup=true` до `PLAYING` `setup.target=null`, `targetHidden=true`, а `targetPlayerId` и имя адресата отсутствуют в назначении автора; общий roster `players` с именами/ID остаётся разрешённым и не раскрывает связь автор→адресат.
- Все права и фаза повторно проверяются сервером после блокировки строки `Game`; клиентские `capabilities` не являются авторизацией.
- Каждая фактическая команда атомарно меняет состояние и увеличивает `revision` ровно на 1; no-op не меняет ревизию и не публикует событие.
- Первое принятое угадывание фиксирует серверное время, место и очки; `score = N - place + 1`; не угадавшие при досрочном финале получают `place=null`, `score=0`, `finishedAt=null`.
- SSE содержит только `revision`; cookie содержит только `playerId`; админ определяется через актуальный `Game.hostPlayerId` в БД.
- Cookie `wg_session`: HttpOnly, SameSite=Lax, path `/`, Secure в production, TTL 7 дней; секрет только из `SESSION_PASSWORD`.
- Все mutation проверяют Origin и Content-Type/пустое тело; неизвестные поля Zod отклоняются; state/error responses имеют `Cache-Control: no-store`.
- Нормализация имени: Unicode NFKC, trim, повторные whitespace заменяются одним пробелом, уникальность без учёта регистра; слово подвергается только `trim`. Длина считается в Unicode code points через `Array.from(value).length`: имя 1–24, слово 1–80.
- Код комнаты: 6 символов из `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; ввод очищается от whitespace и приводится к uppercase.
- Core не импортирует реализации из `src/server/games/*`; Client Components не импортируют Prisma или server-only модули; общий универсальный движок игр не создаётся.
- Пользовательский текст русский, коды ошибок английские и стабильные; минимальная ширина UI 360 px, сенсорные цели не меньше 44×44 px, доступные подписи, фокус и диалоги.
- Использовать существующие зависимости. shadcn CLI может добавить только зависимости генерируемых компонентов; другие библиотеки не добавлять.
- Логи не содержат слова, cookie, request body, `SESSION_PASSWORD` или `DATABASE_URL`; внутренняя ошибка возвращает только `INTERNAL_ERROR` и correlation ID.

## Orchestration and Quality Gates

1. После утверждения плана применить `superpowers:using-git-worktrees`: создать ветку `feat/word-chain-mvp` и sibling worktree `/Users/mirum7/Documents/projects/words-game-worktrees/word-chain-mvp`, не меняя `main`. Скопировать этот утверждённый план в `docs/superpowers/plans/2026-11-22-word-chain-mvp.md`; добавить `.superpowers/` в `.gitignore` и вести `.superpowers/sdd/progress.md`.
2. Проверить baseline в worktree: `bun install --frozen-lockfile`, `bun run lint`, `bun run typecheck`, `bun test src/test/unit`, `bun run build`. При baseline failure остановить реализацию и вынести причину пользователю, а не маскировать её новыми изменениями. Перед Task 2, если disposable DB ещё не запущена, выполнить `docker run --name words-game-mvp-db --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_USER=words -e POSTGRES_PASSWORD=words -e POSTGRES_DB=words_game_test postgres:18`, дождаться `docker exec words-game-mvp-db pg_isready -U words -d words_game_test`, затем создать E2E БД через `docker exec words-game-mvp-db createdb -U words words_game_e2e`. Существующий контейнер или порт не переиспользовать без проверки назначения.
3. Для каждой Task N зафиксировать `BASE=$(git rev-parse HEAD)`, извлечь brief через `/Users/mirum7/.kimi-code/plugins/managed/superpowers/skills/subagent-driven-development/scripts/task-brief docs/superpowers/plans/2026-11-22-word-chain-mvp.md N`, назначить нового `Agent(subagent_type="coder")` и потребовать TDD, self-review, commit и report-файл.
4. После implementer создать diff через `scripts/review-package BASE HEAD` и назначить отдельного task reviewer. Critical/Important findings исправляет тот же implementer через `resume`, затем повторное ревью. Minor findings заносятся в ledger для финального triage. Без двух явных вердиктов — spec compliance и quality approved — задача не завершена.
5. Каждая задача заканчивается командами `bun run lint`, `bun run typecheck`, `bun test`, `bun run build`; задачи 9–13 дополнительно запускают относящийся `bun run test:e2e`. Reviewer использует предоставленные test evidence, а orchestrator повторяет весь набор на финальном deliverable.
6. Рефакторинг-гейты: после Task 2 — схема/ограничения; после Task 5 — транзакционный Core и DI realtime; после Tasks 8–9 — границы и утечки проекций/API; после Task 12 — client bundle и дублирование UI; после Task 13 — целое branch review.
7. Финальное ревью получает diff от merge-base до HEAD. Независимые architecture/security/acceptance-проверки можно выполнить через AgentSwarm read-only; все исправления финального ревью передаются одному fix agent общим списком, затем ревью повторяется.

## File Structure

- `src/shared/contracts/game.ts` — единственные клиентские API DTO и request-типы.
- `src/server/core/{auth,games,players,results,realtime}` — сессии, комнаты, блокировки, lobby mutations, результаты и publisher.
- `src/server/http` — единый формат ошибок, Zod parsing, Origin, rate limit, безопасные логи.
- `src/server/games/word-chain` — чистые правила, Zod-схемы, команды и игровая проекция.
- `src/server/games/{registry,state}.ts` — единственная связка Core и игровых модулей.
- `src/app/api/v1` — тонкие Route Handlers без игровых правил.
- `src/components/game` — общий room shell, синхронизация и lobby; `src/components/game/word-chain` — экраны конкретной игры.
- `src/test/unit` — чистые правила и reducer синхронизации; `src/test/integration` — реальная PostgreSQL; `src/test/e2e/*.e2e.ts` — Playwright против production server.

---

### Task 1: Shared Contracts and Test Foundations

**Files:**
- Create: `src/shared/contracts/game.ts`, `src/server/core/games/types.ts`, `src/server/core/realtime/types.ts`, `src/test/integration/database.ts`, `src/test/unit/database-url.test.ts`
- Modify: `.env.example`, `.gitignore`, `playwright.config.ts`, `docs/development.md`

**Interfaces:**
- Produces: все DTO из `docs/api.md` §3–4, `GameRealtime`, `GameDefinition`, `assertDisposableDatabaseUrl()`, `getTestDatabaseUrl()`.
- `GameDefinition` на Task 1 содержит только metadata; Core-hooks для создания, настроек и проекции добавляются в Tasks 5 и 8, без универсального языка действий.

- [ ] **Step 1: Write failing contract and database-safety tests**

```ts
import { describe, expect, test } from "bun:test";
import { assertDisposableDatabaseUrl } from "@/test/integration/database";

describe("test database safety", () => {
  test("accepts only local disposable databases", () => {
    expect(() => assertDisposableDatabaseUrl("postgresql://u:p@127.0.0.1:55432/words_game_test", "_test")).not.toThrow();
    expect(() => assertDisposableDatabaseUrl("postgresql://u:p@127.0.0.1:55432/words_game", "_test")).toThrow("TEST_DATABASE_UNSAFE");
    expect(() => assertDisposableDatabaseUrl("postgresql://u:p@example.com/words_game_test", "_test")).toThrow("TEST_DATABASE_UNSAFE");
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test src/test/unit/database-url.test.ts`
Expected: FAIL, модуль `@/test/integration/database` отсутствует.

- [ ] **Step 3: Implement exact contracts and safe harness**

В `game.ts` перенести без изменений `CreateGameRequest`, `JoinGameRequest`, `UpdateSettingsRequest`, `ReadinessRequest`, `SubmitWordRequest`, `GamePhase`, `PlayerSummary`, `PlayerRef`, `SetupState`, `HintItem`, `ResultItem`, `Capabilities`, `GameStateResponse` из `docs/api.md`; не добавлять секретные или Prisma-поля.

```ts
export interface GameRealtime {
  publish(gameId: string, revision: number): void;
  subscribe(gameId: string, listener: (revision: number) => void): () => void;
}

export type GameDefinition = {
  readonly type: "WORD_CHAIN";
  readonly minPlayers: 3;
  readonly maxPlayers: 12;
};
```

```ts
export function assertDisposableDatabaseUrl(raw: string, suffix: "_test" | "_e2e"): void {
  const url = new URL(raw);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || !url.pathname.slice(1).endsWith(suffix)) throw new Error("TEST_DATABASE_UNSAFE");
}

export function getTestDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? "postgresql://words:words@127.0.0.1:55432/words_game_test";
  assertDisposableDatabaseUrl(raw, "_test");
  return raw;
}
```

В `.env.example` добавить fictitious `TEST_DATABASE_URL=postgresql://words:words@127.0.0.1:55432/words_game_test` и `E2E_DATABASE_URL=postgresql://words:words@127.0.0.1:55432/words_game_e2e`. В Playwright установить `testMatch: "**/*.e2e.ts"`, чтобы Bun test не импортировал E2E. В `.gitignore` добавить `.superpowers/`; в development docs зафиксировать разделение `*.test.ts` и `*.e2e.ts`, test URLs и запрет development/production БД.

- [ ] **Step 4: Verify GREEN and full gates**

Run: `bun test src/test/unit/database-url.test.ts && bun run lint && bun run typecheck && bun test && bun run build`
Expected: все команды exit 0; существующий `cn` test также PASS.

- [ ] **Step 5: Commit and review**

```bash
git add .env.example .gitignore playwright.config.ts docs/development.md src/shared/contracts src/server/core/games/types.ts src/server/core/realtime/types.ts src/test
git commit -m "chore: add game contracts and test foundations"
```

### Task 2: PostgreSQL Schema and Invariants

**Files:**
- Modify: `prisma/schema.prisma`, `src/server/db.ts`, `src/test/integration/database.ts`
- Create: `prisma/migrations/20261122000000_init/migration.sql`, `src/test/integration/schema.test.ts`

**Interfaces:**
- Produces: Prisma models `Game`, `Player`, `GameResult`, `WordChainGame`, `WordAssignment`, enums и typed `TransactionClient` для последующих сервисов.

- [ ] **Step 1: Write failing real-PostgreSQL tests**

Тесты применяют `prisma migrate deploy` к `getTestDatabaseUrl()`, затем проверяют constraints прямыми вставками: duplicate `(gameId,normalizedName)`, duplicate `(gameId,authorPlayerId)`, duplicate `(gameId,targetPlayerId)`, duplicate `(gameId,place)`, self-assignment, `place=0`, результат с местом и нулевыми очками, место без `finishedAt`, слово без `submittedAt`, пустое/81-code-point слово. Отдельный тест вставляет два результата с `place=null` и подтверждает, что PostgreSQL это разрешает.

```ts
await expect(prisma.wordAssignment.create({ data: {
  gameId: game.id, authorPlayerId: player.id, targetPlayerId: player.id,
} })).rejects.toThrow();
```

- [ ] **Step 2: Verify RED on clean test DB**

Run: `DATABASE_URL="${TEST_DATABASE_URL:-postgresql://words:words@127.0.0.1:55432/words_game_test}" bun run db:migrate && bun test src/test/integration/schema.test.ts`
Expected: FAIL до миграции из-за отсутствующих таблиц; тест не запускается против URL без `_test`.

- [ ] **Step 3: Implement schema and migration**

Создать пять моделей и три enum строго по `docs/data-model.md`: UUID, `code @unique @db.VarChar(6)`, все перечисленные unique, `WordChainGame` создаётся один-к-одному, временные метки UTC. Зафиксировать `@@map("games")`, `@@map("players")`, `@@map("game_results")`, `@@map("word_chain_games")`, `@@map("word_assignments")`; имена полей в SQL остаются quoted camelCase. Две Game↔Player связи именуются `GamePlayers` и `GameHost`; `hostPlayerId` nullable+unique+`onDelete: Restrict`, поэтому сервис сначала переназначает/очищает host, затем удаляет игрока. Удаление комнаты каскадирует её игровые записи; удаление отдельного Player не каскадирует назначения/результаты.

Добавить в первоначальную миграцию SQL CHECK:

```sql
ALTER TABLE "word_assignments" ADD CONSTRAINT "word_assignments_no_self_target"
  CHECK ("authorPlayerId" <> "targetPlayerId");
ALTER TABLE "word_assignments" ADD CONSTRAINT "word_assignments_word_submission_pair"
  CHECK (("word" IS NOT NULL) = ("submittedAt" IS NOT NULL));
ALTER TABLE "word_assignments" ADD CONSTRAINT "word_assignments_word_length"
  CHECK ("word" IS NULL OR char_length(btrim("word")) BETWEEN 1 AND 80);
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_place_positive"
  CHECK ("place" IS NULL OR "place" >= 1);
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_place_time_pair"
  CHECK (("finishedAt" IS NOT NULL) = ("place" IS NOT NULL));
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_score_place_pair"
  CHECK (("score" > 0) = ("place" IS NOT NULL));
```

В `src/server/db.ts` экспортировать `Prisma` вместе с клиентом и добавить `export type TransactionClient = Prisma.TransactionClient;`. Сгенерировать базовый DDL командой `bunx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > prisma/migrations/20261122000000_init/migration.sql`, добавить перечисленные CHECK и применить через `DATABASE_URL="${TEST_DATABASE_URL:-postgresql://words:words@127.0.0.1:55432/words_game_test}" bun run db:migrate`. Не вводить ручную правку generated Client. `database.ts` должен выполнять migrate deploy один раз на test run и очищать таблицы между тестами в одном порядке, не отключая constraints.

- [ ] **Step 4: Verify GREEN, clean migration and gates**

Run: `bun test src/test/integration/schema.test.ts && bun run db:generate && bun run lint && bun run typecheck && bun test && bun run build`
Expected: все DB-invariant tests PASS; миграция применяется к чистой `words_game_test` без drift.

- [ ] **Step 5: Commit, schema review and refactor gate**

```bash
git add prisma src/test/integration src/server/db.ts
git commit -m "feat: add words game data model"
```

Reviewer отдельно сверяет каждое поле, FK, unique и CHECK с `docs/data-model.md`; после исправлений не начинать Task 3 с красной схемой.

### Task 3: Pure WORD_CHAIN Rules

**Files:**
- Create: `src/server/games/word-chain/{rules,random,validation,types}.ts`
- Test: `src/test/unit/word-chain/{rules,validation}.test.ts`

**Interfaces:**
- Produces: `buildCycle(playerIds, randomInt)`, `assertSingleCycle(pairs)`, `normalizeName`, `nameKey`, `normalizeWord`, `normalizeCode`, `getPublicPhase`, `canStart`, `scoreForPlace`, `compareResults`.
- Consumes: никаких Next.js, Prisma или HTTP зависимостей.

- [ ] **Step 1: Write failing invariant tests**

```ts
for (let n = 3; n <= 12; n += 1) {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const pairs = buildCycle(ids, sequenceRandom([0, 1, 0]));
  expect(new Set(pairs.map((p) => p.authorPlayerId)).size).toBe(n);
  expect(new Set(pairs.map((p) => p.targetPlayerId)).size).toBe(n);
  expect(pairs.some((p) => p.authorPlayerId === p.targetPlayerId)).toBe(false);
  expect(() => assertSingleCycle(pairs)).not.toThrow();
  expect(() => assertSingleCycle(swapTwoTargets(pairs))).toThrow("SINGLE_CYCLE_REQUIRED");
}
```

Добавить обход от каждого игрока: ровно N разных вершин и возврат в начало; тесты подциклов для чётных N; границы RNG; deterministic shuffled order; NFKC/case/whitespace имени; trim-only слова; emoji для code-point длины; код комнаты; все публичные фазы; запуск при 2/3/12/13 и неготовых; очки N=4 → 4,3,2,1; сортировку place и `(normalizedName,id)`.

- [ ] **Step 2: Verify RED**

Run: `bun test src/test/unit/word-chain`
Expected: FAIL из-за отсутствующих rule functions.

- [ ] **Step 3: Implement pure rules**

```ts
export type RandomInt = (maxExclusive: number) => number;
export type AssignmentPair = { authorPlayerId: string; targetPlayerId: string };

export function buildCycle(playerIds: readonly string[], randomInt: RandomInt): AssignmentPair[] {
  if (playerIds.length < 3 || playerIds.length > 12 || new Set(playerIds).size !== playerIds.length) {
    throw new Error("INVALID_PLAYER_SET");
  }
  const order = [...playerIds];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) throw new Error("RNG_OUT_OF_RANGE");
    [order[i], order[j]] = [order[j], order[i]];
  }
  const pairs = order.map((authorPlayerId, i) => ({
    authorPlayerId,
    targetPlayerId: order[(i + 1) % order.length],
  }));
  assertSingleCycle(pairs);
  return pairs;
}

export function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}
export function nameKey(value: string): string {
  return normalizeName(value).toLowerCase();
}
export function normalizeWord(value: string): string { return value.trim(); }
export function normalizeCode(value: string): string { return value.replace(/\s+/gu, "").toUpperCase(); }
export function scoreForPlace(playerCount: number, place: number): number { return playerCount - place + 1; }
```

`random.ts` экспортирует `cryptoRandomInt(maxExclusive)` через `node:crypto.randomInt`. `assertSingleCycle` строит `Map<author,target>`, проверяет размеры/self-loop и обходит от первого автора ровно N шагов до возврата; любая преждевременная повторная вершина или непосещённый игрок даёт `SINGLE_CYCLE_REQUIRED`. Остальные функции реализуют формулы и сортировку без побочных эффектов.

- [ ] **Step 4: Verify GREEN and gates**

Run: `bun test src/test/unit/word-chain && bun run lint && bun run typecheck && bun test && bun run build`
Expected: N=3..12 и все validation/transition tests PASS.

- [ ] **Step 5: Commit and review**

```bash
git add src/server/games/word-chain src/test/unit/word-chain
git commit -m "feat: add word chain domain rules"
```

### Task 4: Guest Sessions and HTTP Security Primitives

**Files:**
- Create: `src/server/core/auth/{session,auth}.ts`, `src/server/http/{errors,request,rate-limit,logging}.ts`
- Modify: `docs/api.md`, `docs/development.md`, `docs/superpowers/specs/2026-11-22-words-game-design.md`
- Test: `src/test/unit/http/{request,rate-limit,errors}.test.ts`, `src/test/integration/auth.test.ts`

**Interfaces:**
- Produces: `GuestSession={playerId:string}`, `getGuestSession`, `setGuestPlayer`, `clearGuestSession`, `getOptionalPlayerId`, `requireMembership`, `ApiError`, `handleApi`, `requireOrigin`, `parseJson`, `requireEmptyBody`, `checkRateLimit`.
- All auth checks reload Player/Game; mutation services still repeat membership/admin checks under lock.

- [ ] **Step 1: Write failing tests**

Проверить отсутствующий/повреждённый/expired cookie → 401 `UNAUTHENTICATED`; чужая комната → 403 `FORBIDDEN`; отсутствующий или несовпадающий Origin → 400 `ORIGIN_REJECTED`; точный `APP_ORIGIN` разрешён; non-JSON, malformed JSON, unknown fields и тело у empty-body mutation → 400 `VALIDATION_ERROR`; ошибка содержит `fieldErrors` только для validation; 500 скрывает internals и содержит correlation ID. Rate limiter с injected clock: первые N запросов проходят, N+1 даёт `RATE_LIMITED`, новое окно снова разрешает.

- [ ] **Step 2: Verify RED**

Run: `bun test src/test/unit/http src/test/integration/auth.test.ts`
Expected: FAIL из-за отсутствующих auth/http модулей.

- [ ] **Step 3: Implement session and HTTP wrappers**

Использовать подтверждённый Next 16 API `getIronSession<GuestSession>(await cookies(), options)`, `session.save()` и `session.destroy()`. `SESSION_PASSWORD` валидируется при первом использовании: минимум 32 символа; `ttl` и cookie `maxAge` равны `604800`; `secure: process.env.NODE_ENV === "production"`. Session object не расширять никакими полями кроме `playerId`.

`handleApi` централизованно преобразует ошибки и ставит `no-store`. `parseJson` требует `application/json`, вызывает `.strict()` Zod-схему и не возвращает request body в ошибку/лог. `requireOrigin` требует точного совпадения `request.headers.get("origin")` с `APP_ORIGIN`, включая обязательное наличие заголовка. Rate limiting in-memory, fixed window, ключ `(route, ip)`: create/join 30 запросов за 60 секунд, остальные mutations 120 за 60 секунд; clock и limits внедряются для тестов. Использовать первый адрес `x-forwarded-for` только при наличии доверенного reverse proxy, иначе локальный peer/fallback; поведение задокументировать. Лог mutation содержит только `action`, `gameId`, `playerId`, `outcome`, `revision`, correlation ID.

- [ ] **Step 4: Verify GREEN and gates**

Run: `bun test src/test/unit/http src/test/integration/auth.test.ts && bun run lint && bun run typecheck && bun test && bun run build`
Expected: все auth/error/origin/rate-limit tests PASS, секреты отсутствуют в serialized errors/logs.

- [ ] **Step 5: Commit and review**

```bash
git add src/server/core/auth src/server/http src/test/unit/http src/test/integration/auth.test.ts docs/api.md docs/development.md
git commit -m "feat: add guest authentication and HTTP guards"
```

Одновременно в `docs/api.md` зафиксировать обязательный Origin и численные rate limits. В спецификации §5.3 уточнить выбранную трактовку: скрываются `setup.target` и связь автор→адресат, а общий roster остаётся видимым; добавить к commit `docs/superpowers/specs/2026-11-22-words-game-design.md`.

### Task 5: Transactional Core and Lobby Commands

**Files:**
- Create: `src/server/core/games/{lock,command,code,schemas,service}.ts`, `src/server/core/players/{schemas,service}.ts`, `src/server/core/realtime/in-memory.ts`, `src/server/games/word-chain/{schemas,settings,service}.ts`, `src/server/games/registry.ts`
- Modify: `src/server/core/games/types.ts`
- Test: `src/test/integration/{lobby,realtime}.test.ts`, `src/test/unit/code.test.ts`

**Interfaces:**
- Produces: `runGameCommand`, `createGame`, `joinGame`, `setReadiness`, `updateSettings`, `removePlayer`, `leaveGame`, `InMemoryGameRealtime`.
- `runGameCommand` returns committed `{gameId,revision,changed,value}` and publishes after commit only when `changed=true`.

- [ ] **Step 1: Write failing lobby and publication tests**

Покрыть create (creator admin, not ready, default setting), join и repeat-join с той же cookie без дубликата, NFKC/case duplicate name, нормализацию кода, retry code collision, 13-го игрока `GAME_FULL`, join после старта, readiness only self, no-op readiness, admin-only settings/kick, запрет admin self-kick, leave с переносом host по `(joinedAt,id)`, удаление последнего игрока вместе с комнатой. Spy realtime проверяет равенство опубликованной и сохранённой ревизии, публикацию после commit и отсутствие publish/revision bump для no-op.

- [ ] **Step 2: Verify RED**

Run: `bun test src/test/integration/lobby.test.ts src/test/integration/realtime.test.ts src/test/unit/code.test.ts`
Expected: FAIL из-за отсутствующих команд.

- [ ] **Step 3: Implement locked commands**

```ts
export type CommandOutcome<T> = { value: T; changed: boolean };
export async function runGameCommand<T>(input: {
  code: string;
  realtime: GameRealtime;
  action: string;
  command: (tx: TransactionClient, game: Game) => Promise<CommandOutcome<T>>;
}): Promise<{ gameId: string; revision: number; changed: boolean; value: T }>;
```

Внутри `$transaction` выполнить параметризованный `SELECT "id" FROM "games" WHERE "code"=$1 FOR UPDATE`, повторно загрузить typed Game и только затем вызвать command. При `changed` атомарно `revision += 1`; после успешного commit вызвать `realtime.publish(gameId,newRevision)`. Ошибка откатывает всё и ничего не публикует. Ответ строится после commit отдельной персональной проекцией.

Добавить strict Zod-схемы `createGameSchema` (`name:string`, optional `gameType:"WORD_CHAIN"`), `joinGameSchema` (`name:string`), `readinessSchema` (`ready:boolean`) и `wordChainSettingsSchema` (`hideTargetNamesDuringSetup:boolean`). Нормализация и лимиты применяются после синтаксической проверки, до доменной записи.

Create делает Game+Player+WordChainGame+host в одной транзакции и повторяет только unique collision кода. Join сначала разрешает существующего игрока этой комнаты как no-op в любой фазе; новый игрок допускается только в LOBBY и при `<12`. Settings вызываются через `GameDefinition.updateSettings` из composition root, поэтому Core не знает поле `hideTargetNamesDuringSetup`. Delete/leave проверяют отсутствие игровых записей, host переназначается до удаления; перед удалением последней комнаты host очищается. `InMemoryGameRealtime` хранит Set listeners на gameId в process-global singleton и `subscribe` возвращает рабочий cleanup.

- [ ] **Step 4: Verify GREEN and gates**

Run: `bun test src/test/integration/lobby.test.ts src/test/integration/realtime.test.ts src/test/unit/code.test.ts && bun run lint && bun run typecheck && bun test && bun run build`
Expected: все lobby, unique collision, post-commit publication и no-op tests PASS.

- [ ] **Step 5: Commit, review and Core refactor gate**

```bash
git add src/server/core src/server/games src/test/integration/lobby.test.ts src/test/integration/realtime.test.ts src/test/unit/code.test.ts
git commit -m "feat: implement transactional room lobby"
```

Reviewer проверяет, что Core не импортирует `server/games/*`, все права повторяются под lock и нигде нет publish до commit. Дублирование авторизации/ревизий выносится в Core helper до Task 6.

### Task 6: Start, Word Submission and Cancellation

**Files:**
- Modify: `src/server/games/word-chain/{schemas,service}.ts`, `src/server/games/registry.ts`
- Test: `src/test/integration/word-setup.test.ts`

**Interfaces:**
- Produces: `startWordChain(code,playerId)`, `submitWord(code,playerId,input)`, `cancelWordChain(code,playerId)`.
- Consumes: `runGameCommand`, `buildCycle`, `cryptoRandomInt`, validation из Task 3.

- [ ] **Step 1: Write failing transition and concurrency tests**

Проверить non-admin start, `<3`, `>12`, `NOT_ALL_READY`, неверную фазу; start создаёт ровно N назначений и один цикл, `ACTIVE/ASSIGNING_WORDS`, `startedAt`, revision+1. Два concurrent start не создают дубликатов и оставляют одну попытку. Word: только своё назначение, trim, 1–80, редактирование до PLAYING, одинаковое значение no-op, чужие слова не возвращаются, последнее слово атомарно переводит в PLAYING и ставит `playingStartedAt`. Concurrent words разных авторов не оставляют частичное финальное состояние. Cancel только admin/ASSIGNING_WORDS: удаляет assignments/results, сбрасывает readiness и timestamps, сохраняет игроков/host/settings, revision не уменьшается; повторный запуск после готовности работает.

- [ ] **Step 2: Verify RED**

Run: `bun test src/test/integration/word-setup.test.ts`
Expected: FAIL из-за отсутствующих игровых команд.

- [ ] **Step 3: Implement commands under the Game lock**

Start заново читает игроков в детерминированном порядке `(joinedAt,id)`, строит pairs одним `buildCycle`, проверяет graph до записи и создаёт все назначения в той же транзакции. Submit выполняет upsert только `(gameId,authorPlayerId=viewer)`; совпавшее normalized word возвращает `changed=false`; при изменении проверяет count assignments и count submitted после записи и один раз увеличивает revision при переходе. Cancel удаляет именно данные текущей комнаты, не трогая Players/WordChainGame settings.

- [ ] **Step 4: Verify GREEN and gates**

Run: `bun test src/test/integration/word-setup.test.ts && bun run lint && bun run typecheck && bun test && bun run build`
Expected: все transition, rollback, repeat и concurrent-word tests PASS.

- [ ] **Step 5: Commit and review**

```bash
git add src/server/games/word-chain src/server/games/registry.ts src/test/integration/word-setup.test.ts
git commit -m "feat: implement word assignment phase"
```

### Task 7: Guessing, Results and Early Finish

**Files:**
- Create: `src/server/core/results/service.ts`
- Modify: `src/server/games/word-chain/service.ts`
- Test: `src/test/integration/results.test.ts`

**Interfaces:**
- Produces: `markGuessed(code,playerId)`, `finishWordChain(code,playerId)`, Core helper записи результата с server clock.
- `now()` внедряется в service tests; клиентские timestamps не принимаются.

- [ ] **Step 1: Write failing result and race tests**

Для N=4 места и очки 1→4, 2→3, 3→2, 4→1; `finishedAt` серверное; duration вычисляется от `playingStartedAt`. Repeat guessed не меняет result/revision и возвращает success даже после последнего auto-FINISHED. Concurrent guesses разных игроков получают уникальные последовательные места по порядку принятия lock. Последний guessed ставит FINISHED и Game.finishedAt. Early finish только admin/PLAYING сохраняет существующие результаты и создаёт остальным null/0/null; сортировка негадавших по `(normalizedName,id)`. Race guessed/finish соответствует порядку commit: раннее угадывание сохраняется, позднее после finish отклоняется.

- [ ] **Step 2: Verify RED**

Run: `bun test src/test/integration/results.test.ts`
Expected: FAIL из-за отсутствующих result commands.

- [ ] **Step 3: Implement first-success-wins commands**

Под одной Game lock сначала найти текущий результат игрока. Если `place` уже существует, вернуть `changed=false` до проверки фазы. Иначе требовать PLAYING, вычислить `place=count(place not null)+1`, `score=N-place+1`, создать результат с серверным `now`; при `place=N` завершить игру в том же commit. Early finish заполняет только отсутствующие результаты и никогда не обновляет существующие. Не использовать клиентское время или отдельную неблокирующую count-then-insert последовательность.

- [ ] **Step 4: Verify GREEN and gates**

Run: `bun test src/test/integration/results.test.ts && bun run lint && bun run typecheck && bun test && bun run build`
Expected: все repeat/concurrent/race/finish tests PASS без unique violations наружу.

- [ ] **Step 5: Commit and review**

```bash
git add src/server/core/results src/server/games/word-chain/service.ts src/test/integration/results.test.ts
git commit -m "feat: implement guessing and game results"
```

### Task 8: Per-Viewer Projection and State Query

**Files:**
- Create: `src/server/games/word-chain/projection.ts`, `src/server/core/games/projection.ts`, `src/server/games/state.ts`
- Modify: `src/server/core/games/types.ts`, `src/server/games/registry.ts`
- Test: `src/test/integration/projection.test.ts`

**Interfaces:**
- Produces: `getGameState(code,viewerPlayerId): Promise<GameStateResponse>`, Core base DTO builder и `GameDefinition.project`.
- Game module возвращает только `setup`, `hints`, `results` и game-specific capabilities; Core добавляет общие game/viewer/players/capabilities. Core получает definition параметром и не импортирует registry.

- [ ] **Step 1: Write failing serialized-secret tests**

Создать четырёх игроков с уникальными секретами `SECRET_MASHA_01`, `SECRET_PETYA_02`, `SECRET_VANYA_03`, `SECRET_SASHA_04`. Для каждой фазы и каждого viewer сериализовать DTO через `JSON.stringify` и проверять фактические значения, а не только имена полей:

- LOBBY: setup/hints/results равны null;
- ASSIGNING_WORDS: только собственное setup.word, чужих секретов нет; при hidden target `setup.target=null`, `targetHidden=true`, target id/name отсутствуют в `setup` и в любом assignment-specific поле; общий `players` roster при этом сохраняется;
- PLAYING: ровно одно `wordHidden=true` — собственное назначение viewer; его секрет отсутствует, остальные слова видны;
- FINISHED: все слова видны, `wordHidden=false`, рейтинг отсортирован и durationMs корректен;
- players всегда `(joinedAt,id)`; flags раскрывают только факты submit/guess; capabilities соответствуют правам/фазе и готовности.

- [ ] **Step 2: Verify RED**

Run: `bun test src/test/integration/projection.test.ts`
Expected: FAIL из-за отсутствующей проекции.

- [ ] **Step 3: Implement server-side minimization**

Использовать согласованное read transaction без Game lock. Core загружает Game, viewer, ordered Players и module definition через composition root. В LOBBY не читать слова для DTO. В ASSIGNING_WORDS запросить только назначение автора-viewer и submitted flags; при hidden target вернуть ровно `target:null,targetHidden:true` и не присоединять target к projection result, иначе вернуть разрешённый `PlayerRef` и `targetHidden:false`. В PLAYING запросить назначения, но для `targetPlayerId=viewer.playerId` сформировать `{word:null,wordHidden:true}` на сервере до создания ответа. В FINISHED раскрыть все words. Общий полный DTO с последующим client-side masking запрещён.

- [ ] **Step 4: Verify GREEN, gates and security review**

Run: `bun test src/test/integration/projection.test.ts && bun run lint && bun run typecheck && bun test && bun run build`
Expected: phase×viewer matrix PASS, serialized secrets отсутствуют именно там, где запрещены.

- [ ] **Step 5: Commit and projection refactor gate**

```bash
git add src/server/core/games src/server/games src/test/integration/projection.test.ts
git commit -m "feat: add per-player game state projection"
```

Отдельный security reviewer сверяет serialized response и отсутствие общего cached DTO; обнаруженные утечки блокируют Task 9.

### Task 9: Complete Versioned HTTP API

**Files:**
- Create: все handlers из `docs/api.md` под `src/app/api/v1/games`, включая `[code]/state`, `join`, `settings`, `readiness`, `start`, `word`, `guessed`, `finish`, `cancel`, `players/[playerId]`, `leave`
- Create: `src/test/e2e/global-setup.ts`, `src/test/e2e/api.e2e.ts`, `src/test/e2e/helpers.ts`
- Modify: `playwright.config.ts`

**Interfaces:**
- Consumes: только публичные services/projections; handlers не содержат игровых правил.
- Produces: реальные HTTP/cookie/error контракты для UI.

- [ ] **Step 1: Configure production E2E server and write failing API tests**

Playwright использует `testMatch:"**/*.e2e.ts"`, `workers:1`, `timeout:60_000`, baseURL `http://127.0.0.1:3100` и projects с именами `chromium`/`webkit`. `webServer` с `reuseExistingServer:false` запускает `bun run build && bun run start --port 3100` с `DATABASE_URL=E2E_DATABASE_URL`, `APP_ORIGIN=http://127.0.0.1:3100` и отдельным тестовым `SESSION_PASSWORD`. Global setup проверяет суффикс `_e2e`, применяет `prisma migrate deploy` и очищает БД; development URL запрещён.

API tests через независимые Playwright request contexts покрывают каждый route, cookie attributes, повторный join, `no-store`, Origin absent/mismatch, Content-Type, unknown fields, empty-body mutations, 401/403/404/409, validation fieldErrors и 429 на отдельном IP. Каждый тест получает уникальный test IP через управляемый `x-forwarded-for`, чтобы лимиты разных сценариев не складывались; только rate-limit test намеренно повторяет один IP. Success mutation возвращает DTO вызывающего; create 201, join/mutations 200, leave 204 и удаляет cookie.

- [ ] **Step 2: Verify RED against production server**

Run: `bun run test:e2e -- --project=chromium src/test/e2e/api.e2e.ts`
Expected: FAIL, routes возвращают 404 до реализации.

- [ ] **Step 3: Implement thin route handlers**

Каждый handler: rate limit → Origin/body guard для mutation → cookie identity для protected route → service → персональный `getGameState` → JSON с `Cache-Control:no-store`. Path code нормализуется. Create/join сохраняют session только после commit; existing-player join не меняет identity; leave уничтожает session после успешного leave. Caller `playerId` никогда не читается из body. `DELETE players/[playerId]` использует target id только из path и admin identity только из cookie. Внутренние ошибки проходят через `handleApi`.

- [ ] **Step 4: Verify GREEN and all gates**

Run: `bun run test:e2e -- --project=chromium src/test/e2e/api.e2e.ts && bun run lint && bun run typecheck && bun test && bun run build`
Expected: API suite PASS на реальном production server; все остальные checks exit 0.

- [ ] **Step 5: Commit and API security review**

```bash
git add src/app/api playwright.config.ts src/test/e2e docs/api.md
git commit -m "feat: expose versioned game API"
```

### Task 10: SSE Protocol and Revision-Safe Client Synchronization

**Files:**
- Create: `src/app/api/v1/games/[code]/events/route.ts`, `src/components/game/use-game-state.ts`, `src/components/game/api-client.ts`, `src/components/game/sync-reducer.ts`
- Test: `src/test/e2e/sse.e2e.ts`, `src/test/unit/sync-reducer.test.ts`

**Interfaces:**
- Produces: authenticated SSE и `useGameState(code,initialState)` с `state`, `connectionStatus`, `refresh`, mutation helpers.
- Consumes: `GameRealtime`, `/state`, mutation responses.

- [ ] **Step 1: Write failing stream and stale-response tests**

SSE test без cookie получает обычный JSON 401 до открытия. Авторизованный stream имеет точные headers, `retry: 3000`, initial `game.changed` с текущей revision, heartbeat `: ping` через 15 секунд и событие `id:<revision>`/`data:{"revision":n}` после реальной mutation. Payload не содержит code, имена, назначения, результаты или слова. Unsubscribe/cancel удаляет listener и heartbeat. Reducer tests: initial open всегда запрашивает state; меньшая/равная revision не перезаписывает новую; mutation response применяется сразу; late older fetch отбрасывается; reconnect не меняет identity и запрашивает полный state.

- [ ] **Step 2: Verify RED**

Run: `bun test src/test/unit/sync-reducer.test.ts && bun run test:e2e -- --project=chromium src/test/e2e/sse.e2e.ts`
Expected: FAIL из-за отсутствующего events route и sync modules.

- [ ] **Step 3: Implement stream and race-safe hook**

Route сначала проверяет membership, затем создаёт `ReadableStream`: subscribe → initial current revision → heartbeat каждые 15000 ms; `cancel()` очищает оба ресурса. Headers: `text/event-stream`, `no-cache,no-transform`, `keep-alive`, `X-Accel-Buffering:no`. После открытия HTTP status не меняется.

Client hook на каждом `EventSource.open` вызывает `/state`; `game.changed` вызывает refresh только при большей revision. AbortController/sequence token отменяет или отбрасывает предыдущий запрос; reducer никогда не применяет DTO старше текущего. Mutation helper принимает JSON только ожидаемого контракта, передаёт Origin браузером автоматически, показывает pending и применяет returned DTO. Разрыв отображает «Переподключение», не вызывает leave.

- [ ] **Step 4: Verify GREEN and gates**

Run: `bun test src/test/unit/sync-reducer.test.ts && bun run test:e2e -- --project=chromium src/test/e2e/sse.e2e.ts && bun run lint && bun run typecheck && bun test && bun run build`
Expected: stream, cleanup, post-commit revision и stale-response tests PASS.

- [ ] **Step 5: Commit and review**

```bash
git add src/app/api/v1/games/[code]/events src/components/game src/test/e2e/sse.e2e.ts src/test/unit/sync-reducer.test.ts
git commit -m "feat: synchronize game state over SSE"
```

### Task 11: Home, Server Room Page and Lobby UI

**Files:**
- Modify: `src/app/page.tsx`, `src/app/game/[code]/page.tsx`, `src/app/layout.tsx`, `src/app/globals.css`
- Create: `src/components/game/{home-forms,join-form,game-room,lobby,connection-indicator}.tsx`, shadcn components в `src/components/ui`
- Test: `src/test/e2e/lobby.e2e.ts`

**Interfaces:**
- Consumes: `GameStateResponse`, `useGameState`, API client.
- Server page получает только DTO текущей cookie через прямой `getGameState`, без внутреннего HTTP fetch.

- [ ] **Step 1: Add failing browser journey**

Два независимых context: admin создаёт комнату по имени, второй игрок входит по коду/invite; оба видят один состав и readiness после SSE. Проверить copy/share fallback, admin-only settings, disabled start reason, self readiness, remove/leave, reload identity. Отдельно проверить labels/errors/pending, keyboard focus и viewport 360 px без horizontal overflow.

- [ ] **Step 2: Verify RED**

Run: `bun run test:e2e -- --project=chromium src/test/e2e/lobby.e2e.ts`
Expected: FAIL на placeholder UI.

- [ ] **Step 3: Implement mobile-first accessible UI**

Добавить shadcn `button`, `input`, `label`, `card`, `switch`, `alert`, `alert-dialog`, `badge`, `separator` через configured CLI. Home разделяет «Создать игру» и «Подключиться по коду»; invite page с неизвестной/чужой cookie показывает join form с обязательным именем и готовым code. Ошибки API располагаются у полей, pending предотвращает double submit, после success выполняется navigation на `/game/{code}`.

`GamePage` awaits `params`, читает session и вызывает `getGameState`; отсутствие авторизации не превращается в пустой DTO. `GameRoom` хранит только серверное состояние из initial DTO+hook. Lobby показывает code, players, host/readiness, settings admin, remove/leave и точную причину недоступности start. Все targets минимум 44 px, видимый focus, русский текст, системный share только при поддержке и copy fallback.

- [ ] **Step 4: Verify GREEN and gates**

Run: `bun run test:e2e -- --project=chromium src/test/e2e/lobby.e2e.ts && bun run lint && bun run typecheck && bun test && bun run build`
Expected: lobby journey и accessibility/mobile assertions PASS.

- [ ] **Step 5: Commit and UI refactor review**

```bash
git add src/app src/components package.json bun.lock src/test/e2e/lobby.e2e.ts
git commit -m "feat: add home and lobby experience"
```

### Task 12: Word Setup, Playing, Spectator and Final UI

**Files:**
- Create: `src/components/game/word-chain/{word-setup,playing-room,final-results,hint-list}.tsx`
- Modify: `src/components/game/game-room.tsx`
- Test: `src/test/e2e/{full-cycle,hidden-target,finish-cancel,projection-leakage}.e2e.ts`

**Interfaces:**
- Consumes: phase-specific DTO и capabilities; игровой UI отделён от общего lobby.
- Produces: полный четырёхконтекстный пользовательский сценарий.

- [ ] **Step 1: Write four-context acceptance journeys before UI**

Все сценарии используют `browser.newContext()` для Маши, Пети, Вани и Саши, не вкладки с общей cookie:

1. Полный AC-01: create → 3 join → all ready → start → каждый вводит уникальное слово → auto PLAYING → последовательные guesses → финал места 1–4 и очки 4–1.
2. Hidden target: до PLAYING `setup.target=null`, target id/name отсутствуют в `setup` и UI не содержит связи «автор → адресат»; roster остаётся видимым. После PLAYING имя адресата видно в подсказке.
3. Early finish: угадавшие сохраняют места/время/очки, остальные «Не угадал», 0, без места; cancel: назначения/слова исчезают, readiness сброшена, settings/host сохранены, повторный запуск работает.
4. Projection leakage: для каждого viewer и фазы получить реальные `/state`, HTML и RSC payload production server; сравнить body с фактическими секретными словами. До FINISHED собственный секрет отсутствует во всей полезной нагрузке; при hidden target `setup.target=null`, а HTML/RSC не содержит назначения автору его адресата; в PLAYING видны ровно чужие слова; после FINISHED все слова раскрыты.

- [ ] **Step 2: Verify RED**

Run: `bun run test:e2e -- --project=chromium src/test/e2e/full-cycle.e2e.ts src/test/e2e/hidden-target.e2e.ts src/test/e2e/finish-cancel.e2e.ts src/test/e2e/projection-leakage.e2e.ts`
Expected: FAIL из-за отсутствующих игровых экранов.

- [ ] **Step 3: Implement phase screens**

Word setup показывает разрешённое «Загадай слово {имени}» либо «Введи загаданное слово», собственное сохранённое значение, редактирование до PLAYING и ожидание по `hasSubmittedWord`. Playing без дополнительной навигации показывает все `Автор -> адресат: слово`, а собственную строку как `Автор -> вам: слово скрыто`; угадавший становится spectator. «Я угадал», early finish и cancel используют доступные confirmation dialogs и pending lock, но серверная идемпотентность остаётся обязательной.

Final использует карточки на 360 px: место/«Не угадал», имя, duration/прочерк, очки; ниже полный список назначений и слов. Состояния loading/error/reconnect отличимы, никаких секретов не добавлять в data-атрибуты, hidden DOM или client-side initial payload сверх разрешённого DTO.

- [ ] **Step 4: Verify GREEN, all gates and security refactor**

Run: `bun run test:e2e -- --project=chromium src/test/e2e/full-cycle.e2e.ts src/test/e2e/hidden-target.e2e.ts src/test/e2e/finish-cancel.e2e.ts src/test/e2e/projection-leakage.e2e.ts && bun run lint && bun run typecheck && bun test && bun run build`
Expected: все journeys и реальные JSON/HTML/RSC leakage checks PASS.

- [ ] **Step 5: Commit, security review and client-bundle refactor gate**

```bash
git add src/components src/test/e2e
git commit -m "feat: complete word chain game screens"
```

Reviewer дополнительно проверяет отсутствие Prisma/server-only импортов в client graph и отсутствие полного DTO, маскируемого в браузере. Повторный небольшой refactor устраняет дублирование mutation/pending/confirmation без смены контрактов.

### Task 13: Recovery, Acceptance Hardening and Documentation

**Files:**
- Create: `src/test/e2e/{recovery,permissions,limits,mobile}.e2e.ts`
- Modify: только выявленные ревью дефекты, `README.md`, `docs/development.md`, `docs/api.md`, `.env.example`

**Interfaces:**
- Consumes: весь предыдущий MVP.
- Produces: подтверждение AC-01…AC-10 и воспроизводимые команды запуска/проверки.

- [ ] **Step 1: Add remaining acceptance tests**

- Reload в LOBBY, ASSIGNING_WORDS, PLAYING, FINISHED сохраняет identity/phase/revision.
- Abort `/events` через Playwright route, пропустить mutation и восстановить stream: на reconnect клиент запрашивает state и показывает актуальную ревизию; разрыв не удаляет Player и не переносит host.
- Non-admin direct API settings/start/remove/finish/cancel получает 403 даже при подделанном client intent; caller playerId в body не принимается.
- Double-click и replay guessed, включая после FINISHED, не меняют результат/revision; concurrent guesses разных контекстов получают уникальные места; race guessed/finish соответствует commit order.
- 13-й join, join после start и duplicate NFKC/case name отклоняются; запуск при 2 или неготовом игроке недоступен.
- Chromium и WebKit, viewport 360 px: нет horizontal overflow, открытая клавиатура не скрывает активное поле/кнопку, видимый focus, диалоги keyboard-accessible, touch targets ≥44 px.
- Captured server logs не содержат уникальные слова, cookie, session password или database URL.

- [ ] **Step 2: Verify each new test initially exercises the requirement**

Run каждый новый suite отдельно против production server. Если сценарий уже работает, зафиксировать PASS как acceptance evidence; если обнаружен дефект, сначала получить воспроизводимый RED и только затем передать конкретный finding implementer. Не ослаблять assertions ради прохождения.

- [ ] **Step 3: Fix only confirmed gaps and synchronize docs**

Исправления выполняет coding agent с focused regression tests. README убирает статус «реализация не начата» и описывает реальный запуск. Development docs содержат Docker PostgreSQL для disposable tests, переменные, миграции, production E2E server, Bun commands и ограничение одного realtime-процесса. API docs отражают обязательный Origin, rate limits и финальные коды. Не менять игровые инварианты и не дублировать подробные правила.

- [ ] **Step 4: Run clean-database and complete verification**

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run build
bun run test:e2e
```

Дополнительно создать новую пустую `words_game_migration_test`, применить `bun run db:migrate` с её URL и повторно прогнать schema integration tests. Expected: все команды exit 0, Chromium+WebKit E2E PASS, чистая миграция PASS, git status не содержит порождённых reports/logs/cache вне ignore rules.

- [ ] **Step 5: Commit, whole-branch review and fix loop**

```bash
git add README.md docs .env.example src prisma package.json bun.lock playwright.config.ts
git commit -m "test: verify complete words game MVP"
```

Сформировать review package от merge-base `142e238` до HEAD. Назначить broad final reviewer и независимые read-only architecture/security/acceptance reviews. Все Critical/Important findings передать одному fix agent с covering test files; повторить review и полный набор проверок. Minor findings либо исправить без расширения scope, либо явно перечислить пользователю как оставшиеся ограничения.

## Verification Matrix

| Acceptance | Primary evidence |
| --- | --- |
| AC-01 полный цикл | Task 12 `full-cycle.e2e.ts`, четыре independent contexts |
| AC-02 собственное слово | Tasks 8/12 serialized DTO + реальные HTTP/HTML/RSC |
| AC-03 скрытие адресата | Tasks 8/12 `hidden-target` и leakage matrix |
| AC-04 готовность/права | Tasks 5/6 integration + Task 13 direct API |
| AC-05 повтор/гонки | Tasks 7/13 repeat/concurrent/race tests |
| AC-06 auto/early finish | Tasks 7/12 integration + browser journey |
| AC-07 cancel | Tasks 6/12 cleanup и restart |
| AC-08 восстановление | Tasks 10/13 reload и SSE missed-event reconnect |
| AC-09 ограничения входа | Tasks 5/13 full/name/state boundary tests |
| AC-10 расширяемость | Tasks 5/8/final architecture review: Core без game imports, registry-only binding |

## Assumptions

- В объём этого выполнения входит весь описанный MVP, а не только backend или первая страница; serverless deploy, второй тип игры, аккаунты, постоянный рейтинг и реальные физические устройства не входят.
- Утверждение плана подтверждает создание отдельной ветки/worktree и регулярные commits внутри неё. `main` не используется для реализации.
- Docker доступен. Для тестов используется одноразовый PostgreSQL container на `127.0.0.1:55432` с БД `words_game_test`, `words_game_e2e` и отдельной чистой migration DB; он никогда не подключается к development/production БД. Если container невозможно запустить, integration/E2E считаются заблокированными, а не пропущенными.
- Отсутствующий Origin у mutation отклоняется. Rate limits для single-process MVP: 30/min для create/join и 120/min для остальных mutations на `(route,IP)`; алгоритм in-memory fixed window с injected clock в тестах.
- Спецификация о скрытии адресата конфликтует с обязательным roster всех имён/ID. Принято согласованное с `docs/api.md` и `docs/development.md` толкование: до PLAYING скрывается сама связь и `setup.target`, а общий список участников остаётся видимым. При утверждении плана эта трактовка считается выбранной; Task 4 одновременно уточняет формулировку в источнике истины, не меняя сами правила.
- «Символы» имени/слова означают Unicode code points. Поведение NFKC и code-point длины фиксируется тестами и документацией.
- Production server остаётся одним долгоживущим Next.js Node-runtime процессом, запускаемым через Bun; фактическая команда и SSE streaming проверяются E2E. WebKit/Chromium mobile emulation является автоматической проверкой совместимости, не заменой тестированию на физических устройствах.
- Инструмент Agent не предоставляет явный выбор модели; используются свежие `coder` для реализации/исправлений и отдельные reviewers для каждого diff и финального branch review.
