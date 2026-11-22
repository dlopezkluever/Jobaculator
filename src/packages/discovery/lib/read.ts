import { and, asc, count, desc, eq } from "drizzle-orm";
import type { Executor } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { opportunity, sighting, watchedBoard } from "./schema";

export type OpportunitySummary = {
	id: string;
	status: "OPEN" | "CLOSED";
	title: string;
	employerName: string;
	locationText: string | null;
	workplaceType: "ONSITE" | "HYBRID" | "REMOTE" | null;
	url: string;
	/** Null: unknown age. */
	postedAt: Date | null;
	firstSeenAt: Date;
	sightings: number;
};

/** The owner's Opportunities, most recently discovered first. */
export async function listOpportunities(exec: Executor, owner: UserId): Promise<OpportunitySummary[]> {
	return exec
		.select({
			id: opportunity.id,
			status: opportunity.status,
			title: opportunity.title,
			employerName: opportunity.employerName,
			locationText: opportunity.locationText,
			workplaceType: opportunity.workplaceType,
			url: opportunity.canonicalUrl,
			postedAt: opportunity.postedAt,
			firstSeenAt: opportunity.firstSeenAt,
			sightings: count(sighting.id),
		})
		.from(opportunity)
		.leftJoin(sighting, and(eq(sighting.opportunityId, opportunity.id), eq(sighting.userId, owner)))
		.where(eq(opportunity.userId, owner))
		.groupBy(opportunity.id)
		.orderBy(desc(opportunity.firstSeenAt), asc(opportunity.title), asc(opportunity.id));
}

/** One Opportunity's normalized content, as matching reads it (§6, §7). */
export type OpportunityContent = {
	id: string;
	status: "OPEN" | "CLOSED";
	title: string;
	employerName: string;
	locationText: string | null;
	workplaceType: "ONSITE" | "HYBRID" | "REMOTE" | null;
	employmentType: string | null;
	salary: { min: number | null; max: number | null; currency: string } | null;
	descriptionMarkdown: string | null;
};

/** One of the owner's Opportunities, or null when it does not exist or belongs to another User. */
export async function getOpportunity(exec: Executor, owner: UserId, id: string): Promise<OpportunityContent | null> {
	const [found] = await exec
		.select({
			id: opportunity.id,
			status: opportunity.status,
			title: opportunity.title,
			employerName: opportunity.employerName,
			locationText: opportunity.locationText,
			workplaceType: opportunity.workplaceType,
			employmentType: opportunity.employmentType,
			salary: opportunity.salary,
			descriptionMarkdown: opportunity.descriptionMarkdown,
		})
		.from(opportunity)
		.where(and(eq(opportunity.id, id), eq(opportunity.userId, owner)));
	return found ?? null;
}

export type BoardHealth = {
	id: string;
	source: string;
	token: string;
	employerName: string;
	lastListedAt: Date | null;
	lastFailure: string | null;
	consecutiveFailures: number;
	goneAt: Date | null;
	nextPollAt: Date | null;
};

/** The owner's watched Boards with their health (§6, §15). */
export async function listWatchedBoards(exec: Executor, owner: UserId): Promise<BoardHealth[]> {
	return exec
		.select({
			id: watchedBoard.id,
			source: watchedBoard.source,
			token: watchedBoard.token,
			employerName: watchedBoard.employerName,
			lastListedAt: watchedBoard.lastListedAt,
			lastFailure: watchedBoard.lastFailure,
			consecutiveFailures: watchedBoard.consecutiveFailures,
			goneAt: watchedBoard.goneAt,
			nextPollAt: watchedBoard.nextPollAt,
		})
		.from(watchedBoard)
		.where(eq(watchedBoard.userId, owner))
		.orderBy(asc(watchedBoard.employerName), asc(watchedBoard.id));
}
