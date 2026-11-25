import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Tx } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { appendEvent, defineEvent } from "../../events/index";
import { transition } from "./lifecycle";
import { application, intervention } from "./schema";
import { APPLICATION_SUBJECT, type FailureCategory, INTERVENTION_KINDS, type InterventionKind } from "./types";

// Recovering from a Browser Run that failed before the submit boundary (§5, #12): the retry
// table by §96 category, the backoff, the 3-run attempt budget, and the Interventions that
// stop an Application for the Candidate. Aborts (a deploy, a Hold, the gate refusing) never
// come here, so they use no attempt. Past the boundary nothing is retried (`markUncertain`).

/**
 * The §5 retry table. `retry`: a new Browser Run after the backoff, within the budget.
 * SITE_CHANGED's next run would use the general agent (§10), which Phase 0 has not built yet,
 * so it uses the adapter again. An UNKNOWN_QUESTION's mid-run answers are already on the
 * Package, so the next run continues from them; an authoritative gap arrives as
 * AUTHORITATIVE_FACT_REQUIRED instead. `intervene`: Needs You at once. `expire`: EXPIRED.
 */
export const RETRY_TABLE = {
	NETWORK: "retry",
	BROWSER_FAILURE: "retry",
	UPLOAD_FAILURE: "retry",
	UNKNOWN: "retry",
	SITE_CHANGED: "retry",
	UNKNOWN_QUESTION: "retry",
	CAPTCHA: "intervene",
	AUTH_REQUIRED: "intervene",
	AUTHORITATIVE_FACT_REQUIRED: "intervene",
	ASSESSMENT_REQUIRED: "intervene",
	UNSUPPORTED_FLOW: "intervene",
	// With its evidence on the run; never marked Submitted by itself.
	DUPLICATE_APPLICATION: "intervene",
	JOB_EXPIRED: "expire",
} as const satisfies Record<FailureCategory, "retry" | "intervene" | "expire">;

/** Automatic Browser Runs per Application before it needs the Candidate (§5). */
export const ATTEMPT_BUDGET = 3;
const BACKOFF_FIRST_MS = 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;

/** Exponential backoff after the `attempt`-th failed run: 1 m, 2 m, 4 m … at most 30 m. */
const backoffMs = (attempt: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (attempt - 1));

export const browserRunRetryScheduled = defineEvent({
	code: "browser_run_retry_scheduled",
	subject: APPLICATION_SUBJECT,
	payload: z.object({ browserRunId: z.uuid(), attempt: z.int(), retryAt: z.iso.datetime() }),
});
export const interventionOpened = defineEvent({
	code: "intervention_opened",
	subject: APPLICATION_SUBJECT,
	payload: z.object({ interventionId: z.uuid(), kind: z.enum(INTERVENTION_KINDS), browserRunId: z.uuid().nullable() }),
});

/** Opens a stub Intervention on the Application (§4: the Inbox and its resolutions are TB2's). */
export async function openIntervention(
	tx: Tx,
	owner: UserId,
	ids: { applicationId: string; browserRunId: string | null },
	kind: InterventionKind,
): Promise<void> {
	const [opened] = await tx
		.insert(intervention)
		.values({ userId: owner, applicationId: ids.applicationId, browserRunId: ids.browserRunId, kind })
		.returning({ id: intervention.id });
	if (!opened) throw new Error("the Intervention was not created");
	await appendEvent(tx, owner, interventionOpened, ids.applicationId, {
		interventionId: opened.id,
		kind,
		browserRunId: ids.browserRunId,
	});
}

/**
 * The APPLYING Application's run failed before the boundary with `category`: it uses one
 * attempt, then goes where the retry table says. A retry waits READY for its backoff; the
 * last attempt, or a category only the Candidate can resolve, is Needs You with an
 * Intervention; JOB_EXPIRED is EXPIRED. Null when the Application is no longer APPLYING.
 */
export async function recoverFailedRun(
	tx: Tx,
	owner: UserId,
	ids: { applicationId: string; browserRunId: string },
	category: FailureCategory,
	now = new Date(),
): Promise<"retry" | "needs_you" | "expired" | null> {
	const [counted] = await tx
		.update(application)
		.set({ attempts: sql`${application.attempts} + 1` })
		.where(
			and(eq(application.id, ids.applicationId), eq(application.userId, owner), eq(application.status, "APPLYING")),
		)
		.returning({ attempts: application.attempts });
	if (!counted) return null;
	const handling = RETRY_TABLE[category];
	if (handling === "expire") {
		await transition(tx, owner, ids.applicationId, "APPLYING", "EXPIRED");
		return "expired";
	}
	if (handling === "intervene" || counted.attempts >= ATTEMPT_BUDGET) {
		await transition(tx, owner, ids.applicationId, "APPLYING", "NEEDS_YOU");
		await openIntervention(
			tx,
			owner,
			ids,
			handling === "intervene" ? (category as InterventionKind) : "ATTEMPTS_EXHAUSTED",
		);
		return "needs_you";
	}
	const retryAt = new Date(now.getTime() + backoffMs(counted.attempts));
	await tx.update(application).set({ retryAfter: retryAt }).where(eq(application.id, ids.applicationId));
	await transition(tx, owner, ids.applicationId, "APPLYING", "READY");
	await appendEvent(tx, owner, browserRunRetryScheduled, ids.applicationId, {
		browserRunId: ids.browserRunId,
		attempt: counted.attempts,
		retryAt: retryAt.toISOString(),
	});
	return "retry";
}

export type Intervention = {
	id: string;
	kind: InterventionKind;
	browserRunId: string | null;
	createdAt: Date;
	resolvedAt: Date | null;
};

/** The Application's Interventions, newest first. */
export async function listInterventions(exec: Executor, owner: UserId, applicationId: string): Promise<Intervention[]> {
	return exec
		.select({
			id: intervention.id,
			kind: intervention.kind,
			browserRunId: intervention.browserRunId,
			createdAt: intervention.createdAt,
			resolvedAt: intervention.resolvedAt,
		})
		.from(intervention)
		.where(and(eq(intervention.userId, owner), eq(intervention.applicationId, applicationId)))
		.orderBy(desc(intervention.createdAt), desc(intervention.id));
}

/** The owner's Applications in Needs You (§16 attention tile). */
export async function countNeedsYou(exec: Executor, owner: UserId): Promise<number> {
	const [row] = await exec
		.select({ n: count() })
		.from(application)
		.where(and(eq(application.userId, owner), eq(application.status, "NEEDS_YOU")));
	return row?.n ?? 0;
}
