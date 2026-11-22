// Side-effect module: импортировать первым в integration-тестах, которые идут
// через серверный singleton prisma из src/server/db.ts. Подменяет DATABASE_URL
// на разрешённую тестовую БД до того, как db.ts создаст клиент.
import { getTestDatabaseUrl } from "./database";

process.env.DATABASE_URL = getTestDatabaseUrl();
