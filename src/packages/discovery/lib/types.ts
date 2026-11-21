import { z } from "zod";

export const SOURCES = ["greenhouse"] as const;
export type SourceKind = (typeof SOURCES)[number];

/** One Board on one Source, such as Greenhouse `stripe`. */
export type BoardRef = { source: SourceKind; token: string };
export type PostingRef = { board: BoardRef; nativeId: string };

export const LISTING_FAILURES = ["NOT_FOUND", "RATE_LIMITED", "BLOCKED", "TRANSIENT", "MALFORMED"] as const;
export type ListingFailureKind = (typeof LISTING_FAILURES)[number];
/** Why a fetch gave no usable answer. A failure never establishes that a posting closed. */
export type ListingFailure = { failure: ListingFailureKind; detail: string };

export const WORKPLACE_TYPES = ["ONSITE", "HYBRID", "REMOTE"] as const;

/**
 * One posting as the Source states it (§6). Adapters only fetch and translate: no inference,
 * no normalization, no identity. It also travels in `ingest` job payloads, hence a schema.
 */
export const sourcePostingSchema = z.object({
	source: z.enum(SOURCES),
	boardToken: z.string().min(1),
	nativeId: z.string().min(1),
	/** The same-Employer requisition id, where the Source supplies one (Greenhouse `internal_job_id`). */
	requisitionId: z.string().min(1).nullable(),
	/** The posting's public URL as stated; the core canonicalizes it. */
	url: z.url(),
	applyUrl: z.url(),
	title: z.string(),
	/** Null when the Source does not state it; the watched Board's Employer is used then. */
	employerName: z.string().nullable(),
	locationText: z.string().nullable(),
	workplaceType: z.enum(WORKPLACE_TYPES).nullable(),
	employmentType: z.string().nullable(),
	salary: z.object({ min: z.number().nullable(), max: z.number().nullable(), currency: z.string().min(1) }).nullable(),
	/** Only when the adapter declares the Source's first-publication date trustworthy. */
	firstPublishedAt: z.iso.datetime({ offset: true }).nullable(),
	descriptionHtml: z.string().nullable(),
	/** Intentionally unlisted postings are never bulk-ingested. */
	listed: z.boolean(),
	/** The Source's own record of the posting, stored as a blob at ingest. */
	raw: z.json(),
});
export type SourcePosting = z.infer<typeof sourcePostingSchema>;

/** A listing that returned every posting on the Board; only a complete listing may later establish closure. */
export type BoardListing = { complete: true; postings: SourcePosting[] };
export type Gone = { gone: true };

export interface SourceAdapter {
	source: SourceKind;
	/** A Board from a token or a Board URL, or null when the hint is not one of this Source's Boards. No network. */
	resolveBoard(hint: string): BoardRef | null;
	listBoard(board: BoardRef): Promise<BoardListing | ListingFailure>;
	/** One posting's detail (lazy enrichment), or Gone when the Source no longer has it. */
	fetchPosting(ref: PostingRef): Promise<SourcePosting | Gone | ListingFailure>;
}
