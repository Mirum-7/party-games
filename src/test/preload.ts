import { mock } from "bun:test";

import { getTestDatabaseUrl } from "./integration/database";

// Пакет server-only резолвится в падающий модуль вне серверного условия
// сборки react-server. В Bun-тестах этого условия нет, поэтому маркер
// подменяется пустым модулем. Защита в production-сборке Next.js при этом
// сохраняется полностью: preload применяется только к `bun test`.
mock.module("server-only", () => ({}));

// DATABASE_URL инициализируется из защищённого TEST_DATABASE_URL до загрузки
// серверных модулей: singleton prisma в src/server/db.ts создаётся при первом
// импорте. getTestDatabaseUrl бросает TEST_DATABASE_UNSAFE для не-тестовых БД,
// поэтому development/production БД в тестах не используются никогда.
process.env.DATABASE_URL = getTestDatabaseUrl();
