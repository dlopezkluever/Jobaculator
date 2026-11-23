import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { LlmClient } from "../ai/index";
import {
	addAnswers,
	claimBrowserRuns,
	finishBrowserRun,
	getApplication,
	getPackage,
	heartbeatBrowserRun,
	queuedBrowserRuns,
	reclaimBrowserRuns,
	recordBrowserRunEvents,
	startBrowserRun,
} from "../applications/index";
import type { BrowserRunner, PackagePort, RunEventSink, RunOutcome } from "../browser/index";
import { buildCandidateContext } from "../candidate/index";
import type { Db } from "../db/index";
import type { UserId } from "../db/ownership";
import { type Adapters, readApplicationQuestions } from "../discovery/index";
import { answerQuestions } from "../generation/index";
import { heldUsers } from "../holds/index";
import { getHunt } from "../hunts/index";
import { defineQueue, type Jobs } from "../jobs/index";
import type { Logger } from "../log/index";
import type { Storage } from "../storage/index";

// Pipeline step 6 (§5): `browser_run(application, mode)`. Priority-pull dispatch to the one
// browser, a worker-owned run with a ~15 s heartbeat, reclaim by the sweeper. Dry Run only
// until SubmitGate lands (TB1-14).

/** The run's hard wall-clock limit (§10); tune on real Dry Runs (§21). */
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;
export const HEARTBEAT_MS = 15 * 1000;
/** A RUNNING run whose heartbeat is older than this is reclaimed. */
export const HEARTBEAT_EXPIRY_MS = 4 * HEARTBEAT_MS;
/** The worker runs one browser (§17). */
export const BROWSERS = 1;

/**
 * One Browser Run. Never retried by pg-boss (ADR 0004: no automatic engine retries); its
 * expiry is longer than the run's hard timeout (§5). The sweeper re-nudges a lost job.
 */
export const browserRunQueue = defineQueue(
	"browser_run",
	{ browserRunId: z.uuid() },
	{ retryLimit: 0, expireInSeconds: RUN_TIMEOUT_MS / 1000 + 300 },
);

export type BrowserPipeline = {
	/** One dispatcher tick: claims free browsers in priority order and enqueues their runs. */
	dispatch(): Promise<number>;
	runBrowser(userId: UserId, browserRunId: string): Promise<void>;
	/** Reclaims runs whose worker ended or heartbeat expired, and re-nudges QUEUED runs without a job. */
	sweep(): Promise<{ reclaimed: number; nudged: number }>;
	/** Registers the `browser_run` consumer. */
	work(): Promise<void>;
};

export function createBrowserPipeline(deps: {
	db: Db;
	jobs: Jobs;
	llm: LlmClient;
	storage: Storage;
	adapters: Adapters;
	runner: BrowserRunner;
	log: Logger;
	/** This worker process; a run another worker owned is reclaimed. */
	workerId?: string;
	timeoutMs?: number;
}): BrowserPipeline {
	const { db, jobs, llm, storage, adapters, runner, log } = deps;
	const workerId = deps.workerId ?? randomUUID();
	const timeoutMs = deps.timeoutMs ?? RUN_TIMEOUT_MS;

	async function dispatch() {
		const held = await heldUsers(db, "contact_identity");
		const claimed = await db.transaction(async (tx) => {
			const picked = await claimBrowserRuns(tx, { browsers: BROWSERS, excludeUsers: held });
			for (const { userId, browserRunId } of picked) {
				await jobs.send(browserRunQueue, { userId, browserRunId }, { tx });
			}
			return picked.length;
		});
		if (claimed > 0) log.info({ event: "browser_runs_dispatched", claimed });
		return claimed;
	}

	async function runBrowser(userId: UserId, browserRunId: string) {
		const started = await startBrowserRun(db, userId, browserRunId, workerId);
		if (!started) return;
		const { applicationId } = started;
		const lost = new AbortController();
		const signal = AbortSignal.any([lost.signal, AbortSignal.timeout(timeoutMs)]);
		const heartbeat = setInterval(() => {
			heartbeatBrowserRun(db, userId, browserRunId, workerId)
				.then((ours) => {
					if (!ours) lost.abort(new Error("the run was reclaimed"));
				})
				.catch(() => {});
		}, HEARTBEAT_MS);
		const workdir = await mkdtemp(join(tmpdir(), "browser-run-"));
		let outcome: RunOutcome | null = null;
		let resumeBlob: string | null = null;
		try {
			const application = await getApplication(db, userId, applicationId);
			const pkg = await getPackage(db, userId, applicationId);
			const hunt = application && (await getHunt(db, userId, application.drivingHuntId));
			if (!application || !pkg?.strategy || !pkg.answers || !hunt) throw new Error("the Package is incomplete");
			const strategy = pkg.strategy;
			const schema = (await readApplicationQuestions(adapters, pkg.jobSnapshot)) ?? [];

			// Uploads carry the name the employer sees, not the blob's hash (§13).
			let resume: PackagePort["documents"]["resume"] = null;
			if (pkg.resumePdf) {
				const name = pkg.resume?.identity.name.replace(/[^\p{L}\p{N} .-]+/gu, "").trim() || "Resume";
				const path = join(workdir, `${name} Resume.pdf`);
				await copyFile(storage.openLocalPath(pkg.resumePdf), path);
				resume = { path, filename: `${name} Resume.pdf` };
				resumeBlob = pkg.resumePdf;
			}

			const events: RunEventSink = {
				async record(event) {
					await recordBrowserRunEvents(db, userId, browserRunId, workerId, [event]);
				},
				evidence: (_label, png) => storage.put(db, png, { mediaType: "image/png", retentionClass: "case_evidence" }),
			};
			const port: PackagePort = {
				schema,
				answers: pkg.answers,
				documents: { resume, coverLetter: null },
				// Mid-run generation (§9) on the run's attribution; saved onto the Package.
				async generateMissing(questions) {
					const answered = await answerQuestions(llm, {
						context: await buildCandidateContext(db, userId, {
							drivingHuntId: hunt.id,
							opportunityId: application.opportunityId,
						}),
						snapshot: pkg.jobSnapshot,
						latitude: hunt.creativeLatitude,
						strategy,
						hunt: { id: hunt.id, locations: hunt.criteria.locations, payFloor: hunt.criteria.payFloor },
						questions,
						attribution: {
							userId,
							huntId: hunt.id,
							applicationId,
							opportunityId: application.opportunityId,
							browserRunId,
						},
					});
					await db.transaction((tx) =>
						addAnswers(tx, userId, applicationId, {
							browserRunId,
							callId: answered.callId,
							answers: answered.answers,
						}),
					);
					return answered.answers;
				},
			};
			outcome = await runner.run({ url: pkg.jobSnapshot.applyUrl, mode: started.mode, package: port, events, signal });
		} catch (error) {
			log.error({ err: error, event: "browser_run_error", userId, browserRunId });
			outcome = { kind: "failed", category: "UNKNOWN", detail: "error", url: null, fields: [] };
		} finally {
			clearInterval(heartbeat);
			await rm(workdir, { recursive: true, force: true });
		}

		const uploads = resumeBlob
			? outcome.fields
					.filter((f) => f.key === "resume" && f.ok)
					.map((f) => ({ key: f.key, blob: resumeBlob as string }))
			: [];
		const checkpoint = { url: outcome.url, fields: outcome.fields, uploads };
		const ended = await db.transaction((tx) =>
			finishBrowserRun(
				tx,
				userId,
				browserRunId,
				workerId,
				outcome.kind === "dry_run_complete"
					? { status: "COMPLETED", checkpoint }
					: outcome.kind === "failed"
						? { status: "FAILED", checkpoint, failure: { category: outcome.category, detail: outcome.detail } }
						: { status: "ABORTED", checkpoint },
			),
		);
		log.info({
			event: "browser_run_finished",
			userId,
			browserRunId,
			applicationId,
			outcome: outcome.kind,
			category: outcome.kind === "failed" ? outcome.category : null,
			recorded: ended,
		});
		// The browser is free: the next run need not wait for the tick.
		await dispatch();
	}

	return {
		dispatch,
		runBrowser,
		async sweep() {
			const reclaimed = await reclaimBrowserRuns(db, {
				workerId,
				heartbeatBefore: new Date(Date.now() - HEARTBEAT_EXPIRY_MS),
			});
			const live = new Set((await jobs.live(browserRunQueue)).map((job) => job.browserRunId));
			let nudged = 0;
			for (const { userId, browserRunId } of await queuedBrowserRuns(db)) {
				if (live.has(browserRunId)) continue;
				await jobs.send(browserRunQueue, { userId, browserRunId });
				nudged++;
			}
			return { reclaimed, nudged };
		},
		async work() {
			await jobs.work(browserRunQueue, ({ userId, browserRunId }) => runBrowser(userId, browserRunId), {
				localConcurrency: BROWSERS,
			});
		},
	};
}
