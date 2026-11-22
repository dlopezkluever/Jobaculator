// Matching (§7, #14): each Hunt's judgement of each Opportunity. A deterministic prefilter on
// stated values, a cached Hunt-independent LLM extraction for survivors, then Qualification,
// Fit and Submission Policy, kept independent. This module is the only writer of Matches and
// Opportunity extractions, and records every decision as a `match_evaluated` event.

export {
	type EvaluationInputs,
	evaluableMatches,
	evaluate,
	getMatch,
	listMatches,
	MATCH_SUBJECT,
	type Match,
	matchEvaluated,
	requestEvaluations,
} from "./lib/evaluate";
export type { OpportunityInput } from "./lib/extract";
export { TIER_SCORES } from "./lib/judge";
export {
	type Attribute,
	type Attributes,
	DECISIONS,
	DECISIVE_REASONS,
	type Decision,
	type DecisiveReason,
	DIMENSIONS,
	type DimensionJudgement,
	type DimensionName,
	MATCH_STATUSES,
	type MatchStatus,
	PROVENANCES,
	type Provenance,
	SENIORITIES,
	type Seniority,
} from "./lib/types";
