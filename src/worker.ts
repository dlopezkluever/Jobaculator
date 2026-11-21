import { createLlmClient, purgeExpiredPayloads } from "./packages/ai/index";
import { EXTRACT_DOCUMENT, extractDocument } from "./packages/candidate/index";
import { loadConfig } from "./packages/config/index";
import { createDatabase, trySessionLock } from "./packages/db/index";
import { createJobs, WORKER_LOCK_KEY } from "./packages/jobs/index";
import { createLogger } from "./packages/log/index";
import { createSecrets } from "./packages/secrets/index";
import { createStorage } from "./packages/storage/index";

// The `worker` process: hosts every pg-boss consumer and schedule (§3).
// Exactly one runs at a time, enforced by a Postgres advisory lock (§17).
const SHUTDOWN_GRACE_MS = 60_000;
const PAYLOAD_PURGE_MS = 60 * 60 * 1000;

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

const database = createDatabase(config.databaseUrl, { max: 4 });
const secrets = createSecrets([{ version: 1, key: config.masterKey }]);
const storage = createStorage(config.dataDir);
const llm = createLlmClient({ db: database.db, secrets, log });

const jobs = createJobs({
	databaseUrl: config.databaseUrl,
	queues: [EXTRACT_DOCUMENT],
	onError: (error) => log.error({ err: error, event: "jobs_error" }),
});
await jobs.start();
await jobs.work(
	EXTRACT_DOCUMENT,
	({ userId, documentId }) => extractDocument({ db: database.db, storage, llm, log }, userId, documentId),
	{ localConcurrency: 2 },
);

// AI prompts and outputs are kept 14 days (§12); the ledger rows stay.
async function purgePayloads() {
	try {
		const removed = await purgeExpiredPayloads(database.db);
		if (removed > 0) log.info({ event: "ai_payloads_purged", removed });
	} catch (error) {
		log.error({ err: error, event: "ai_payload_purge_failed" });
	}
}
void purgePayloads();
const purgeTimer = setInterval(() => void purgePayloads(), PAYLOAD_PURGE_MS);
log.info({ event: "worker_started" });

let stopping = false;
async function shutdown(signal: string) {
	if (stopping) return;
	stopping = true;
	log.info({ event: "worker_stopping", signal });
	clearInterval(purgeTimer);
	await jobs.stop({ timeoutMs: SHUTDOWN_GRACE_MS });
	await database.close();
	await lock?.release();
	log.info({ event: "worker_stopped" });
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
