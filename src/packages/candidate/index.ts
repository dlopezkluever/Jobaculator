import { eq } from "drizzle-orm";
import type { Executor } from "../db/index";
import type { UserId } from "../db/ownership";
import { candidate } from "./lib/schema";

export type Candidate = { id: string; createdAt: Date };

/** Creates the User's Candidate. Called in the same transaction that creates the User (1:1). */
export async function createCandidate(exec: Executor, owner: UserId): Promise<Candidate> {
	const [created] = await exec
		.insert(candidate)
		.values({ userId: owner })
		.returning({ id: candidate.id, createdAt: candidate.createdAt });
	if (!created) throw new Error("the Candidate was not created");
	return created;
}

export async function getCandidate(exec: Executor, owner: UserId): Promise<Candidate | null> {
	const [found] = await exec
		.select({ id: candidate.id, createdAt: candidate.createdAt })
		.from(candidate)
		.where(eq(candidate.userId, owner));
	return found ?? null;
}
