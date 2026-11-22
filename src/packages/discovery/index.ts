// Discovery (§6, #13, ADR 0007): watches Boards per User, independent of Hunts, and keeps
// every publicly listed posting as a deduplicated Opportunity with its Sightings. Adapters
// only fetch and translate; this module owns normalization, identity, persistence and events,
// and is the only writer of watched Boards, Opportunities, their aliases and Sightings.

export {
	type Adapters,
	type BoardSeed,
	type DiscoverOutcome,
	discover,
	dueBoards,
	type Ingested,
	type IngestOutcome,
	type IngestRequest,
	ingest,
	POLL_INTERVAL_MS,
	watchBoards,
} from "./lib/discover";
export {
	OPPORTUNITY_SUBJECT,
	postingChanged,
	postingClosed,
	postingDiscovered,
	postingReopened,
	postingSighted,
} from "./lib/events";
export { createGreenhouseAdapter } from "./lib/greenhouse";
export { createSourceHttp, type FetchLike, type SourceHttp, type SourceHttpOptions, USER_AGENT } from "./lib/http";
export { canonicalUrl, sanitizedMarkdown } from "./lib/normalize";
export {
	type BoardHealth,
	getOpportunity,
	listOpportunities,
	listWatchedBoards,
	type OpportunityContent,
	type OpportunitySummary,
} from "./lib/read";
export { type PostingSnapshot, PostingUnavailable, readPostingSnapshot } from "./lib/snapshot";
export {
	type BoardListing,
	type BoardRef,
	type Gone,
	type ListingFailure,
	type ListingFailureKind,
	type PostingRef,
	SOURCES,
	type SourceAdapter,
	type SourceKind,
	type SourcePosting,
	sourcePostingSchema,
} from "./lib/types";
