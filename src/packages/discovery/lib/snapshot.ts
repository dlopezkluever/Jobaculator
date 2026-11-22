import { and, asc, desc, eq } from "drizzle-orm";
import type { Executor } from "../../db/index";
import type { UserId } from "../../db/ownership";
import type { Adapters } from "./discover";
import { sanitizedMarkdown } from "./normalize";
import { opportunity, sighting, watchedBoard } from "./schema";
import type { ApplicationQuestion, ListingFailure, SourceKind } from "./types";

/**
 * The posting as it reads now, for an Application's Job Snapshot (§13). Read-only: the
 * Opportunity is not changed, so a later posting change never touches a snapshot.
 */
export type PostingSnapshot = {
	opportunityId: string;
	/** The open Sighting the Application applies through. */
	sightingId: string;
	source: string;
	boardToken: string;
	nativeId: string;
	title: string;
	employerName: string;
	locationText: string | null;
	workplaceType: "ONSITE" | "HYBRID" | "REMOTE" | null;
	employmentType: string | null;
	salary: { min: number | null; max: number | null; currency: string } | null;
	url: string;
	applyUrl: string;
	postedAt: string | null;
	/** Sanitized Markdown, never posting HTML (§14). */
	descriptionMarkdown: string | null;
	/** Whether the description came from a detail fetch (lazy enrichment, §6). */
	enriched: boolean;
	capturedAt: string;
};

/** A detail fetch failed for a reason that may pass: try again later. */
export class PostingUnavailable extends Error {
	override name = "PostingUnavailable";
	constructor(readonly failure: ListingFailure) {
		super(`the posting could not be fetched: ${failure.failure}`);
	}
}

/**
 * Reads the Opportunity through its best open Sighting, the most recently seen one. When the
 * listing gave no description, fetches the posting's detail (lazy enrichment, §6). Null when
 * the Opportunity has no open Sighting, or the Source says the posting is gone. Throws
 * `PostingUnavailable` when the detail fetch fails for a passing reason.
 */
export async function readPostingSnapshot(
	exec: Executor,
	adapters: Adapters,
	owner: UserId,
	opportunityId: string,
	now = new Date(),
): Promise<PostingSnapshot | null> {
	const [row] = await exec
		.select({
			opportunity,
			sightingId: sighting.id,
			nativeId: sighting.nativeId,
			url: sighting.url,
			applyUrl: sighting.applyUrl,
			source: watchedBoard.source,
			token: watchedBoard.token,
		})
		.from(opportunity)
		.innerJoin(sighting, and(eq(sighting.opportunityId, opportunity.id), eq(sighting.userId, opportunity.userId)))
		.innerJoin(watchedBoard, and(eq(watchedBoard.id, sighting.boardId), eq(watchedBoard.userId, sighting.userId)))
		.where(and(eq(opportunity.id, opportunityId), eq(opportunity.userId, owner), eq(sighting.status, "OPEN")))
		.orderBy(desc(sighting.lastSeenAt), asc(sighting.firstSeenAt), asc(sighting.id))
		.limit(1);
	if (row?.opportunity.status !== "OPEN") return null;
	const o = row.opportunity;

	let descriptionMarkdown = o.descriptionMarkdown;
	let enriched = false;
	if (!descriptionMarkdown) {
		const adapter = adapters[row.source];
		if (!adapter) throw new Error(`no adapter for Source ${row.source}`);
		const detail = await adapter.fetchPosting({
			board: { source: row.source, token: row.token },
			nativeId: row.nativeId,
		});
		if ("gone" in detail) return null;
		if ("failure" in detail) throw new PostingUnavailable(detail);
		descriptionMarkdown = detail.descriptionHtml ? sanitizedMarkdown(detail.descriptionHtml) || null : null;
		enriched = true;
	}

	return {
		opportunityId: o.id,
		sightingId: row.sightingId,
		source: row.source,
		boardToken: row.token,
		nativeId: row.nativeId,
		title: o.title,
		employerName: o.employerName,
		locationText: o.locationText,
		workplaceType: o.workplaceType,
		employmentType: o.employmentType,
		salary: o.salary,
		url: row.url,
		applyUrl: row.applyUrl,
		postedAt: o.postedAt?.toISOString() ?? null,
		descriptionMarkdown,
		enriched,
		capturedAt: now.toISOString(),
	};
}

/**
 * The application questions of the posting a Job Snapshot read (§9), from its Source's
 * public schema. Null when the Source says the posting is gone; throws `PostingUnavailable`
 * when the fetch fails for a reason that may pass.
 */
export async function readApplicationQuestions(
	adapters: Adapters,
	snapshot: Pick<PostingSnapshot, "source" | "boardToken" | "nativeId">,
): Promise<ApplicationQuestion[] | null> {
	const adapter = adapters[snapshot.source as SourceKind];
	if (!adapter) throw new Error(`no adapter for Source ${snapshot.source}`);
	const found = await adapter.fetchQuestions({
		board: { source: adapter.source, token: snapshot.boardToken },
		nativeId: snapshot.nativeId,
	});
	if ("gone" in found) return null;
	if ("failure" in found) throw new PostingUnavailable(found);
	return found;
}
