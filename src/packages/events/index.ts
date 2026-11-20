import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Executor, Tx } from "../db/index";
import type { UserId } from "../db/ownership";
import { event } from "./lib/schema";

/**
 * One kind of event: its code, the kind of subject it is recorded against (Match,
 * Application, Hunt, Board, ...) and the Zod schema of its payload of reason codes
 * and input ids. Never content or LLM rationale (ADR 0008). Owning modules define
 * their kinds; a code's schema is a contract that only grows.
 */
export type EventType<P extends z.ZodObject = z.ZodObject> = {
	code: string;
	subject: string;
	payload: P;
};

export function defineEvent<P extends z.ZodObject>(type: EventType<P>): EventType<P> {
	return type;
}

/**
 * Appends a validated event in the caller's transaction, so it commits or rolls back
 * with the state change it describes. Takes a transaction, not the database, on purpose.
 */
export async function appendEvent<P extends z.ZodObject>(
	tx: Tx,
	owner: UserId,
	type: EventType<P>,
	subjectId: string,
	payload: z.input<P>,
): Promise<void> {
	await tx.insert(event).values({
		userId: owner,
		subjectType: type.subject,
		subjectId,
		code: type.code,
		payload: type.payload.parse(payload),
	});
}

export type StoredEvent = {
	id: number;
	code: string;
	subjectType: string;
	subjectId: string;
	payload: unknown;
	occurredAt: Date;
};

/** One subject's events for its owner, oldest first: the timeline and explainability record. */
export async function listEvents(
	exec: Executor,
	owner: UserId,
	subject: { type: string; id: string },
): Promise<StoredEvent[]> {
	return exec
		.select({
			id: event.id,
			code: event.code,
			subjectType: event.subjectType,
			subjectId: event.subjectId,
			payload: event.payload,
			occurredAt: event.occurredAt,
		})
		.from(event)
		.where(and(eq(event.userId, owner), eq(event.subjectType, subject.type), eq(event.subjectId, subject.id)))
		.orderBy(asc(event.id));
}
