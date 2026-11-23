import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor, Tx } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { opportunity } from "../../discovery/tables";
import { appendEvent, defineEvent } from "../../events/index";
import type { SubmissionMode } from "../../hunts/criteria";
import { hunt } from "../../hunts/tables";
import { assertLiveAllowed } from "../../launch/index";
import type { BlobHash } from "../../storage/index";
import { user } from "../../users/tables";
import { transition } from "./lifecycle";
import { application, browserRun, submissionSettings, submitIntent } from "./schema";
import { confirmSubmission, markUncertain } from "./submit";
import {
	APPLICATION_SUBJECT,
	BROWSER_RUN_STATUSES,
	type BrowserRunStatus,
	type Confirmation,
	FAILURE_CATEGORIES,
	RUN_MODES,
	type RunCheckpoint,
	type RunEvent,
	type RunFailure,
	type RunMode,
	type StoredRunEvent,
} from "./types";
import { valueTier } from "./value";

// Browser Runs (§5, §10, #12, #17): the priority-pull claim, ownership by one worker with a
// heartbeat, compact events and evidence refs, and how a run's end moves the Application.

export const browserRunQueued = defineEvent({
	code: "browser_run_queued",
	subject: APPLICATION_SUBJECT,
	payload: z.object({ browserRunId: z.uuid(), mode: z.enum(RUN_MODES), requested: z.boolean() }),
});
export const browserRunFinished = defineEvent({
	code: "browser_run_finished",
	subject: APPLICATION_SUBJECT,
	payload: z.object({
		browserRunId: z.uuid(),
		mode: z.enum(RUN_MODES),
		status: z.enum(BROWSER_RUN_STATUSES),
		category: z.enum(FAILURE_CATEGORIES).nullable(),
	}),
});

/** A request the lifecycle or the launch gate does not allow; the message names the rule. */
export class RunRefused extends Error {
	override name = "RunRefused";
}

// ——— Submission mode (§5) ———

/** The owner's global submission mode; Dry Run until set. */
export async function getSubmissionMode(exec: Executor, owner: UserId): Promise<SubmissionMode> {
	const [row] = await exec
		.select({ mode: submissionSettings.mode })
		.from(submissionSettings)
		.where(eq(submissionSettings.userId, owner));
	return row?.mode ?? "DRY_RUN";
}

/** Sets the global submission mode. Live throws `LiveRefused` until the launch gate is recorded (§17). */
export async function setSubmissionMode(exec: Executor, owner: UserId, mode: SubmissionMode): Promise<void> {
	if (mode === "LIVE") await assertLiveAllowed(exec);
	await exec
		.insert(submissionSettings)
		.values({ userId: owner, mode })
		.onConflictDoUpdate({ target: submissionSettings.userId, set: { mode, updatedAt: new Date() } });
}

/**
 * The Candidate's explicit choice to Dry Run a READY Application again (§5): the dispatcher
 * picks it up even though a Dry Run already finished. Throws `RunRefused` when it is not READY.
 */
export async function requestDryRun(exec: Executor, owner: UserId, applicationId: string): Promise<void> {
	const [requested] = await exec
		.update(application)
		.set({ requestedMode: "DRY_RUN", updatedAt: new Date() })
		.where(and(eq(application.id, applicationId), eq(application.userId, owner), eq(application.status, "READY")))
		.returning({ id: application.id });
	if (!requested) throw new RunRefused("Only a ready Application can be Dry Run again");
}

// ——— Dispatch ———

const ACTIVE: BrowserRunStatus[] = ["QUEUED", "RUNNING"];
/** A Dry Run that ended on its own; a reclaimed or aborted one does not count. */
const FINISHED: BrowserRunStatus[] = ["COMPLETED", "FAILED"];

/**
 * The priority-pull dispatcher's claim for Browser Runs (§5): up to the free browsers, READY
 * Applications move to APPLYING with a QUEUED run each, explicit Candidate requests first,
 * then in Opportunity Value order. Effective mode = the Candidate's request > the Driving
 * Hunt's > the global setting. A Dry Run that finished leaves the Application READY and it
 * is not claimed again while its mode stays dry, unless the Candidate asks. A live run that
 * failed is not claimed again by itself (automatic retries are TB1-15's). Skips Users in
 * `excludeUsers` (under a Hold) and closed postings. Enqueue `browser_run` in the same transaction.
 */
export async function claimBrowserRuns(
	tx: Tx,
	options: {
		browsers: number;
		excludeUsers?: readonly UserId[];
		/** Whether live runs may be dispatched: the launch gate is open and no recovery is in progress. */
		live?: boolean;
		/** Users whose live runs wait (a journal Hold); their Dry Runs still run. */
		excludeLiveUsers?: readonly UserId[];
		now?: Date;
	},
): Promise<{ userId: UserId; applicationId: string; browserRunId: string }[]> {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('applications:dispatch-browser', 0))`);
	const [busy] = await tx.select({ n: count() }).from(browserRun).where(inArray(browserRun.status, ACTIVE));
	const capacity = options.browsers - (busy?.n ?? 0);
	if (capacity <= 0) return [];

	const now = options.now ?? new Date();
	const effective = sql`coalesce(${application.requestedMode}, ${hunt.submissionMode}, ${submissionSettings.mode}, 'DRY_RUN')`;
	const finishedDryRun = sql`exists (select 1 from ${browserRun} where ${browserRun.applicationId} = ${application.id}
		and ${browserRun.userId} = ${application.userId} and ${browserRun.mode} = 'dry'
		and ${browserRun.status} in (${sql.join(
			FINISHED.map((s) => sql`${s}`),
			sql`, `,
		)}))`;
	const failedLiveRun = sql`exists (select 1 from ${browserRun} where ${browserRun.applicationId} = ${application.id}
		and ${browserRun.userId} = ${application.userId} and ${browserRun.mode} = 'live' and ${browserRun.status} = 'FAILED')`;
	const excluded = options.excludeUsers ?? [];
	const picked = await tx
		.select({
			id: application.id,
			userId: application.userId,
			requested: application.requestedMode,
			effective: sql<SubmissionMode>`${effective}`,
		})
		.from(application)
		.innerJoin(
			opportunity,
			and(eq(opportunity.id, application.opportunityId), eq(opportunity.userId, application.userId)),
		)
		.innerJoin(hunt, and(eq(hunt.id, application.drivingHuntId), eq(hunt.userId, application.userId)))
		.leftJoin(submissionSettings, eq(submissionSettings.userId, application.userId))
		.where(
			and(
				eq(application.status, "READY"),
				eq(opportunity.status, "OPEN"),
				or(
					and(sql`${effective} = 'DRY_RUN'`, or(isNotNull(application.requestedMode), sql`not ${finishedDryRun}`)),
					options.live
						? and(
								sql`${effective} = 'LIVE'`,
								sql`not ${failedLiveRun}`,
								// The canary User is never submitted for (§18).
								sql`not exists (select 1 from ${user} where ${user.id} = ${application.userId} and ${user.canary})`,
								(options.excludeLiveUsers ?? []).length > 0
									? notInArray(application.userId, [...(options.excludeLiveUsers ?? [])])
									: undefined,
							)
						: undefined,
				),
				excluded.length > 0 ? notInArray(application.userId, [...excluded]) : undefined,
			),
		)
		.orderBy(
			sql`${application.requestedMode} is null`,
			valueTier(now),
			desc(application.fit),
			asc(application.createdAt),
			asc(application.id),
		)
		.limit(capacity)
		.for("update", { of: application, skipLocked: true });

	const claimed: { userId: UserId; applicationId: string; browserRunId: string }[] = [];
	for (const row of picked) {
		const owner = row.userId as UserId;
		if (!(await transition(tx, owner, row.id, "READY", "APPLYING"))) continue;
		await tx.update(application).set({ requestedMode: null }).where(eq(application.id, row.id));
		const mode: RunMode = row.effective === "LIVE" ? "live" : "dry";
		const [run] = await tx
			.insert(browserRun)
			.values({ userId: owner, applicationId: row.id, mode })
			.returning({ id: browserRun.id });
		if (!run) throw new Error("the Browser Run was not created");
		await appendEvent(tx, owner, browserRunQueued, row.id, {
			browserRunId: run.id,
			mode,
			requested: row.requested !== null,
		});
		claimed.push({ userId: owner, applicationId: row.id, browserRunId: run.id });
	}
	return claimed;
}

/** Every QUEUED run: the sweeper re-nudges those whose job was lost. */
export async function queuedBrowserRuns(exec: Executor): Promise<{ userId: UserId; browserRunId: string }[]> {
	const rows = await exec
		.select({ userId: browserRun.userId, browserRunId: browserRun.id })
		.from(browserRun)
		.where(eq(browserRun.status, "QUEUED"));
	return rows.map((row) => ({ userId: row.userId as UserId, browserRunId: row.browserRunId }));
}

// ——— Running ———

/**
 * Takes the QUEUED run for this worker (compare-and-set to RUNNING, first heartbeat). Null
 * when it is not QUEUED any more, such as a job delivered twice.
 */
export async function startBrowserRun(
	exec: Executor,
	owner: UserId,
	browserRunId: string,
	workerId: string,
): Promise<{ applicationId: string; mode: RunMode } | null> {
	const now = new Date();
	const [started] = await exec
		.update(browserRun)
		.set({ status: "RUNNING", workerId, heartbeatAt: now, startedAt: now })
		.where(and(eq(browserRun.id, browserRunId), eq(browserRun.userId, owner), eq(browserRun.status, "QUEUED")))
		.returning({ applicationId: browserRun.applicationId, mode: browserRun.mode });
	return started ?? null;
}

const owned = (owner: UserId, browserRunId: string, workerId: string) =>
	and(
		eq(browserRun.id, browserRunId),
		eq(browserRun.userId, owner),
		eq(browserRun.status, "RUNNING"),
		eq(browserRun.workerId, workerId),
	);

/** The worker's heartbeat (~15 s, §5). False once the run is no longer this worker's: stop it. */
export async function heartbeatBrowserRun(
	exec: Executor,
	owner: UserId,
	browserRunId: string,
	workerId: string,
): Promise<boolean> {
	const [beat] = await exec
		.update(browserRun)
		.set({ heartbeatAt: new Date() })
		.where(owned(owner, browserRunId, workerId))
		.returning({ id: browserRun.id });
	return beat !== undefined;
}

/** Appends compact events to the run, as they happen, while this worker owns it. */
export async function recordBrowserRunEvents(
	exec: Executor,
	owner: UserId,
	browserRunId: string,
	workerId: string,
	events: RunEvent[],
	now = new Date(),
): Promise<boolean> {
	const stored: StoredRunEvent[] = events.map((e) => ({ ...e, at: now.toISOString() }));
	const [recorded] = await exec
		.update(browserRun)
		.set({ events: sql`${browserRun.events} || ${JSON.stringify(stored)}::jsonb`, heartbeatAt: now })
		.where(owned(owner, browserRunId, workerId))
		.returning({ id: browserRun.id });
	return recorded !== undefined;
}

export type RunEnd =
	| { status: "COMPLETED"; checkpoint: RunCheckpoint }
	| { status: "SUBMITTED"; checkpoint: RunCheckpoint; confirmation: Confirmation }
	| { status: "FAILED"; checkpoint: RunCheckpoint; failure: RunFailure }
	| { status: "ABORTED"; checkpoint: RunCheckpoint | null };

/**
 * Ends this worker's run, keeping the evidence. Before the submit boundary the Application
 * goes back to READY: a finished Dry Run (§5), a pre-boundary failure (recovery comes with
 * TB1-15) or an abort, which uses no attempt. Past the boundary only a positive confirmation
 * makes it SUBMITTED; anything else is an Uncertain Submission (SUBMIT_UNKNOWN plus an
 * Intervention), never retried. False when the run is no longer this worker's (it was reclaimed).
 */
export async function finishBrowserRun(
	tx: Tx,
	owner: UserId,
	browserRunId: string,
	workerId: string,
	end: RunEnd,
): Promise<boolean> {
	const [intent] = await tx
		.select({ id: submitIntent.id })
		.from(submitIntent)
		.innerJoin(browserRun, eq(browserRun.id, submitIntent.browserRunId))
		.where(
			and(
				eq(submitIntent.browserRunId, browserRunId),
				eq(submitIntent.status, "OPEN"),
				owned(owner, browserRunId, workerId),
			),
		)
		.for("update", { of: submitIntent });
	if (!intent && end.status === "SUBMITTED") {
		throw new Error("a submission was reported without crossing the submit boundary");
	}
	const submitted = intent !== undefined && end.status === "SUBMITTED";
	// Past the boundary, anything but a positive confirmation is uncertain, never a failure to retry.
	let status: BrowserRunStatus;
	let failure: RunFailure | null;
	if (intent) {
		status = submitted ? "COMPLETED" : "FAILED";
		failure = submitted
			? null
			: { category: "UNKNOWN", detail: end.status === "FAILED" ? end.failure.detail : "no confirmation" };
	} else {
		status = end.status === "SUBMITTED" ? "COMPLETED" : end.status;
		failure = end.status === "FAILED" ? end.failure : null;
	}
	const [finished] = await tx
		.update(browserRun)
		.set({ status, checkpoint: end.checkpoint, failure, finishedAt: new Date() })
		.where(owned(owner, browserRunId, workerId))
		.returning({ applicationId: browserRun.applicationId, mode: browserRun.mode });
	if (!finished) return false;
	if (intent && end.status === "SUBMITTED") {
		await confirmSubmission(
			tx,
			owner,
			{ intentId: intent.id, applicationId: finished.applicationId },
			end.confirmation,
		);
	} else if (intent) {
		await markUncertain(
			tx,
			owner,
			{ intentId: intent.id, applicationId: finished.applicationId, browserRunId },
			"no_confirmation",
		);
	} else {
		await transition(tx, owner, finished.applicationId, "APPLYING", "READY");
	}
	await appendEvent(tx, owner, browserRunFinished, finished.applicationId, {
		browserRunId,
		mode: finished.mode,
		status,
		category: failure?.category ?? null,
	});
	return true;
}

/**
 * The sweeper's reclaim (§5, ADR 0004): a RUNNING run whose worker has ended (another worker
 * owns the lock now) or whose heartbeat expired is ABORTED, using no attempt, and its
 * Application is READY again; a run that had crossed the submit boundary becomes an Uncertain
 * Submission instead, never retried. Returns how many.
 */
export async function reclaimBrowserRuns(
	db: Db,
	options: { workerId: string; heartbeatBefore: Date },
): Promise<number> {
	return db.transaction(async (tx) => {
		const stale = await tx
			.select({
				id: browserRun.id,
				userId: browserRun.userId,
				applicationId: browserRun.applicationId,
				mode: browserRun.mode,
			})
			.from(browserRun)
			.where(
				and(
					eq(browserRun.status, "RUNNING"),
					or(
						ne(browserRun.workerId, options.workerId),
						isNull(browserRun.heartbeatAt),
						lt(browserRun.heartbeatAt, options.heartbeatBefore),
					),
				),
			)
			.for("update", { skipLocked: true });
		for (const run of stale) {
			const owner = run.userId as UserId;
			await tx.update(browserRun).set({ status: "ABORTED", finishedAt: new Date() }).where(eq(browserRun.id, run.id));
			const [intent] = await tx
				.select({ id: submitIntent.id })
				.from(submitIntent)
				.where(and(eq(submitIntent.browserRunId, run.id), eq(submitIntent.status, "OPEN")))
				.for("update");
			if (intent) {
				await markUncertain(
					tx,
					owner,
					{ intentId: intent.id, applicationId: run.applicationId, browserRunId: run.id },
					"run_lost",
				);
			} else {
				await transition(tx, owner, run.applicationId, "APPLYING", "READY");
			}
			await appendEvent(tx, owner, browserRunFinished, run.applicationId, {
				browserRunId: run.id,
				mode: run.mode,
				status: "ABORTED",
				category: null,
			});
		}
		return stale.length;
	});
}

// ——— Reading ———

export type BrowserRun = {
	id: string;
	mode: RunMode;
	status: BrowserRunStatus;
	events: StoredRunEvent[];
	checkpoint: RunCheckpoint | null;
	failure: RunFailure | null;
	createdAt: Date;
	startedAt: Date | null;
	finishedAt: Date | null;
};

/** The Application's Browser Runs, newest first: the Execution tab (§16). */
export async function listBrowserRuns(exec: Executor, owner: UserId, applicationId: string): Promise<BrowserRun[]> {
	return exec
		.select({
			id: browserRun.id,
			mode: browserRun.mode,
			status: browserRun.status,
			events: browserRun.events,
			checkpoint: browserRun.checkpoint,
			failure: browserRun.failure,
			createdAt: browserRun.createdAt,
			startedAt: browserRun.startedAt,
			finishedAt: browserRun.finishedAt,
		})
		.from(browserRun)
		.where(and(eq(browserRun.userId, owner), eq(browserRun.applicationId, applicationId)))
		.orderBy(desc(browserRun.createdAt), desc(browserRun.id));
}

/**
 * The blob of a run's `index`-th screenshot, resolved through the owner's Application and
 * run (§13: downloads use domain references, never raw hashes). Null when there is none.
 */
export async function browserRunEvidence(
	exec: Executor,
	owner: UserId,
	applicationId: string,
	browserRunId: string,
	index: number,
): Promise<BlobHash | null> {
	const [run] = await exec
		.select({ events: browserRun.events })
		.from(browserRun)
		.where(
			and(eq(browserRun.id, browserRunId), eq(browserRun.userId, owner), eq(browserRun.applicationId, applicationId)),
		);
	const shot = run?.events.filter((e) => e.type === "screenshot")[index];
	return shot?.type === "screenshot" ? (shot.ref as BlobHash) : null;
}

/** Dry Runs that completed (§16 Dashboard): counted apart, never as Submitted. */
export async function countDryRuns(exec: Executor, owner: UserId): Promise<number> {
	const [row] = await exec
		.select({ n: count() })
		.from(browserRun)
		.where(and(eq(browserRun.userId, owner), eq(browserRun.mode, "dry"), eq(browserRun.status, "COMPLETED")));
	return row?.n ?? 0;
}
