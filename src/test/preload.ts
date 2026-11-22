import { mock } from "bun:test";

// Пакет server-only резолвится в падающий модуль вне серверного условия
// сборки react-server. В Bun-тестах этого условия нет, поэтому маркер
// подменяется пустым модулем. Защита в production-сборке Next.js при этом
// сохраняется полностью: preload применяется только к `bun test`.
mock.module("server-only", () => ({}));
