import { and, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Tx } from "../db/index";
import type { UserId } from "../db/ownership";
import { appendEvent, defineEvent } from "../events/index";

// Holds (§5, glossary): scoped automatic pauses that lift by themselves once the cause clears.
// `pipeline` decides when to raise and lift them; this module records them and their events.

import { hold } from "./lib/schema";
import { HOLD_SCOPES, type HoldScope } from "./lib/types";

export { HOLD_SCOPES, type HoldScope } from "./lib/types";

export const HOLD_SUBJECT = "hold";
export const holdRaised = defineEvent({
	code: "hold_raised",
	subject: HOLD_SUBJECT,
	payload: z.object({ scope: z.enum(HOLD_SCOPES), reason: z.string() }),
});
export const holdLifted = defineEvent({
	code: "hold_lifted",
	subject: HOLD_SUBJECT,
	payload: z.object({ scope: z.enum(HOLD_SCOPES) }),
});

/** Raises the owner's Hold on `scope` unless one is active; true when this call raised it (one event, one notice). */
export async function raiseHold(tx: Tx, owner: UserId, scope: HoldScope, reason: string): Promise<boolean> {
	const [raised] = await tx
		.insert(hold)
		.values({ userId: owner, scope, reason })
		.onConflictDoNothing()
		.returning({ id: hold.id });
	if (!raised) return false;
	await appendEvent(tx, owner, holdRaised, raised.id, { scope, reason });
	return true;
}

/** Lifts the owner's active Hold on `scope`; true when one was active. */
export async function liftHold(tx: Tx, owner: UserId, scope: HoldScope): Promise<boolean> {
	const [lifted] = await tx
		.update(hold)
		.set({ liftedAt: new Date() })
		.where(and(eq(hold.userId, owner), eq(hold.scope, scope), isNull(hold.liftedAt)))
		.returning({ id: hold.id });
	if (!lifted) return false;
	await appendEvent(tx, owner, holdLifted, lifted.id, { scope });
	return true;
}

export type Hold = { id: string; scope: HoldScope; reason: string; raisedAt: Date };

/** The owner's active Holds, oldest first. */
export async function listActiveHolds(exec: Executor, owner: UserId): Promise<Hold[]> {
	return exec
		.select({ id: hold.id, scope: hold.scope, reason: hold.reason, raisedAt: hold.raisedAt })
		.from(hold)
		.where(and(eq(hold.userId, owner), isNull(hold.liftedAt)))
		.orderBy(hold.raisedAt);
}

export async function countActiveHolds(exec: Executor, owner: UserId): Promise<number> {
	const [row] = await exec
		.select({ n: count() })
		.from(hold)
		.where(and(eq(hold.userId, owner), isNull(hold.liftedAt)));
	return row?.n ?? 0;
}

/** Every User under an active Hold on `scope`: the dispatcher leaves their work waiting. */
export async function heldUsers(exec: Executor, scope: HoldScope): Promise<UserId[]> {
	const rows = await exec
		.select({ userId: hold.userId })
		.from(hold)
		.where(and(eq(hold.scope, scope), isNull(hold.liftedAt)));
	return rows.map((row) => row.userId as UserId);
}
