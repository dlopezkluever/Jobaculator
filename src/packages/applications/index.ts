import { and, asc, count, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor, Tx } from "../db/index";
import type { UserId } from "../db/ownership";
import { opportunity } from "../discovery/tables";
import { appendEvent, defineEvent } from "../events/index";
import { hunt } from "../hunts/tables";
import type { Match } from "../matching/index";
import { match } from "../matching/tables";
import { application } from "./lib/schema";
import { APPLICATION_STATUSES, type ApplicationStatus, type FrozenEvaluation, TRANSITIONS } from "./lib/types";

// Applications (§4, §5, #9, #12, ADR 0001, 0002, 0004): the single attempt to apply to one
// Opportunity, its lifecycle, and the Opportunity Value order preparation is pulled in. This
// module is the only writer of Applications and records every change as an event.

export { APPLICATION_STATUSES, type ApplicationStatus, type FrozenEvaluation, TRANSITIONS } from "./lib/types";

/** Application events are recorded against this subject type; read them with `listEvents`. */
export const APPLICATION_SUBJECT = "application";

export const applicationCreated = defineEvent({
	code: "application_created",
	subject: APPLICATION_SUBJECT,
	payload: z.object({
		opportunityId: z.uuid(),
		drivingHuntId: z.uuid(),
		drivingMatchId: z.uuid(),
		fit: z.int(),
		review: z.boolean(),
		/** Every Match that wanted to apply when it was decided. */
		matchIds: z.array(z.uuid()),
	}),
});
export const applicationStatusChanged = defineEvent({
	code: "application_status_changed",
	subject: APPLICATION_SUBJECT,
	payload: z.object({ from: z.enum(APPLICATION_STATUSES), to: z.enum(APPLICATION_STATUSES) }),
});

export type Application = {
	id: string;
	opportunityId: string;
	drivingHuntId: string;
	drivingMatchId: string;
	status: ApplicationStatus;
	fit: number;
	review: boolean;
	evaluation: FrozenEvaluation;
	/** When `prepare` was handed this Application; null while it waits its turn. */
	preparationDispatchedAt: Date | null;
	createdAt: Date;
};

const columns = {
	id: application.id,
	opportunityId: application.opportunityId,
	drivingHuntId: application.drivingHuntId,
	drivingMatchId: application.drivingMatchId,
	status: application.status,
	fit: application.fit,
	review: application.review,
	evaluation: application.evaluation,
	preparationDispatchedAt: application.preparationDispatchedAt,
	createdAt: application.createdAt,
};

/**
 * Serializes deciding one Opportunity: `decide`, and the check whether its Matches have
 * settled, take this lock first, so two evaluations finishing together cannot both miss it.
 */
export async function lockOpportunityDecision(tx: Tx, owner: UserId, opportunityId: string): Promise<void> {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`decide:${owner}:${opportunityId}`}, 0))`);
}

export type JudgedMatch = { match: Match; submissionPolicy: string };

/**
 * `decide(opportunity)`'s write (§4, §5): creates the Opportunity's one Application when any
 * qualifying Match wants to apply (a Skip never vetoes). The highest-fit such Match is the
 * Driving Hunt, the oldest on a tie; Review applies when any of them asks for it. The
 * Application keeps a frozen copy of the authorizing evaluation and policy. Null when no Match
 * wants to apply or the Opportunity already has an Application (which this never changes).
 */
export async function createApplication(
	tx: Tx,
	owner: UserId,
	opportunityId: string,
	judged: readonly JudgedMatch[],
): Promise<Application | null> {
	const wanting = judged.filter(
		({ match: m }) =>
			m.opportunityId === opportunityId && m.status === "QUALIFIED" && m.decision !== "SKIP" && m.fit !== null,
	);
	const driving = wanting.reduce<JudgedMatch | null>(
		(best, next) => (best === null || (next.match.fit ?? 0) > (best.match.fit ?? 0) ? next : best),
		null,
	);
	if (!driving) return null;
	const { match: m } = driving;
	if (m.fit === null || m.decision === null || m.reason === null || m.dimensions === null || !m.evaluatedAt) {
		throw new Error("a settled Match has no evaluation");
	}
	const review = wanting.some(({ match: w }) => w.decision === "REVIEW");
	const evaluation: FrozenEvaluation = {
		matchId: m.id,
		huntId: m.huntId,
		fit: m.fit,
		decision: m.decision,
		reason: m.reason,
		dimensions: m.dimensions,
		evaluatedAt: m.evaluatedAt.toISOString(),
		submissionPolicy: driving.submissionPolicy,
		review,
	};
	const [created] = await tx
		.insert(application)
		.values({
			userId: owner,
			opportunityId,
			drivingHuntId: m.huntId,
			drivingMatchId: m.id,
			fit: m.fit,
			review,
			evaluation,
		})
		.onConflictDoNothing()
		.returning(columns);
	if (!created) return null;
	await appendEvent(tx, owner, applicationCreated, created.id, {
		opportunityId,
		drivingHuntId: m.huntId,
		drivingMatchId: m.id,
		fit: m.fit,
		review,
		matchIds: wanting.map(({ match: w }) => w.id),
	});
	return created;
}

/** One of the owner's Applications, or null when it does not exist or belongs to another User. */
export async function getApplication(exec: Executor, owner: UserId, id: string): Promise<Application | null> {
	const [found] = await exec
		.select(columns)
		.from(application)
		.where(and(eq(application.id, id), eq(application.userId, owner)));
	return found ?? null;
}

export async function getApplicationForOpportunity(
	exec: Executor,
	owner: UserId,
	opportunityId: string,
): Promise<Application | null> {
	const [found] = await exec
		.select(columns)
		.from(application)
		.where(and(eq(application.opportunityId, opportunityId), eq(application.userId, owner)));
	return found ?? null;
}

/**
 * Moves the Application from `from` to `to` (compare-and-set) and records it, in the caller's
 * transaction, so the caller's next enqueue commits with it. False when it is no longer in
 * `from`; throws for a transition the lifecycle does not allow. Back in PREPARING, it waits for
 * the dispatcher again.
 */
export async function transition(
	tx: Tx,
	owner: UserId,
	id: string,
	from: ApplicationStatus,
	to: ApplicationStatus,
): Promise<boolean> {
	if (!TRANSITIONS[from].includes(to)) throw new Error(`an Application cannot go from ${from} to ${to}`);
	const [moved] = await tx
		.update(application)
		.set({ status: to, updatedAt: new Date(), ...(to === "PREPARING" ? { preparationDispatchedAt: null } : {}) })
		.where(and(eq(application.id, id), eq(application.userId, owner), eq(application.status, from)))
		.returning({ id: application.id });
	if (!moved) return false;
	await appendEvent(tx, owner, applicationStatusChanged, id, { from, to });
	return true;
}

/** Opportunity Value (#29): high Fit is at least this, a posting is recent when known and at most this old. */
export const OPPORTUNITY_VALUE = { highFit: 80, recentDays: 3 } as const;

/**
 * The priority-pull dispatcher's claim for `prepare` (§5): marks up to the free capacity of
 * waiting PREPARING Applications as dispatched and returns them in Opportunity Value order, one
 * order across Users and Hunts. Capacity is `backlog` minus the READY Applications and the ones
 * already preparing, so preparation stays just ahead of the browser. Skips Users in
 * `excludeUsers` (under a Hold) and closed postings. Enqueue `prepare` in the same transaction.
 */
export async function claimPreparations(
	tx: Tx,
	options: { backlog: number; excludeUsers?: readonly UserId[]; now?: Date },
): Promise<{ userId: UserId; applicationId: string }[]> {
	// Ticks run one at a time, so two never fill the same free capacity.
	await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('applications:dispatch-prepare', 0))`);
	const [load] = await tx
		.select({ n: count() })
		.from(application)
		.where(
			or(
				eq(application.status, "READY"),
				and(eq(application.status, "PREPARING"), isNotNull(application.preparationDispatchedAt)),
			),
		);
	const capacity = options.backlog - (load?.n ?? 0);
	if (capacity <= 0) return [];

	const now = options.now ?? new Date();
	const recentSince = new Date(now.getTime() - OPPORTUNITY_VALUE.recentDays * 24 * 60 * 60 * 1000).toISOString();
	const recent = sql`${opportunity.postedAt} >= ${recentSince}::timestamptz`;
	const high = sql`${application.fit} >= ${OPPORTUNITY_VALUE.highFit}`;
	// An unknown age compares as null, so it falls to the older tier: no boost, no penalty.
	const tier = sql`case when ${high} and ${recent} then 1 when ${high} then 2 when ${recent} then 3 else 4 end`;
	const excluded = options.excludeUsers ?? [];
	const picked = await tx
		.select({ id: application.id, userId: application.userId })
		.from(application)
		.innerJoin(
			opportunity,
			and(eq(opportunity.id, application.opportunityId), eq(opportunity.userId, application.userId)),
		)
		.where(
			and(
				eq(application.status, "PREPARING"),
				isNull(application.preparationDispatchedAt),
				eq(opportunity.status, "OPEN"),
				excluded.length > 0 ? notInArray(application.userId, [...excluded]) : undefined,
			),
		)
		.orderBy(tier, desc(application.fit), asc(application.createdAt), asc(application.id))
		.limit(capacity)
		.for("update", { of: application, skipLocked: true });
	if (picked.length === 0) return [];
	await tx
		.update(application)
		.set({ preparationDispatchedAt: now })
		.where(
			inArray(
				application.id,
				picked.map((row) => row.id),
			),
		);
	return picked.map((row) => ({ userId: row.userId as UserId, applicationId: row.id }));
}

/** Every User with a PREPARING Application waiting for the dispatcher. */
export async function usersAwaitingPreparation(exec: Executor): Promise<UserId[]> {
	const rows = await exec
		.selectDistinct({ userId: application.userId })
		.from(application)
		.where(and(eq(application.status, "PREPARING"), isNull(application.preparationDispatchedAt)));
	return rows.map((row) => row.userId as UserId);
}

/** Every PREPARING Application already handed to `prepare`: the sweeper re-nudges those without a live job. */
export async function dispatchedPreparations(exec: Executor): Promise<{ userId: UserId; applicationId: string }[]> {
	const rows = await exec
		.select({ userId: application.userId, applicationId: application.id })
		.from(application)
		.where(and(eq(application.status, "PREPARING"), isNotNull(application.preparationDispatchedAt)));
	return rows.map((row) => ({ userId: row.userId as UserId, applicationId: row.applicationId }));
}

/**
 * Every User's OPEN Opportunities that a qualifying Match of an ACTIVE Hunt wants to apply to
 * but that have no Application: the sweeper nudges `decide` for those without a live job.
 */
export async function undecidedOpportunities(exec: Executor): Promise<{ userId: UserId; opportunityId: string }[]> {
	const rows = await exec
		.selectDistinct({ userId: match.userId, opportunityId: match.opportunityId })
		.from(match)
		.innerJoin(hunt, and(eq(hunt.id, match.huntId), eq(hunt.userId, match.userId)))
		.innerJoin(opportunity, and(eq(opportunity.id, match.opportunityId), eq(opportunity.userId, match.userId)))
		.where(
			and(
				eq(match.status, "QUALIFIED"),
				inArray(match.decision, ["AUTO_APPLY", "REVIEW"]),
				eq(hunt.status, "ACTIVE"),
				eq(opportunity.status, "OPEN"),
				sql`not exists (select 1 from ${application} where ${application.userId} = ${match.userId} and ${application.opportunityId} = ${match.opportunityId})`,
			),
		);
	return rows.map((row) => ({ userId: row.userId as UserId, opportunityId: row.opportunityId }));
}

/** States an Application waits in without a Browser Run; a posting closing expires them (§5). */
const WAITING: readonly ApplicationStatus[] = ["PREPARING", "READY", "NEEDS_YOU", "IN_REVIEW"];

/** Expires every waiting Application whose posting has closed, each with its event. Returns how many. */
export async function expireClosedApplications(db: Db): Promise<number> {
	return db.transaction(async (tx) => {
		const closed = await tx
			.select({ id: application.id, userId: application.userId, status: application.status })
			.from(application)
			.innerJoin(
				opportunity,
				and(eq(opportunity.id, application.opportunityId), eq(opportunity.userId, application.userId)),
			)
			.where(and(inArray(application.status, [...WAITING]), eq(opportunity.status, "CLOSED")))
			.for("update", { of: application, skipLocked: true });
		let expired = 0;
		for (const row of closed) {
			if (await transition(tx, row.userId as UserId, row.id, row.status, "EXPIRED")) expired++;
		}
		return expired;
	});
}

/** The posting reopened: its Expired Application, if any, is reconsidered (back to PREPARING). */
export async function reviveExpired(tx: Tx, owner: UserId, opportunityId: string): Promise<boolean> {
	const found = await getApplicationForOpportunity(tx, owner, opportunityId);
	if (found?.status !== "EXPIRED") return false;
	return transition(tx, owner, found.id, "EXPIRED", "PREPARING");
}

export type ApplicationSummary = {
	id: string;
	status: ApplicationStatus;
	fit: number;
	review: boolean;
	/** Whether a PREPARING Application has been handed to `prepare`. */
	preparing: boolean;
	title: string;
	employerName: string;
	url: string;
	postedAt: Date | null;
	drivingHunt: { id: string; name: string };
	createdAt: Date;
	updatedAt: Date;
};

/** The owner's Applications, newest first: the Applications table (§16). */
export async function listApplications(exec: Executor, owner: UserId): Promise<ApplicationSummary[]> {
	const rows = await exec
		.select({
			id: application.id,
			status: application.status,
			fit: application.fit,
			review: application.review,
			dispatchedAt: application.preparationDispatchedAt,
			title: opportunity.title,
			employerName: opportunity.employerName,
			url: opportunity.canonicalUrl,
			postedAt: opportunity.postedAt,
			huntId: hunt.id,
			huntName: hunt.name,
			createdAt: application.createdAt,
			updatedAt: application.updatedAt,
		})
		.from(application)
		.innerJoin(
			opportunity,
			and(eq(opportunity.id, application.opportunityId), eq(opportunity.userId, application.userId)),
		)
		.innerJoin(hunt, and(eq(hunt.id, application.drivingHuntId), eq(hunt.userId, application.userId)))
		.where(eq(application.userId, owner))
		.orderBy(desc(application.createdAt), asc(application.id));
	return rows.map(({ dispatchedAt, huntId, huntName, ...row }) => ({
		...row,
		preparing: row.status === "PREPARING" && dispatchedAt !== null,
		drivingHunt: { id: huntId, name: huntName },
	}));
}

/**
 * The Dashboard's in-flight counts (§16): queued = waiting for preparation or for the browser
 * (PREPARING not yet dispatched, and READY); preparing = handed to `prepare`; in browser =
 * APPLYING or SUBMITTING.
 */
export async function countInFlight(
	exec: Executor,
	owner: UserId,
): Promise<{ queued: number; preparing: number; inBrowser: number }> {
	const rows = await exec
		.select({
			status: application.status,
			dispatched: sql<boolean>`${application.preparationDispatchedAt} is not null`,
			n: count(),
		})
		.from(application)
		.where(
			and(eq(application.userId, owner), inArray(application.status, ["PREPARING", "READY", "APPLYING", "SUBMITTING"])),
		)
		.groupBy(application.status, sql`${application.preparationDispatchedAt} is not null`);
	const counts = { queued: 0, preparing: 0, inBrowser: 0 };
	for (const row of rows) {
		if (row.status === "PREPARING" && row.dispatched) counts.preparing += row.n;
		else if (row.status === "PREPARING" || row.status === "READY") counts.queued += row.n;
		else counts.inBrowser += row.n;
	}
	return counts;
}
