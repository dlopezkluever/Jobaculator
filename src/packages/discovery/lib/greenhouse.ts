import { decodeHTML } from "entities";
import { z } from "zod";
import type { SourceHttp } from "./http";
import type { BoardRef, ListingFailure, SourceAdapter, SourcePosting } from "./types";

const API = "https://boards-api.greenhouse.io/v1/boards";
const TOKEN = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
const BOARD_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io", "boards.eu.greenhouse.io"]);

// Only the fields we translate are checked; the whole record is kept as the raw payload.
const jobSchema = z.looseObject({
	id: z.number().int(),
	title: z.string(),
	absolute_url: z.url(),
	company_name: z.string().nullish(),
	location: z.object({ name: z.string().nullish() }).nullish(),
	first_published: z.string().nullish(),
	content: z.string().nullish(),
	metadata: z.array(z.object({ name: z.string(), value: z.unknown() })).nullish(),
	pay_input_ranges: z
		.array(z.object({ min_cents: z.number().nullish(), max_cents: z.number().nullish(), currency_type: z.string() }))
		.nullish(),
});
const listingSchema = z.object({ jobs: z.array(z.unknown()), meta: z.object({ total: z.number().int() }) });

/** A metadata field the employer filled in to state the workplace arrangement, mapped only on an exact value. */
const WORKPLACE_FIELD = /^(location|workplace|work location) type$/i;
const WORKPLACE_VALUES: Record<string, SourcePosting["workplaceType"]> = {
	"on-site": "ONSITE",
	onsite: "ONSITE",
	"in office": "ONSITE",
	hybrid: "HYBRID",
	remote: "REMOTE",
};

function workplaceType(metadata: z.infer<typeof jobSchema>["metadata"]): SourcePosting["workplaceType"] {
	const field = metadata?.find((entry) => WORKPLACE_FIELD.test(entry.name.trim()));
	return typeof field?.value === "string" ? (WORKPLACE_VALUES[field.value.trim().toLowerCase()] ?? null) : null;
}

function toPosting(token: string, record: unknown): SourcePosting | null {
	const parsed = jobSchema.safeParse(record);
	if (!parsed.success) return null;
	const job = parsed.data;
	const published = job.first_published ? new Date(job.first_published) : null;
	const range = job.pay_input_ranges?.[0];
	return {
		source: "greenhouse",
		boardToken: token,
		nativeId: String(job.id),
		// Neither `internal_job_id` nor `requisition_id` proves one vacancy: employers list distinct roles
		// under one ("ML Inference Path" and "Safeguards Evals" share both at Anthropic). Uncertain
		// identity stays distinct (#9), so Greenhouse states no requisition. Both stay in the raw payload.
		requisitionId: null,
		url: job.absolute_url,
		// Greenhouse's application form is on the posting page itself.
		applyUrl: job.absolute_url,
		title: job.title,
		employerName: job.company_name ?? null,
		locationText: job.location?.name ?? null,
		workplaceType: workplaceType(job.metadata),
		employmentType: null,
		salary: range
			? {
					min: range.min_cents == null ? null : range.min_cents / 100,
					max: range.max_cents == null ? null : range.max_cents / 100,
					currency: range.currency_type,
				}
			: null,
		// Greenhouse sets `first_published` once, when the post first goes live: trustworthy.
		firstPublishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
		// The API returns the description HTML entity-encoded; decoding it is a lossless transform.
		descriptionHtml: job.content ? decodeHTML(job.content) : null,
		listed: true,
		raw: record as SourcePosting["raw"],
	};
}

/** Greenhouse's public job-board API (§6). Fetches and translates only. */
export function createGreenhouseAdapter(http: SourceHttp): SourceAdapter {
	return {
		source: "greenhouse",

		resolveBoard(hint) {
			const text = hint.trim();
			if (TOKEN.test(text)) return { source: "greenhouse", token: text.toLowerCase() };
			let url: URL;
			try {
				url = new URL(text);
			} catch {
				return null;
			}
			const [first, second, third] = url.pathname.split("/").filter(Boolean);
			let token: string | undefined | null;
			if (url.hostname === "boards-api.greenhouse.io" && first === "v1" && second === "boards") token = third;
			else if (BOARD_HOSTS.has(url.hostname)) token = first === "embed" ? url.searchParams.get("for") : first;
			return token && TOKEN.test(token) ? { source: "greenhouse", token: token.toLowerCase() } : null;
		},

		async listBoard(board: BoardRef) {
			const response = await http.getJson(`${API}/${encodeURIComponent(board.token)}/jobs?content=true`);
			if ("failure" in response) return response;
			const listing = listingSchema.safeParse(response.body);
			if (!listing.success)
				return { failure: "MALFORMED", detail: "unexpected listing shape" } satisfies ListingFailure;
			// Greenhouse returns every job in one page; anything short of `meta.total` is not a complete listing.
			if (listing.data.jobs.length !== listing.data.meta.total) {
				return { failure: "MALFORMED", detail: "listing is incomplete" } satisfies ListingFailure;
			}
			const postings: SourcePosting[] = [];
			for (const record of listing.data.jobs) {
				const posting = toPosting(board.token, record);
				if (!posting) return { failure: "MALFORMED", detail: "unexpected job shape" } satisfies ListingFailure;
				postings.push(posting);
			}
			return { complete: true, postings };
		},

		async fetchPosting(ref) {
			const url = `${API}/${encodeURIComponent(ref.board.token)}/jobs/${encodeURIComponent(ref.nativeId)}?pay_transparency=true`;
			const response = await http.getJson(url);
			if ("failure" in response) return response.failure === "NOT_FOUND" ? { gone: true } : response;
			return (
				toPosting(ref.board.token, response.body) ??
				({ failure: "MALFORMED", detail: "unexpected job shape" } satisfies ListingFailure)
			);
		},
	};
}
