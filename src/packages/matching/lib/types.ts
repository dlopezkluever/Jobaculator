import type { Tier } from "../../hunts/criteria";

/**
 * Where an Opportunity attribute comes from (§7, #14): `stated` by the Source or quoted
 * verbatim from the posting, `inferred` by extraction without such a quote, or `unknown`.
 * Inferred values feed Fit but never exclude alone; unknown is never unacceptable.
 */
export const PROVENANCES = ["stated", "inferred", "unknown"] as const;
export type Provenance = (typeof PROVENANCES)[number];

export type Attribute<T> = { value: T | null; provenance: Provenance; quote?: string };

/** USD per year; one end may be missing. */
export type Pay = { min: number | null; max: number | null };

export const SENIORITIES = [
	"INTERN",
	"ENTRY",
	"MID",
	"SENIOR",
	"STAFF",
	"PRINCIPAL",
	"MANAGER",
	"DIRECTOR",
	"EXECUTIVE",
] as const;
export type Seniority = (typeof SENIORITIES)[number];

export const WORKPLACES = ["ONSITE", "HYBRID", "REMOTE"] as const;
export type Workplace = (typeof WORKPLACES)[number];

/** The Hunt-independent attributes a Match is judged on, each with its provenance. */
export type Attributes = {
	pay: Attribute<Pay>;
	seniority: Attribute<Seniority>;
	workplace: Attribute<Workplace>;
	/** Genuinely required years of experience; preferred years are not requirements. */
	requiredYears: Attribute<number>;
};

export const MATCH_STATUSES = ["PENDING", "QUALIFIED", "DISQUALIFIED"] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const DECISIONS = ["SKIP", "AUTO_APPLY", "REVIEW"] as const;
export type Decision = (typeof DECISIONS)[number];

/** The one decisive reason a decision shows. Explicit Hunt exclusions come first, then qualification. */
export const DECISIVE_REASONS = [
	"role_unacceptable",
	"location_unacceptable",
	"pay_below_floor",
	"experience_beyond_stretch",
	"auto_policy",
] as const;
export type DecisiveReason = (typeof DECISIVE_REASONS)[number];

export const DIMENSIONS = ["role", "location", "pay", "experience"] as const;
export type DimensionName = (typeof DIMENSIONS)[number];

/** How one dimension was judged. `score` is its fixed tier score in Fit; null when it is not part of Fit. */
export type DimensionJudgement = {
	dimension: DimensionName;
	/** Null: unknown (Fit counts it as a neutral Acceptable) or, for experience, not a tier. */
	tier: Tier | null;
	provenance: Provenance;
	score: number | null;
	/** Whether this dimension alone rules the Match out. */
	excludes: boolean;
	/** For display: what was compared, such as the matched Hunt phrase or the required years. */
	detail: string;
};

export type Judgement = {
	qualified: boolean;
	fit: number;
	decision: Decision;
	reason: DecisiveReason;
	dimensions: DimensionJudgement[];
};
