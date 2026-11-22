import "server-only";

// Стабильный путь импорта персональной проекции состояния. Связывание Core с
// реестром игр выполняется в composition root (src/server/games/registry.ts):
// каждый вызов getGameState строит DTO заново для одного viewer.
export { getGameState } from "./registry";
