import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Tx } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { opportunity } from "../../discovery/tables";
import { appendEvent, defineEvent } from "../../events/index";
import { transition } from "./lifecycle";
import { application, applicationPackage, browserRun, intervention, submitIntent } from "./schema";
import { APPLICATION_SUBJECT, type Confirmation, type FieldRecord, type PackageRevision } from "./types";

// The submit boundary (§5, #12, #22, ADR 0004): the intent a live Browser Run crosses it under,
// the boundary's compare-and-set APPLYING → SUBMITTING with the frozen Package revision, and
// what the run's end records after it. Nothing past the boundary ever goes back to READY by itself.

export const submitBoundaryCrossed = defineEvent({
	code: "submit_boundary_crossed",
	subject: APPLICATION_SUBJECT,
	payload: z.object({ browserRunId: z.uuid(), intentId: z.uuid() }),
});
export const submissionConfirmed = defineEvent({
	code: "submission_confirmed",
	subject: APPLICATION_SUBJECT,
	payload: z.object({ intentId: z.uuid(), applicationIdShown: z.boolean() }),
});
/** An Uncertain Submission (§5): the run crossed the boundary and no positive confirmation was seen. */
export const submissionUncertain = defineEvent({
	code: "submission_uncertain",
	subject: APPLICATION_SUBJECT,
	payload: z.object({ intentId: z.uuid(), reason: z.enum(["no_confirmation", "run_lost"]) }),
});

const ownedLiveRun = (owner: UserId, browserRunId: string, workerId: string) =>
	and(
		eq(browserRun.id, browserRunId),
		eq(browserRun.userId, owner),
		eq(browserRun.status, "RUNNING"),
		eq(browserRun.workerId, workerId),
		eq(browserRun.mode, "live"),
	);

/** What the submit-intent journal entry records (§13): identities only, no answers or documents. */
export type SubmitIntentIdentity = {
	intentId: string;
	applicationId: string;
	opportunityId: string;
	/** The Opportunity's normalized dedup key: recovery rebuilds from it. */
	dedupKey: string;
};

/**
 * Step 1 of the boundary: the run's stable intent id, generated once and reused (§5), with
 * the identities its journal entry records. Null when the run is not this worker's live run.
 */
export async function prepareSubmitIntent(
	exec: Executor,
	owner: UserId,
	browserRunId: string,
	workerId: string,
): Promise<SubmitIntentIdentity | null> {
	const [run] = await exec
		.update(browserRun)
		.set({ intentId: sql`coalesce(${browserRun.intentId}, gen_random_uuid())` })
		.where(ownedLiveRun(owner, browserRunId, workerId))
		.returning({ intentId: browserRun.intentId, applicationId: browserRun.applicationId });
	if (!run?.intentId) return null;
	const [found] = await exec
		.select({ opportunityId: opportunity.id, dedupKey: opportunity.dedupKey })
		.from(application)
		.innerJoin(
			opportunity,
			and(eq(opportunity.id, application.opportunityId), eq(opportunity.userId, application.userId)),
		)
		.where(and(eq(application.id, run.applicationId), eq(application.userId, owner)));
	if (!found) return null;
	return { intentId: run.intentId, applicationId: run.applicationId, ...found };
}

/**
 * Step 3 of the boundary, in the caller's transaction (which also checks the recovery marker,
 * the launch gate and the canary User): compare-and-set APPLYING → SUBMITTING for the run that
 * owns the Application, freeze the Package revision, and write the submit-intent row under the
 * journaled intent id. False, writing nothing, when the run or the Application has moved on.
 * A second open intent for the Application violates `submit_intent_open_idx` and throws.
 */
export async function beginSubmission(
	tx: Tx,
	owner: UserId,
	crossing: {
		browserRunId: string;
		workerId: string;
		intentId: string;
		files: PackageRevision["files"];
		fields: FieldRecord[];
	},
): Promise<boolean> {
	const [run] = await tx
		.select({ applicationId: browserRun.applicationId, intentId: browserRun.intentId })
		.from(browserRun)
		.where(ownedLiveRun(owner, crossing.browserRunId, crossing.workerId))
		.for("update");
	if (!run || run.intentId !== crossing.intentId) return false;
	const [pkg] = await tx
		.select({ jobSnapshot: applicationPackage.jobSnapshot, answers: applicationPackage.answers })
		.from(applicationPackage)
		.where(and(eq(applicationPackage.applicationId, run.applicationId), eq(applicationPackage.userId, owner)));
	if (!pkg?.answers) return false;
	if (!(await transition(tx, owner, run.applicationId, "APPLYING", "SUBMITTING"))) return false;
	await tx.insert(submitIntent).values({
		id: crossing.intentId,
		userId: owner,
		applicationId: run.applicationId,
		browserRunId: crossing.browserRunId,
		revision: { jobSnapshot: pkg.jobSnapshot, answers: pkg.answers, files: crossing.files, fields: crossing.fields },
	});
	await appendEvent(tx, owner, submitBoundaryCrossed, run.applicationId, {
		browserRunId: crossing.browserRunId,
		intentId: crossing.intentId,
	});
	return true;
}

/** Positive confirmation was seen: the intent and the Application are SUBMITTED, with the evidence. */
export async function confirmSubmission(
	tx: Tx,
	owner: UserId,
	ids: { intentId: string; applicationId: string },
	confirmation: Confirmation,
): Promise<void> {
	await tx
		.update(submitIntent)
		.set({ status: "SUBMITTED", confirmation, resolvedAt: new Date() })
		.where(and(eq(submitIntent.id, ids.intentId), eq(submitIntent.userId, owner)));
	if (!(await transition(tx, owner, ids.applicationId, "SUBMITTING", "SUBMITTED"))) {
		throw new Error("a confirmed submission's Application was not SUBMITTING");
	}
	await appendEvent(tx, owner, submissionConfirmed, ids.applicationId, {
		intentId: ids.intentId,
		applicationIdShown: confirmation.applicationId !== null,
	});
}

/** No positive confirmation: SUBMIT_UNKNOWN with a stub Intervention, never retried automatically (§5). */
export async function markUncertain(
	tx: Tx,
	owner: UserId,
	ids: { intentId: string; applicationId: string; browserRunId: string },
	reason: "no_confirmation" | "run_lost",
): Promise<void> {
	await tx
		.update(submitIntent)
		.set({ status: "UNKNOWN", resolvedAt: new Date() })
		.where(and(eq(submitIntent.id, ids.intentId), eq(submitIntent.userId, owner)));
	if (!(await transition(tx, owner, ids.applicationId, "SUBMITTING", "SUBMIT_UNKNOWN"))) {
		throw new Error("an uncertain submission's Application was not SUBMITTING");
	}
	await tx.insert(intervention).values({
		userId: owner,
		applicationId: ids.applicationId,
		browserRunId: ids.browserRunId,
		kind: "SUBMIT_UNKNOWN",
	});
	await appendEvent(tx, owner, submissionUncertain, ids.applicationId, { intentId: ids.intentId, reason });
}

/**
 * The Dashboard's headline (§1, §16): confirmed Submitted Applications today, this week and in
 * all, on the Candidate's local day (weeks start Monday). Dry Runs and Uncertain Submissions
 * never count.
 */
export async function countSubmitted(
	exec: Executor,
	owner: UserId,
	timeZone: string,
	now: Date = new Date(),
): Promise<{ today: number; week: number; allTime: number }> {
	const local = sql`(${now.toISOString()}::timestamptz at time zone ${timeZone})`;
	const since = (unit: "day" | "week") => sql`(date_trunc(${unit}, ${local}) at time zone ${timeZone})`;
	const [row] = await exec
		.select({
			today: sql<number>`count(*) filter (where ${submitIntent.resolvedAt} >= ${since("day")})::int`,
			week: sql<number>`count(*) filter (where ${submitIntent.resolvedAt} >= ${since("week")})::int`,
			allTime: count(),
		})
		.from(submitIntent)
		.where(
			and(eq(submitIntent.userId, owner), eq(submitIntent.status, "SUBMITTED"), isNotNull(submitIntent.resolvedAt)),
		);
	return { today: row?.today ?? 0, week: row?.week ?? 0, allTime: row?.allTime ?? 0 };
}

/** The owner's Uncertain Submissions (§16 attention tile): they never count until the Candidate confirms. */
export async function countUncertain(exec: Executor, owner: UserId): Promise<number> {
	const [row] = await exec
		.select({ n: count() })
		.from(application)
		.where(and(eq(application.userId, owner), eq(application.status, "SUBMIT_UNKNOWN")));
	return row?.n ?? 0;
}

export type SubmitIntent = {
	id: string;
	browserRunId: string;
	status: (typeof submitIntent.$inferSelect)["status"];
	confirmation: Confirmation | null;
	createdAt: Date;
	resolvedAt: Date | null;
};

/** The Application's submit intents, oldest first: the Execution tab's confirmation evidence. */
export async function listSubmitIntents(exec: Executor, owner: UserId, applicationId: string): Promise<SubmitIntent[]> {
	return exec
		.select({
			id: submitIntent.id,
			browserRunId: submitIntent.browserRunId,
			status: submitIntent.status,
			confirmation: submitIntent.confirmation,
			createdAt: submitIntent.createdAt,
			resolvedAt: submitIntent.resolvedAt,
		})
		.from(submitIntent)
		.where(and(eq(submitIntent.userId, owner), eq(submitIntent.applicationId, applicationId)))
		.orderBy(submitIntent.createdAt);
}
