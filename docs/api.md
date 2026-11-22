# HTTP API и SSE

Этот документ — источник истины по контрактам `/api/v1`. Игровые правила находятся в [спецификации](superpowers/specs/2026-11-22-words-game-design.md), транзакции — в [модели данных](data-model.md).

## 1. Общие правила

- Base URL внутри приложения: `/api/v1`.
- Код в path нечувствителен к регистру при входе и нормализуется к верхнему регистру.
- Mutation с телом принимает только `application/json`; тело валидируется Zod, неизвестные поля отклоняются.
- Mutation без тела не принимает содержимое.
- Все mutation проверяют заголовок `Origin`: заголовок обязателен и должен точно совпадать с доверенным `APP_ORIGIN`; отсутствие или несовпадение → 400 `ORIGIN_REJECTED`.
- Rate limiting in-memory с фиксированным окном 60 секунд, ключ `(маршрут, IP)`: создание и вход (`POST /games`, `POST /games/{code}/join`) — 30 запросов в минуту, остальные mutation — 120 запросов в минуту; превышение → 429 `RATE_LIMITED`.
- IP клиента берётся из первого адреса `X-Forwarded-For` только при явном `TRUST_PROXY=true`; иначе заголовок игнорируется и используется стабильный локальный fallback. Доверенный reverse proxy обязан перезаписывать `X-Forwarded-For`, иначе лимиты можно обходить подделанным заголовком.
- Ответы состояния и ошибки имеют `Cache-Control: no-store`.
- Успешная команда, кроме выхода, возвращает актуальный `GameStateResponse` вызывающего игрока.
- Успешное создание и вход устанавливают cookie `wg_session`; выход удаляет её.
- Клиент никогда не передаёт `playerId` вызывающего: личность берётся из cookie.
- Права и допустимость команды проверяются сервером независимо от `capabilities` в DTO.

## 2. Маршруты

| Метод и путь | Доступ / фаза | Тело | Успех |
| --- | --- | --- | --- |
| `POST /games` | Публично | `CreateGameRequest` | 201, state + cookie |
| `POST /games/{code}/join` | Публично; новый игрок только в `LOBBY` | `JoinGameRequest` | 200, state + cookie |
| `GET /games/{code}/state` | Участник, любая фаза | Нет | 200, state |
| `GET /games/{code}/events` | Участник, любая фаза | Нет | 200, SSE |
| `PATCH /games/{code}/settings` | Админ, `LOBBY` | `UpdateSettingsRequest` | 200, state |
| `POST /games/{code}/readiness` | Участник, `LOBBY` | `ReadinessRequest` | 200, state |
| `POST /games/{code}/start` | Админ, `LOBBY` | Нет | 200, state |
| `PUT /games/{code}/word` | Участник, `ASSIGNING_WORDS` | `SubmitWordRequest` | 200, state |
| `POST /games/{code}/guessed` | Участник; новый результат только в `PLAYING` | Нет | 200, state |
| `POST /games/{code}/finish` | Админ, `PLAYING` | Нет | 200, state |
| `POST /games/{code}/cancel` | Админ, `ASSIGNING_WORDS` | Нет | 200, state |
| `DELETE /games/{code}/players/{playerId}` | Админ, `LOBBY` | Нет | 200, state админа |
| `POST /games/{code}/leave` | Участник, `LOBBY` | Нет | 204, cookie удалена |

Отдельного endpoint для переподключения нет: `GET /state` восстанавливает состояние по существующей cookie.

## 3. Запросы

```ts
type CreateGameRequest = {
  name: string;
  gameType?: "WORD_CHAIN"; // по умолчанию WORD_CHAIN
};

type JoinGameRequest = {
  name: string;
};

type UpdateSettingsRequest = {
  hideTargetNamesDuringSetup: boolean;
};

type ReadinessRequest = {
  ready: boolean;
};

type SubmitWordRequest = {
  word: string;
};
```

`PUT /word` выполняет upsert собственного слова и допускает редактирование до `PLAYING`. Повтор того же нормализованного значения возвращает 200 без увеличения ревизии.

`POST /guessed` идемпотентен: если результат с местом уже существует, возвращается 200 и текущее состояние без изменений, в том числе после автоматического перехода к `FINISHED`. Если результата ещё нет, новый результат создаётся только в `PLAYING`.

Остальные команды в неподходящей фазе возвращают `409 INVALID_GAME_STATE`. Запуск при неготовых или недостаточном числе игроков использует более конкретные коды из раздела ошибок.

## 4. Персональный DTO состояния

### Типы

```ts
type GamePhase = "LOBBY" | "ASSIGNING_WORDS" | "PLAYING" | "FINISHED";

type PlayerSummary = {
  id: string;
  name: string;
  isHost: boolean;
  isReady: boolean;
  hasSubmittedWord: boolean;
  hasGuessed: boolean;
};

type PlayerRef = {
  id: string;
  name: string;
};

type SetupState = {
  target: PlayerRef | null;
  targetHidden: boolean;
  word: string | null;
};

type HintItem = {
  assignmentId: string;
  author: PlayerRef;
  target: PlayerRef;
  word: string | null;
  wordHidden: boolean;
};

type ResultItem = {
  playerId: string;
  name: string;
  place: number | null;
  score: number;
  durationMs: number | null;
};

type Capabilities = {
  canEditSettings: boolean;
  canManagePlayers: boolean;
  canStart: boolean;
  canSubmitWord: boolean;
  canMarkGuessed: boolean;
  canFinish: boolean;
  canCancel: boolean;
  canLeave: boolean;
};

type GameStateResponse = {
  game: {
    code: string;
    type: "WORD_CHAIN";
    phase: GamePhase;
    revision: number;
    minPlayers: 3;
    maxPlayers: 12;
    settings: {
      hideTargetNamesDuringSetup: boolean;
    };
    startedAt: string | null;
    playingStartedAt: string | null;
    finishedAt: string | null;
  };
  viewer: {
    playerId: string;
  };
  players: PlayerSummary[];
  setup: SetupState | null;
  hints: HintItem[] | null;
  results: ResultItem[] | null;
  capabilities: Capabilities;
};
```

`players` сортируется по `(joinedAt, id)`. Флаги `hasSubmittedWord` раскрывают только факт готовности слова, не его значение. `hasGuessed` отражает наличие результата с местом.

### Правила проекции по фазам

| Поле | LOBBY | ASSIGNING_WORDS | PLAYING | FINISHED |
| --- | --- | --- | --- | --- |
| `setup` | null | Собственное назначение | null | null |
| `hints` | null | null | Все назначения, собственное слово скрыто | Все назначения и слова |
| `results` | null | null | null | Полный отсортированный рейтинг |

### `setup`

- Если `hideTargetNamesDuringSetup = false`: `target` содержит `id` и `name`, `targetHidden = false`.
- Если настройка включена: `target = null`, `targetHidden = true`. Идентификатор адресата нельзя добавлять в другое поле.
- `word` — слово, которое ввёл сам вызывающий автор, либо null.
- Чужие `setup` никогда не включаются.

### `hints` в `PLAYING`

Для назначения, где `target.id != viewer.playerId`:

```json
{
  "assignmentId": "uuid",
  "author": { "id": "uuid", "name": "Петя" },
  "target": { "id": "uuid", "name": "Маша" },
  "word": "самолёт",
  "wordHidden": false
}
```

Для назначения, где адресат — вызывающий игрок:

```json
{
  "assignmentId": "uuid",
  "author": { "id": "uuid", "name": "Петя" },
  "target": { "id": "uuid", "name": "Маша" },
  "word": null,
  "wordHidden": true
}
```

В `PLAYING` `wordHidden = true` только для собственного слова зрителя. В `FINISHED` все `word` заполнены, `wordHidden = false`.

### `results`

Сначала результаты с `place` по возрастанию, затем не угадавшие по `(normalizedName, id)`. `durationMs` вычисляется сервером как `GameResult.finishedAt - playingStartedAt`; для не угадавшего равно null.

`capabilities` отражает текущие права и фазу. `canStart = true` только если вызывающий — админ, 3–12 игроков и все готовы. Клиент может использовать флаги для UI, но сервер повторяет все проверки.

## 5. SSE-протокол

### Подключение

`GET /api/v1/games/{code}/events` использует обычную cookie через `EventSource`. До открытия потока сервер проверяет участника.

Заголовки:

```text
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

### Событие

При подписке отправляется текущая ревизия, затем при каждом фактическом изменении:

```text
id: 7
event: game.changed
data: {"revision":7}
```

Каждые 15 секунд отправляется heartbeat:

```text
: ping
```

Начальная директива реконнекта:

```text
retry: 3000
```

В событиях запрещены имена, назначения, слова, результаты и любые персональные поля.

### Клиентский алгоритм

1. Хранить `lastRevision` из последнего применённого `GameStateResponse`.
2. При `open`, включая автоматический reconnect, запросить `/state`.
3. При `game.changed` запросить `/state`, если полученная ревизия больше `lastRevision`.
4. После собственной mutation применить возвращённое состояние сразу.
5. Не допускать гонку запросов состояния: отменять предыдущий запрос либо отбрасывать DTO с ревизией ниже уже применённой.
6. При разрыве показать состояние «Переподключение»; не считать игрока вышедшим.
7. Ревизия никогда не уменьшается, в том числе после отмены попытки.

SSE не используется для команд и не заменяет персональный GET.

## 6. Ошибки

Единый формат:

```json
{
  "error": {
    "code": "NAME_TAKEN",
    "message": "Это имя уже занято в комнате",
    "fieldErrors": {
      "name": ["Выберите другое имя"]
    }
  }
}
```

`fieldErrors` необязательно. `message` предназначено для пользователя, `code` — для программной обработки. Внутренние детали и stack trace не возвращаются. При `INTERNAL_ERROR` correlation ID передаётся в `error.correlationId`; в служебном логе фиксируются correlation ID и тип ошибки, а исходное сообщение и stack trace не логируются — они могут содержать слова, cookie или секреты.

| HTTP | Код | Ситуация |
| ---: | --- | --- |
| 400 | `VALIDATION_ERROR` | Некорректные имя, слово, код, JSON или поля |
| 400 | `ORIGIN_REJECTED` | Недоверенный Origin для mutation |
| 401 | `UNAUTHENTICATED` | Cookie отсутствует, повреждена, истекла или игрок удалён |
| 403 | `FORBIDDEN` | Не участник комнаты или недостаточно прав |
| 404 | `GAME_NOT_FOUND` | Комната не найдена |
| 404 | `PLAYER_NOT_FOUND` | Удаляемый участник не найден в комнате |
| 409 | `GAME_FULL` | В комнате уже 12 игроков |
| 409 | `NAME_TAKEN` | Нормализованное имя занято |
| 409 | `INVALID_GAME_STATE` | Действие недопустимо в текущей фазе |
| 409 | `NOT_ENOUGH_PLAYERS` | Меньше трёх участников при запуске |
| 409 | `NOT_ALL_READY` | Есть неготовые участники при запуске |
| 429 | `RATE_LIMITED` | Превышен лимит запросов |
| 500 | `INTERNAL_ERROR` | Непредвиденная ошибка; дополнительно передаётся correlation ID |

Если SSE-проверка доступа завершилась ошибкой до открытия потока, используется обычный JSON-ответ. После открытия потока нельзя менять HTTP-статус; ошибка соединения обрабатывается reconnect и `/state`.

## 7. Кэширование и безопасность ответов

- Нельзя использовать публичный кеш, общий React cache между пользователями или общий DTO комнаты со всеми словами.
- Нельзя полагаться на скрытие кнопки, CSS, `visibility` или удаление поля на клиенте.
- Server Components должны получать только персональный DTO текущего игрока.
- Служебные логи не содержат тело `/word` и значение cookie.
