import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { candidateFact } from "./schema";

export const CONTACT_IDENTITY = ["name", "email"] as const;
export type ContactIdentityKind = (typeof CONTACT_IDENTITY)[number];

/**
 * The contact identity (name and email, #21) the Candidate's Knowledge Base still lacks.
 * Preparation waits under a contact-identity Hold until this is empty (§8).
 */
export async function missingContactIdentity(exec: Executor, owner: UserId): Promise<ContactIdentityKind[]> {
	const rows = await exec
		.selectDistinct({ kind: candidateFact.kind })
		.from(candidateFact)
		.where(
			and(
				eq(candidateFact.userId, owner),
				isNull(candidateFact.entryId),
				isNull(candidateFact.deletedAt),
				isNull(candidateFact.supersededBy),
				inArray(candidateFact.kind, [...CONTACT_IDENTITY]),
			),
		);
	const present = new Set(rows.map((row) => row.kind));
	return CONTACT_IDENTITY.filter((kind) => !present.has(kind));
}
