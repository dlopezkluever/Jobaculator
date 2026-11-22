import { DEFAULT_EXPERIENCE_STRETCH, type HuntCriteria, type Targeting, type Tier } from "../../hunts/criteria";
import type {
	Attributes,
	DecisiveReason,
	DimensionJudgement,
	DimensionName,
	Judgement,
	Provenance,
	Workplace,
} from "./types";

// Qualification → Fit → Submission Policy (§7, #14), pure and kept independent:
// Qualification asks whether the Candidate meets the posting's requirements, Fit how much
// this Hunt wants the posting, and the policy what to do about the two.

/** The fixed tier→score mapping. Unknown counts as Acceptable, never Ideal. */
export const TIER_SCORES: Record<Tier, number> = { ideal: 100, good: 80, acceptable: 60, unacceptable: 0 };
/** Fixed weights of the dimensions Fit averages; a dimension the Hunt leaves unconstrained is left out. */
const WEIGHTS = { role: 3, location: 2, pay: 2 } as const;
/** Pay whose midpoint is this far above the floor is Good, a derived tier shown as derived. */
const GOOD_PAY_OVER_FLOOR = 1.25;
const TIER_ORDER: readonly Tier[] = ["ideal", "good", "acceptable", "unacceptable"];
const POSITIVE: readonly Tier[] = ["ideal", "good", "acceptable"];

export type JudgeInput = {
	criteria: HuntCriteria;
	title: string;
	locationText: string | null;
	attributes: Attributes;
	/** The Candidate's years of experience; null when unknown (nothing is held against them). */
	experienceYears: number | null;
};

export function judge(input: JudgeInput): Judgement {
	const dimensions = [
		judgeRole(input.criteria.roles, input.title),
		judgeLocation(input.criteria.locations, input.locationText, input.attributes.workplace),
		judgePay(input.criteria.payFloor, input.attributes.pay),
	].filter((d): d is DimensionJudgement => d !== null);
	const experience = judgeExperience(input);
	dimensions.push(experience);

	const counted = dimensions.filter((d) => d.score !== null);
	const weight = (d: DimensionJudgement) => WEIGHTS[d.dimension as keyof typeof WEIGHTS];
	const total = counted.reduce((sum, d) => sum + weight(d), 0);
	const fit = Math.round(counted.reduce((sum, d) => sum + (d.score ?? 0) * weight(d), 0) / total);
	const qualified = !experience.excludes;

	// One decisive reason: explicit Hunt exclusions take precedence over qualification.
	const excluded = dimensions.find((d) => d.excludes && d.dimension !== "experience");
	const reason: DecisiveReason = excluded
		? EXCLUSION_REASONS[excluded.dimension]
		: qualified
			? "auto_policy"
			: "experience_beyond_stretch";
	return { qualified, fit, decision: reason === "auto_policy" ? "AUTO_APPLY" : "SKIP", reason, dimensions };
}

const EXCLUSION_REASONS: Record<DimensionName, DecisiveReason> = {
	role: "role_unacceptable",
	location: "location_unacceptable",
	pay: "pay_below_floor",
	experience: "experience_beyond_stretch",
};

function dimension(name: DimensionName, tier: Tier | null, provenance: Provenance, detail: string): DimensionJudgement {
	// Only stated values exclude; an inferred Unacceptable still scores 0 in Fit.
	const excludes = tier === "unacceptable" && provenance === "stated";
	return { dimension: name, tier, provenance, score: TIER_SCORES[tier ?? "acceptable"], excludes, detail };
}

/** The Hunt's tier for one text, or null when no listed phrase matches. An explicit Unacceptable wins. */
function tierOf(targeting: Targeting, tokens: ReadonlySet<string>): { tier: Tier; phrase: string } | null {
	const hit = (tier: Tier) =>
		targeting[tier].find((phrase) => {
			const words = [...tokenize(phrase)];
			return words.length > 0 && words.every((word) => tokens.has(word));
		});
	for (const tier of ["unacceptable", ...POSITIVE] as const) {
		const phrase = hit(tier);
		if (phrase !== undefined) return { tier, phrase };
	}
	return null;
}

function judgeRole(roles: Targeting, title: string): DimensionJudgement {
	const found = tierOf(roles, tokenize(title));
	if (found) return dimension("role", found.tier, "stated", `title matches "${found.phrase}"`);
	return roles.anythingElseUnacceptable
		? dimension("role", "unacceptable", "stated", "title matches no listed role, and anything else is unacceptable")
		: dimension("role", "acceptable", "stated", "title matches no listed role");
}

const LOCATION_SEPARATORS = /\s*(?:[|;•\n]|\s\/\s)\s*/;
const NO_LOCATION = /^(n\/?a|tbd|tba|none|-+)?$/i;

/**
 * The best tier among the posting's places, since the Candidate can take the job at any of
 * them. A stated or extracted work arrangement counts as a word of every place ("Remote US").
 * When only an inferred arrangement changes the tier, the dimension is inferred.
 */
function judgeLocation(
	locations: Targeting,
	locationText: string | null,
	workplace: Attributes["workplace"],
): DimensionJudgement | null {
	if (TIER_ORDER.every((tier) => locations[tier].length === 0)) return null; // unconstrained
	const places = (locationText ?? "").split(LOCATION_SEPARATORS).filter((place) => !NO_LOCATION.test(place.trim()));
	if (places.length === 0) return dimension("location", null, "unknown", "the posting states no location");

	const bestOf = (arrangement: Workplace | null) => {
		let best: { tier: Tier; detail: string } | null = null;
		for (const place of places) {
			const tokens = tokenize(arrangement ? `${place} ${arrangement}` : place);
			const found = tierOf(locations, tokens);
			const tier = found?.tier ?? (locations.anythingElseUnacceptable ? "unacceptable" : "acceptable");
			const detail = found ? `"${place}" matches "${found.phrase}"` : `"${place}" matches no listed location`;
			if (!best || TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(best.tier)) best = { tier, detail };
		}
		return best as { tier: Tier; detail: string };
	};
	const stated = bestOf(workplace.provenance === "stated" ? workplace.value : null);
	if (workplace.provenance === "inferred" && workplace.value) {
		const inferred = bestOf(workplace.value);
		if (inferred.tier !== stated.tier) {
			return dimension("location", inferred.tier, "inferred", `${inferred.detail} (${workplace.value} inferred)`);
		}
	}
	return dimension("location", stated.tier, "stated", stated.detail);
}

/**
 * A stated minimum makes pay below it Unacceptable, but a range is rejected only when its
 * highest figure is below the floor. Unknown pay stays eligible. No floor: unconstrained.
 */
function judgePay(payFloor: number | null, pay: Attributes["pay"]): DimensionJudgement | null {
	if (payFloor === null) return null;
	const { value } = pay;
	const top = value?.max ?? value?.min ?? null;
	const bottom = value?.min ?? value?.max ?? null;
	if (top === null || bottom === null) return dimension("pay", null, "unknown", "the posting states no pay");
	const range = `$${bottom.toLocaleString("en-US")}–$${top.toLocaleString("en-US")}`;
	const floor = `$${payFloor.toLocaleString("en-US")}`;
	if (top < payFloor) return dimension("pay", "unacceptable", pay.provenance, `${range} is all below ${floor}`);
	if ((top + bottom) / 2 >= payFloor * GOOD_PAY_OVER_FLOOR) {
		return dimension(
			"pay",
			"good",
			pay.provenance,
			`${range} is well above ${floor} (Good is derived from your floor)`,
		);
	}
	return dimension("pay", "acceptable", pay.provenance, `${range} reaches ${floor}`);
}

/**
 * The experience stretch: a posting may require up to `stretch`× the Candidate's years.
 * Only genuinely required, stated years can disqualify; years are a heuristic, not proof.
 */
function judgeExperience(input: JudgeInput): DimensionJudgement {
	const required = input.attributes.requiredYears;
	const stretch = input.criteria.experienceStretch ?? DEFAULT_EXPERIENCE_STRETCH;
	const years = input.experienceYears;
	const base = { dimension: "experience" as const, tier: null, score: null, provenance: required.provenance };
	if (required.value === null) return { ...base, excludes: false, detail: "the posting requires no stated years" };
	if (years === null) {
		return { ...base, excludes: false, detail: `requires ${required.value} years; your experience has no dates yet` };
	}
	const allowed = Math.round(years * stretch * 10) / 10;
	const beyond = required.value > years * stretch;
	return {
		...base,
		excludes: beyond && required.provenance === "stated",
		detail: beyond
			? `requires ${required.value} years, beyond ${allowed} (${stretch}× your ${years})`
			: `requires ${required.value} years, within ${allowed} (${stretch}× your ${years})`,
	};
}

/** Words that mean the same place or arrangement, folded to one token sequence. */
const ALIASES: [RegExp, string][] = [
	[/\bu\.s\.a?\.?(?=\s|$|[^a-z])/g, " us "],
	[/\bunited states(?: of america)?\b/g, " us "],
	[/\busa\b/g, " us "],
	[/\b(?:nyc|new york city)\b/g, " new york "],
	[/\b(?:sf|san francisco bay area|sf bay area)\b/g, " san francisco "],
	[/\b(?:on-?site|in[- ]office|onsite)\b/g, " onsite "],
];

/** Case-, accent- and punctuation-folded words, for whole-word phrase matching. */
export function tokenize(text: string): Set<string> {
	let folded = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
	for (const [pattern, replacement] of ALIASES) folded = folded.replace(pattern, replacement);
	return new Set(folded.split(/[^\p{L}\p{N}+#]+/u).filter(Boolean));
}
