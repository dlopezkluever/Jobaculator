import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./api/app";
import { loadConfig } from "./packages/config/index";
import { createDatabase } from "./packages/db/index";
import { createLogger } from "./packages/log/index";
import { createSecrets } from "./packages/secrets/index";
import { createUsers } from "./packages/users/index";

// The `web` process: Hono host for auth, the tRPC API and the SPA. Sends jobs, never consumes them (§3).
const config = loadConfig("web");
const log = createLogger({ level: config.logLevel });
const database = createDatabase(config.databaseUrl);
const secrets = createSecrets([{ version: 1, key: config.masterKey }]);
const users = createUsers({ db: database.db, origin: config.web.origin, secret: config.authSecret, log });

// `dist/web` beside the entry point: built by `pnpm build:web` in a checkout, shipped in the release.
const spaRoot = fileURLToPath(new URL("../dist/web", import.meta.url));
const app = createApp({ db: database.db, secrets, users, origin: config.web.origin, log, spaRoot });

const server = serve({ fetch: app.fetch, hostname: config.web.host, port: config.web.port }, (info) =>
	log.info({ event: "web_started", port: info.port }),
);

let stopping = false;
async function shutdown(signal: string) {
	if (stopping) return;
	stopping = true;
	log.info({ event: "web_stopping", signal });
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await database.close();
	log.info({ event: "web_stopped" });
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
