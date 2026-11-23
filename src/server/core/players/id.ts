// Общий fail-closed guard формата id игрока: Prisma валидирует UUID на
// входе запроса, и malformed-значение без этой проверки бросит P2007 вместо
// доменной ошибки. Переиспользуется auth, персональной проекцией состояния
// и командами; модуль чистый, без зависимостей от БД/HTTP.
const PLAYER_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidPlayerId(value: string): boolean {
  return PLAYER_ID_PATTERN.test(value);
}
