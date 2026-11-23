import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { LlmClient } from "../ai/index";
import {
	addAnswers,
	beginSubmission,
	claimBrowserRuns,
	finishBrowserRun,
	getApplication,
	getPackage,
	heartbeatBrowserRun,
	prepareSubmitIntent,
	queuedBrowserRuns,
	type RunMode,
	reclaimBrowserRuns,
	recordBrowserRunEvents,
	startBrowserRun,
} from "../applications/index";
import type { BrowserRunner, PackagePort, RunEventSink, RunOutcome, SubmitGate } from "../browser/index";
import { buildCandidateContext } from "../candidate/index";
import type { Db } from "../db/index";
import type { UserId } from "../db/ownership";
import { type Adapters, readApplicationQuestions } from "../discovery/index";
import { answerQuestions } from "../generation/index";
import { heldUsers, liftHold, raiseHold } from "../holds/index";
import { getHunt } from "../hunts/index";
import { defineQueue, type Jobs } from "../jobs/index";
import { JournalUnavailable, journalUrl, type SubmitJournal } from "../journal/index";
import { getLaunchGate, type RecoveryMarker } from "../launch/index";
import type { Logger } from "../log/index";
import type { Storage } from "../storage/index";
import { isCanaryUser } from "../users/index";

// Pipeline step 6 (§5): `browser_run(application, mode)`. Priority-pull dispatch to the one
// browser, a worker-owned run with a ~15 s heartbeat, reclaim by the sweeper. A live run
// crosses the submit boundary through `SubmitGate` (§5, #22): the stable intent id, the
// create-only journal entry, then one transaction (recovery marker, launch gate, canary User,
// APPLYING → SUBMITTING, frozen Package revision, submit-intent row); only after its commit the
// final click. A journal that cannot be written raises a journal Hold and the run stays before
// the boundary; past it, nothing is retried. A run that fails before it is classified by the
// runner and recovered by the retry table (`finishBrowserRun`); aborts use no attempt.

/** The run's hard wall-clock limit (§10); tune on real Dry Runs (§21). */
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;
export const HEARTBEAT_MS = 15 * 1000;
/** A RUNNING run whose heartbeat is older than this is reclaimed. */
export const HEARTBEAT_EXPIRY_MS = 4 * HEARTBEAT_MS;
/** The worker runs one browser (§17). */
export const BROWSERS = 1;

/** Why a run stopped without failing: it uses no attempt. */
class ShutdownAbort extends Error {
	override name = "ShutdownAbort";
}

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
	/**
	 * Graceful shutdown (§5): no new run starts or is dispatched, runs before the boundary are
	 * aborted (no attempt used), and runs past it get `graceMs` to record their confirmation
	 * before they are ended, as Uncertain Submissions.
	 */
	stop(options: { graceMs: number }): Promise<void>;
};

/** A run this worker is executing, as graceful shutdown sees it. */
type ActiveRun = {
	shutdown: AbortController;
	/** The submit boundary being crossed now, if it is. */
	crossing: Promise<boolean> | null;
	crossed: boolean;
	done: Promise<void>;
};

export function createBrowserPipeline(deps: {
	db: Db;
	jobs: Jobs;
	llm: LlmClient;
	storage: Storage;
	adapters: Adapters;
	runner: BrowserRunner;
	/** The submit-intent journal; null when it is not configured, so live runs never cross. */
	journal: SubmitJournal | null;
	marker: RecoveryMarker;
	log: Logger;
	/** This worker process; a run another worker owned is reclaimed. */
	workerId?: string;
	timeoutMs?: number;
}): BrowserPipeline {
	const { db, jobs, llm, storage, adapters, runner, journal, marker, log } = deps;
	const workerId = deps.workerId ?? randomUUID();
	const timeoutMs = deps.timeoutMs ?? RUN_TIMEOUT_MS;
	let stopping = false;
	const active = new Map<string, ActiveRun>();

	async function dispatch() {
		if (stopping) return 0;
		// A restore in progress blocks dispatch whatever the database says (§13).
		if (await marker.present()) return 0;
		const held = await heldUsers(db, "contact_identity");
		const journalHeld = await heldUsers(db, "journal");
		const live = journal !== null && (await getLaunchGate(db)).open;
		const claimed = await db.transaction(async (tx) => {
			const picked = await claimBrowserRuns(tx, {
				browsers: BROWSERS,
				excludeUsers: held,
				live,
				excludeLiveUsers: journalHeld,
			});
			for (const { userId, browserRunId } of picked) {
				await jobs.send(browserRunQueue, { userId, browserRunId }, { tx });
			}
			return picked.length;
		});
		if (claimed > 0) log.info({ event: "browser_runs_dispatched", claimed });
		return claimed;
	}

	/**
	 * `SubmitGate` (§5, #22). True only once the boundary transaction has committed: the run may
	 * click submit, once. Every refusal leaves the run before the boundary, using no attempt.
	 */
	async function crossSubmitBoundary(
		userId: UserId,
		browserRunId: string,
		snapshot: { source: string; boardToken: string; nativeId: string; applyUrl: string },
		frozen: { files: { key: string; blob: string; filename: string }[]; fields: Parameters<SubmitGate["cross"]>[0] },
	): Promise<boolean> {
		// 1. The run's stable intent id, reused if it already has one.
		const intent = await prepareSubmitIntent(db, userId, browserRunId, workerId);
		if (!intent) return false;
		// 2. The create-only journal entry, confirmed before the transaction.
		try {
			if (!journal) throw new JournalUnavailable("the journal is not configured");
			await journal.write({
				intentId: intent.intentId,
				userId,
				applicationId: intent.applicationId,
				opportunityId: intent.opportunityId,
				browserRunId,
				posting: {
					source: snapshot.source,
					boardToken: snapshot.boardToken,
					nativeId: snapshot.nativeId,
					dedupKey: intent.dedupKey,
				},
				applyUrl: journalUrl(snapshot.applyUrl),
				mode: "live",
				at: new Date().toISOString(),
			});
		} catch (error) {
			if (!(error instanceof JournalUnavailable)) throw error;
			const raised = await db.transaction((tx) => raiseHold(tx, userId, "journal", "journal_write_failed"));
			log.warn({ event: "journal_write_failed", userId, browserRunId, raised });
			return false;
		}
		// 3. One transaction: the recovery marker, the launch gate and the canary User, then the boundary.
		const crossed = await db.transaction(async (tx) => {
			if (await marker.present()) return false;
			if (!(await getLaunchGate(tx)).open) return false;
			if (await isCanaryUser(tx, userId)) return false;
			return beginSubmission(tx, userId, { browserRunId, workerId, intentId: intent.intentId, ...frozen });
		});
		log.info({ event: crossed ? "submit_boundary_crossed" : "submit_boundary_refused", userId, browserRunId });
		// 4. The caller clicks only after this commit.
		return crossed;
	}

	async function runBrowser(userId: UserId, browserRunId: string) {
		// Shutting down: the run stays QUEUED and the next worker's sweeper nudges it.
		if (stopping) return;
		const started = await startBrowserRun(db, userId, browserRunId, workerId);
		if (!started) return;
		const run: ActiveRun = { shutdown: new AbortController(), crossing: null, crossed: false, done: Promise.resolve() };
		// Shutdown began while this run was being taken: it ends at once, before the boundary.
		if (stopping) run.shutdown.abort(new ShutdownAbort("the worker is shutting down"));
		run.done = execute(userId, browserRunId, started, run);
		active.set(browserRunId, run);
		try {
			await run.done;
		} finally {
			active.delete(browserRunId);
		}
		// The browser is free: the next run need not wait for the tick.
		await dispatch();
	}

	async function execute(
		userId: UserId,
		browserRunId: string,
		started: { applicationId: string; mode: RunMode },
		run: ActiveRun,
	) {
		const { applicationId } = started;
		const lost = new AbortController();
		const timedOut = AbortSignal.timeout(timeoutMs);
		const signal = AbortSignal.any([lost.signal, run.shutdown.signal, timedOut]);
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
			const snapshot = pkg.jobSnapshot;
			const gate: SubmitGate = {
				async cross(fields) {
					// Shutdown waits for a crossing in flight; one asked for after it began is refused.
					if (stopping || signal.aborted) return false;
					const files =
						resume && resumeBlob
							? fields
									.filter((f) => f.key === "resume" && f.ok)
									.map((f) => ({ key: f.key, blob: resumeBlob as string, filename: resume.filename }))
							: [];
					run.crossing = crossSubmitBoundary(userId, browserRunId, snapshot, { files, fields });
					run.crossed = await run.crossing;
					return run.crossed;
				},
			};
			outcome = await runner.run({
				url: snapshot.applyUrl,
				mode: started.mode,
				package: port,
				events,
				gate,
				signal,
				ai: {
					llm,
					attribution: {
						userId,
						huntId: hunt.id,
						applicationId,
						opportunityId: application.opportunityId,
						browserRunId,
					},
				},
			});
			// The wall-clock limit is the run's own failure; a shutdown or a lost run is not (§5).
			if (outcome.kind === "aborted" && timedOut.aborted && !run.shutdown.signal.aborted && !lost.signal.aborted) {
				outcome = {
					kind: "failed",
					category: "UNKNOWN",
					detail: "timed out",
					url: outcome.url,
					fields: outcome.fields,
				};
			}
		} catch (error) {
			log.error({ err: error, event: "browser_run_error", userId, browserRunId });
			outcome = run.shutdown.signal.aborted
				? { kind: "aborted", reason: "shutdown", url: null, fields: [] }
				: { kind: "failed", category: "UNKNOWN", detail: "error", url: null, fields: [] };
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
					: outcome.kind === "submitted"
						? { status: "SUBMITTED", checkpoint, confirmation: outcome.confirmation }
						: outcome.kind === "failed"
							? { status: "FAILED", checkpoint, failure: { category: outcome.category, detail: outcome.detail } }
							: outcome.kind === "submit_unknown"
								? { status: "FAILED", checkpoint, failure: { category: "UNKNOWN", detail: outcome.detail } }
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
			// A journal Hold lifts once the journal answers again (§5: lifted by a probe).
			const journalHeld = await heldUsers(db, "journal");
			if (journalHeld.length > 0 && journal && (await journal.check())) {
				for (const userId of journalHeld) await db.transaction((tx) => liftHold(tx, userId, "journal"));
				log.info({ event: "journal_hold_lifted", users: journalHeld.length });
			}
			return { reclaimed, nudged };
		},
		async stop({ graceMs }) {
			stopping = true;
			const runs = [...active.values()];
			await Promise.all(
				runs.map(async (run) => {
					await run.crossing?.catch(() => false);
					if (!run.crossed) run.shutdown.abort(new ShutdownAbort("the worker is shutting down"));
				}),
			);
			const grace = setTimeout(() => {
				for (const run of runs) run.shutdown.abort(new ShutdownAbort("the shutdown grace ran out"));
			}, graceMs);
			await Promise.allSettled(runs.map((run) => run.done));
			clearTimeout(grace);
		},
		async work() {
			await jobs.work(browserRunQueue, ({ userId, browserRunId }) => runBrowser(userId, browserRunId), {
				localConcurrency: BROWSERS,
			});
		},
	};
}
