import { createLlmClient, purgeExpiredPayloads } from "./packages/ai/index";
import { EXTRACT_DOCUMENT, extractDocument } from "./packages/candidate/index";
import { loadConfig } from "./packages/config/index";
import { createDatabase, trySessionLock } from "./packages/db/index";
import { createGreenhouseAdapter, createSourceHttp } from "./packages/discovery/index";
import { createJobs, WORKER_LOCK_KEY } from "./packages/jobs/index";
import { createLogger } from "./packages/log/index";
import {
	createApplicationPipeline,
	createDiscoveryPipeline,
	createMatchingPipeline,
	PIPELINE_QUEUES,
} from "./packages/pipeline/index";
import { createSecrets } from "./packages/secrets/index";
import { createStorage } from "./packages/storage/index";

// The `worker` process: hosts every pg-boss consumer and schedule (§3).
// Exactly one runs at a time, enforced by a Postgres advisory lock (§17).
const SHUTDOWN_GRACE_MS = 60_000;
const PAYLOAD_PURGE_MS = 60 * 60 * 1000;
/** How often due Boards are looked for; each Board itself is polled every ~2 h (§6). */
const DISCOVERY_TICK_MS = 60 * 1000;
/** The `prepare` dispatcher's tick; a new Application also nudges it at once (§5). */
const DISPATCH_TICK_MS = 30 * 1000;
/** The sweeper re-nudges automated states that have no live job (§5). */
const SWEEP_MS = 5 * 60 * 1000;

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

// Extraction (2), discover (2), ingest (4), evaluate (4) and decide (2) consumers share this pool with the ticks.
const database = createDatabase(config.databaseUrl, { max: 17 });
const secrets = createSecrets([{ version: 1, key: config.masterKey }]);
const storage = createStorage(config.dataDir);
const llm = createLlmClient({ db: database.db, secrets, log });

const jobs = createJobs({
	databaseUrl: config.databaseUrl,
	queues: [EXTRACT_DOCUMENT, ...PIPELINE_QUEUES],
	onError: (error) => log.error({ err: error, event: "jobs_error" }),
});
await jobs.start();
await jobs.work(
	EXTRACT_DOCUMENT,
	({ userId, documentId }) => extractDocument({ db: database.db, storage, llm, log }, userId, documentId),
	{ localConcurrency: 2 },
);

// One limiter shared by every User's polls, so each ATS host sees ~1 request/s (§6).
const sourceHttp = createSourceHttp();
const discovery = createDiscoveryPipeline({
	db: database.db,
	jobs,
	storage,
	adapters: { greenhouse: createGreenhouseAdapter(sourceHttp) },
	log,
});
await discovery.work();
await createMatchingPipeline({ db: database.db, jobs, llm, log }).work();
// `prepare` has no consumer until generation (#42): dispatched jobs wait, queued, in priority order.
const applications = createApplicationPipeline({ db: database.db, jobs, log });
await applications.work();
async function discoveryTick() {
	try {
		const sent = await discovery.tick();
		if (sent > 0) log.info({ event: "discovery_polls_queued", sent });
	} catch (error) {
		log.error({ err: error, event: "discovery_tick_failed" });
	}
}
void discoveryTick();
const discoveryTimer = setInterval(() => void discoveryTick(), DISCOVERY_TICK_MS);

async function dispatchTick() {
	try {
		await applications.dispatch();
	} catch (error) {
		log.error({ err: error, event: "dispatch_tick_failed" });
	}
}
void dispatchTick();
const dispatchTimer = setInterval(() => void dispatchTick(), DISPATCH_TICK_MS);
async function sweep() {
	try {
		const swept = await applications.sweep();
		if (Object.values(swept).some((n) => n > 0)) log.info({ event: "pipeline_swept", ...swept });
	} catch (error) {
		log.error({ err: error, event: "sweep_failed" });
	}
}
const sweepTimer = setInterval(() => void sweep(), SWEEP_MS);

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
	clearInterval(discoveryTimer);
	clearInterval(dispatchTimer);
	clearInterval(sweepTimer);
	await jobs.stop({ timeoutMs: SHUTDOWN_GRACE_MS });
	await database.close();
	await lock?.release();
	log.info({ event: "worker_stopped" });
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
