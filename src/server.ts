import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { loadConfig } from "./packages/config/index";
import { createDatabase } from "./packages/db/index";
import { createLogger } from "./packages/log/index";

// The `web` process: Hono host. Sends jobs, never consumes them (§3).
const config = loadConfig("web");
const log = createLogger({ level: config.logLevel });
const database = createDatabase(config.databaseUrl);

const app = new Hono();
app.get("/health", async (c) => {
	try {
		await database.db.execute(sql`select 1`);
		return c.json({ status: "ok" });
	} catch (error) {
		log.warn({ err: error, event: "health_db_unavailable" });
		return c.json({ status: "unavailable" }, 503);
	}
});

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
