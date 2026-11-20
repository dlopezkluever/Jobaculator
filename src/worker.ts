import { loadConfig } from "./packages/config/index";
import { trySessionLock } from "./packages/db/index";
import { createJobs } from "./packages/jobs/index";
import { createLogger } from "./packages/log/index";

// The `worker` process: hosts every pg-boss consumer and schedule (§3).
// Exactly one runs at a time, enforced by a Postgres advisory lock (§17).
const WORKER_LOCK_KEY = 0x4a4f42574b52n; // "JOBWKR"
const SHUTDOWN_GRACE_MS = 60_000;

const config = loadConfig("worker");
const log = createLogger({ level: config.logLevel });

const lock = await trySessionLock(config.databaseUrl, WORKER_LOCK_KEY, (error) => {
	log.fatal({ err: error, event: "worker_lock_lost" });
	process.exit(1);
});
if (!lock) {
	log.error({ event: "worker_already_running" });
	process.exit(1);
}

const jobs = createJobs({
	databaseUrl: config.databaseUrl,
	queues: [],
	onError: (error) => log.error({ err: error, event: "jobs_error" }),
});
await jobs.start();
// Consumers are registered here as later tickets add queues.
log.info({ event: "worker_started" });

let stopping = false;
async function shutdown(signal: string) {
	if (stopping) return;
	stopping = true;
	log.info({ event: "worker_stopping", signal });
	await jobs.stop({ timeoutMs: SHUTDOWN_GRACE_MS });
	await lock?.release();
	log.info({ event: "worker_stopped" });
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
