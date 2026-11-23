import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../db/index";
import type { UserId } from "../db/ownership";
import { appendEvent, defineEvent } from "../events/index";
import {
	type CreativeLatitude,
	type HuntCriteria,
	type HuntInput,
	type HuntStatus,
	huntCriteriaSchema,
	huntInputSchema,
	type SubmissionMode,
	type SubmissionPolicy,
} from "./criteria";
import { hunt } from "./lib/schema";

export type Hunt = {
	id: string;
	name: string;
	status: HuntStatus;
	criteria: HuntCriteria;
	creativeLatitude: CreativeLatitude;
	submissionPolicy: SubmissionPolicy;
	/** Null follows the global setting. */
	submissionMode: SubmissionMode | null;
};

/** Hunt events are recorded against this subject type; read them with `listEvents`. */
export const HUNT_SUBJECT = "hunt";

const EDITABLE_FIELDS = ["name", "criteria", "creativeLatitude", "submissionPolicy", "submissionMode"] as const;

export const huntCreated = defineEvent({ code: "hunt_created", subject: HUNT_SUBJECT, payload: z.object({}) });
/** Which settings an edit changed; never their values (ADR 0008). A criteria change is a retarget. */
export const huntEdited = defineEvent({
	code: "hunt_edited",
	subject: HUNT_SUBJECT,
	payload: z.object({ changed: z.array(z.enum(EDITABLE_FIELDS)).min(1) }),
});
/** Pausing stops the Hunt's evaluations and new Applications; in-flight Applications continue (§5). */
export const huntPaused = defineEvent({ code: "hunt_paused", subject: HUNT_SUBJECT, payload: z.object({}) });
export const huntResumed = defineEvent({ code: "hunt_resumed", subject: HUNT_SUBJECT, payload: z.object({}) });

const columns = {
	id: hunt.id,
	name: hunt.name,
	status: hunt.status,
	criteria: hunt.criteria,
	creativeLatitude: hunt.creativeLatitude,
	submissionPolicy: hunt.submissionPolicy,
	submissionMode: hunt.submissionMode,
};

/** Creates an ACTIVE Hunt. Throws a ZodError, writing nothing, when the input is not a valid Hunt. */
export async function createHunt(exec: Executor, owner: UserId, input: HuntInput): Promise<Hunt> {
	const values = huntInputSchema.parse(input);
	return exec.transaction(async (tx) => {
		const [created] = await tx
			.insert(hunt)
			.values({ userId: owner, ...values })
			.returning(columns);
		if (!created) throw new Error("the Hunt was not created");
		await appendEvent(tx, owner, huntCreated, created.id, {});
		return created;
	});
}

/** The owner's Hunts, oldest first. */
export async function listHunts(exec: Executor, owner: UserId): Promise<Hunt[]> {
	return exec.select(columns).from(hunt).where(eq(hunt.userId, owner)).orderBy(asc(hunt.createdAt), asc(hunt.id));
}

/** Whether the owner has any ACTIVE Hunt: discovery polls their Boards only then (ADR 0007). */
export async function hasActiveHunt(exec: Executor, owner: UserId): Promise<boolean> {
	const [found] = await exec
		.select({ id: hunt.id })
		.from(hunt)
		.where(and(eq(hunt.userId, owner), eq(hunt.status, "ACTIVE")))
		.limit(1);
	return found !== undefined;
}

/** Every User with an ACTIVE Hunt: the discovery schedule's one read across Users. */
export async function usersWithActiveHunts(exec: Executor): Promise<UserId[]> {
	const rows = await exec.selectDistinct({ userId: hunt.userId }).from(hunt).where(eq(hunt.status, "ACTIVE"));
	return rows.map((row) => row.userId as UserId);
}

/** One of the owner's Hunts, or null when it does not exist or belongs to another User. */
export async function getHunt(exec: Executor, owner: UserId, id: string): Promise<Hunt | null> {
	const [found] = await exec
		.select(columns)
		.from(hunt)
		.where(and(eq(hunt.id, id), eq(hunt.userId, owner)));
	return found ?? null;
}

/**
 * Replaces the Hunt's editable settings. Records which ones changed; an edit that changes
 * nothing writes nothing. Null when the owner has no such Hunt; a ZodError for invalid input.
 */
export async function updateHunt(exec: Executor, owner: UserId, id: string, input: HuntInput): Promise<Hunt | null> {
	const values = huntInputSchema.parse(input);
	return exec.transaction(async (tx) => {
		const [current] = await tx
			.select(columns)
			.from(hunt)
			.where(and(eq(hunt.id, id), eq(hunt.userId, owner)))
			.for("update");
		if (!current) return null;
		const changed = EDITABLE_FIELDS.filter((field) => !sameValue(field, current[field], values[field]));
		if (changed.length === 0) return current;
		const [updated] = await tx
			.update(hunt)
			.set({ ...values, updatedAt: new Date() })
			.where(and(eq(hunt.id, id), eq(hunt.userId, owner)))
			.returning(columns);
		if (!updated) throw new Error("the Hunt was not updated");
		await appendEvent(tx, owner, huntEdited, id, { changed });
		return updated;
	});
}

function sameValue(field: (typeof EDITABLE_FIELDS)[number], stored: unknown, next: unknown): boolean {
	// jsonb reorders object keys, so stored criteria go through the schema again to compare like with like.
	if (field === "criteria") return JSON.stringify(huntCriteriaSchema.parse(stored)) === JSON.stringify(next);
	return stored === next;
}

/**
 * Pauses or resumes the Hunt, writing `hunt_paused` or `hunt_resumed` with the change.
 * Setting the status it already has changes nothing and writes no event. Null when the owner has no such Hunt.
 */
export async function setHuntStatus(
	exec: Executor,
	owner: UserId,
	id: string,
	status: HuntStatus,
): Promise<Hunt | null> {
	return exec.transaction(async (tx) => {
		const [changed] = await tx
			.update(hunt)
			.set({ status, updatedAt: new Date() })
			.where(and(eq(hunt.id, id), eq(hunt.userId, owner), ne(hunt.status, status)))
			.returning(columns);
		if (!changed) return getHunt(tx, owner, id);
		await appendEvent(tx, owner, status === "PAUSED" ? huntPaused : huntResumed, id, {});
		return changed;
	});
}
