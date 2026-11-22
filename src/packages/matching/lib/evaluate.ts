import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { LlmClient } from "../../ai/index";
import type { Db, Executor, Tx } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { opportunity } from "../../discovery/tables";
import { appendEvent, defineEvent } from "../../events/index";
import { type HuntCriteria, TIERS } from "../../hunts/criteria";
import { hunt } from "../../hunts/tables";
import { extractAttributes, mergeAttributes, type OpportunityInput, statedAttributes } from "./extract";
import { judge } from "./judge";
import { match } from "./schema";
import {
	DECISIONS,
	DECISIVE_REASONS,
	type Decision,
	type DecisiveReason,
	DIMENSIONS,
	type DimensionJudgement,
	type MatchStatus,
	PROVENANCES,
} from "./types";

/** Match events are recorded against this subject type; read them with `listEvents`. */
export const MATCH_SUBJECT = "match";

/**
 * The decision and what it rests on (ADR 0008): codes and input ids only. `stage` says whether
 * the stated-only prefilter settled it (no extraction) or the full evaluation did.
 */
export const matchEvaluated = defineEvent({
	code: "match_evaluated",
	subject: MATCH_SUBJECT,
	payload: z.object({
		huntId: z.uuid(),
		opportunityId: z.uuid(),
		stage: z.enum(["prefilter", "full"]),
		/** The `ai_call` whose extraction was used, fresh or cached; null when none was. */
		extractionCallId: z.uuid().nullable(),
		qualified: z.boolean(),
		fit: z.int(),
		decision: z.enum(DECISIONS),
		reason: z.enum(DECISIVE_REASONS),
		dimensions: z.array(
			z.object({
				dimension: z.enum(DIMENSIONS),
				tier: z.enum(TIERS).nullable(),
				provenance: z.enum(PROVENANCES),
				excludes: z.boolean(),
			}),
		),
	}),
});

export type Match = {
	id: string;
	huntId: string;
	opportunityId: string;
	status: MatchStatus;
	/** Null while PENDING. */
	qualified: boolean | null;
	fit: number | null;
	decision: Decision | null;
	reason: DecisiveReason | null;
	/** The per-dimension explanation; null while PENDING. */
	dimensions: DimensionJudgement[] | null;
	evaluatedAt: Date | null;
	/** Pass back to `evaluate`, so an evaluation of stale inputs is never written. */
	revision: number;
};

const columns = {
	id: match.id,
	huntId: match.huntId,
	opportunityId: match.opportunityId,
	status: match.status,
	fit: match.fit,
	decision: match.decision,
	reason: match.reason,
	dimensions: match.dimensions,
	evaluatedAt: match.evaluatedAt,
	revision: match.revision,
};
type Row = Omit<typeof match.$inferSelect, "userId" | "createdAt">;

const toMatch = (row: Row): Match => ({
	...row,
	qualified: row.status === "PENDING" ? null : row.status === "QUALIFIED",
});

/**
 * Makes each Hunt's Match of the Opportunity PENDING, creating it if needed, in the caller's
 * transaction, and returns the Match ids to evaluate. Called when the Opportunity is new or
 * changed; the caller passes only ACTIVE Hunts.
 */
export async function requestEvaluations(
	tx: Tx,
	owner: UserId,
	opportunityId: string,
	huntIds: readonly string[],
): Promise<string[]> {
	if (huntIds.length === 0) return [];
	const rows = await tx
		.insert(match)
		.values(huntIds.map((huntId) => ({ userId: owner, huntId, opportunityId })))
		.onConflictDoUpdate({
			target: [match.huntId, match.opportunityId],
			set: {
				status: "PENDING",
				revision: sql`${match.revision} + 1`,
				fit: null,
				decision: null,
				reason: null,
				dimensions: null,
				evaluatedAt: null,
			},
			// A Hunt id of another User never touches that User's Match.
			setWhere: eq(match.userId, owner),
		})
		.returning({ id: match.id });
	return rows.map((row) => row.id);
}

/** One of the owner's Matches, or null when it does not exist or belongs to another User. */
export async function getMatch(exec: Executor, owner: UserId, id: string): Promise<Match | null> {
	const [row] = await exec
		.select(columns)
		.from(match)
		.where(and(eq(match.id, id), eq(match.userId, owner)));
	return row ? toMatch(row) : null;
}

/** The owner's Matches of these Opportunities, one per Hunt that judged them, oldest first. */
export async function listMatches(exec: Executor, owner: UserId, opportunityIds: readonly string[]): Promise<Match[]> {
	if (opportunityIds.length === 0) return [];
	const rows = await exec
		.select(columns)
		.from(match)
		.where(and(eq(match.userId, owner), inArray(match.opportunityId, [...opportunityIds])))
		.orderBy(asc(match.createdAt), asc(match.id));
	return rows.map((row) => toMatch(row));
}

export type EvaluationInputs = {
	criteria: HuntCriteria;
	opportunity: OpportunityInput;
	/** The Candidate's years of experience; null when unknown. */
	experienceYears: number | null;
};

/**
 * `evaluate(match)` (§5 step 3, §7): a deterministic prefilter on stated values only; for
 * survivors, the cached LLM extraction; then Qualification → Fit → Submission Policy. Writes
 * the Match and its `match_evaluated` event in one transaction, only if the Match is still
 * PENDING at `pending.revision`; returns null when it moved on. Read `pending` before the inputs.
 * `onEvaluated` runs in that transaction, so the caller's next step commits with the Match.
 */
export async function evaluate(
	deps: { db: Db; llm: LlmClient },
	owner: UserId,
	pending: Pick<Match, "id" | "revision">,
	inputs: EvaluationInputs,
	options: { onEvaluated?: (tx: Tx, evaluated: Match) => Promise<void> } = {},
): Promise<Match | null> {
	const { criteria, opportunity, experienceYears } = inputs;
	const base = { criteria, title: opportunity.title, locationText: opportunity.locationText, experienceYears };
	const stated = statedAttributes(opportunity);
	const prefiltered = judge({ ...base, attributes: stated });
	// Before extraction nothing can disqualify, so a Skip here is an explicit Hunt exclusion on stated values.
	const extracted = prefiltered.decision === "SKIP" ? null : await extractAttributes(deps, owner, opportunity);
	const judgement = extracted
		? judge({ ...base, attributes: mergeAttributes(stated, extracted.attributes) })
		: prefiltered;

	return deps.db.transaction(async (tx) => {
		const [row] = await tx
			.update(match)
			.set({
				status: judgement.qualified ? "QUALIFIED" : "DISQUALIFIED",
				fit: judgement.fit,
				decision: judgement.decision,
				reason: judgement.reason,
				dimensions: judgement.dimensions,
				evaluatedAt: new Date(),
			})
			.where(
				and(
					eq(match.id, pending.id),
					eq(match.userId, owner),
					eq(match.status, "PENDING"),
					eq(match.revision, pending.revision),
				),
			)
			.returning(columns);
		if (!row) return null;
		await appendEvent(tx, owner, matchEvaluated, row.id, {
			huntId: row.huntId,
			opportunityId: row.opportunityId,
			stage: prefiltered.decision === "SKIP" ? "prefilter" : "full",
			extractionCallId: extracted?.callId ?? null,
			qualified: judgement.qualified,
			fit: judgement.fit,
			decision: judgement.decision,
			reason: judgement.reason,
			dimensions: judgement.dimensions.map(({ dimension, tier, provenance, excludes }) => ({
				dimension,
				tier,
				provenance,
				excludes,
			})),
		});
		const evaluated = toMatch(row);
		await options.onEvaluated?.(tx, evaluated);
		return evaluated;
	});
}

/**
 * Every User's PENDING Matches that could be evaluated now: their Hunt is ACTIVE and their
 * Opportunity OPEN. The sweeper nudges those without a live `evaluate` job (§5), such as a
 * Match whose evaluation failed or whose Hunt was paused when it was asked.
 */
export async function evaluableMatches(exec: Executor): Promise<{ userId: UserId; matchId: string }[]> {
	const rows = await exec
		.select({ userId: match.userId, matchId: match.id })
		.from(match)
		.innerJoin(hunt, and(eq(hunt.id, match.huntId), eq(hunt.userId, match.userId)))
		.innerJoin(opportunity, and(eq(opportunity.id, match.opportunityId), eq(opportunity.userId, match.userId)))
		.where(and(eq(match.status, "PENDING"), eq(hunt.status, "ACTIVE"), eq(opportunity.status, "OPEN")));
	return rows.map((row) => ({ userId: row.userId as UserId, matchId: row.matchId }));
}
