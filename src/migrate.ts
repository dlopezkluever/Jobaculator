import { fileURLToPath } from "node:url";
import { loadConfig } from "./packages/config/index";
import { migrateDatabase } from "./packages/db/index";
import { createLogger } from "./packages/log/index";

// Runs as the `migrator` role. In the release, dist/migrate.js sits next to drizzle/.
const config = loadConfig("migrator");
const log = createLogger({ level: config.logLevel });
await migrateDatabase(config.databaseUrl, fileURLToPath(new URL("../drizzle", import.meta.url)));
log.info({ event: "migrations_applied" });
