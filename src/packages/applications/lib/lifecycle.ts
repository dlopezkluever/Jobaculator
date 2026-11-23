import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { appendEvent, defineEvent } from "../../events/index";
import { application } from "./schema";
import { APPLICATION_STATUSES, APPLICATION_SUBJECT, type ApplicationStatus, TRANSITIONS } from "./types";

export const applicationStatusChanged = defineEvent({
	code: "application_status_changed",
	subject: APPLICATION_SUBJECT,
	payload: z.object({ from: z.enum(APPLICATION_STATUSES), to: z.enum(APPLICATION_STATUSES) }),
});

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
