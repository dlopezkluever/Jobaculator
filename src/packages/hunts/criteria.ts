import { z } from "zod";

/**
 * The shape of a Hunt's structured criteria (§7, ticket #14). Pure Zod with no database
 * code, so the SPA validates the same shape the API and the `hunts` module enforce.
 */

export const TIERS = ["ideal", "good", "acceptable", "unacceptable"] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_LABELS: Record<Tier, string> = {
	ideal: "Ideal",
	good: "Good",
	acceptable: "Acceptable",
	unacceptable: "Unacceptable",
};

/** PRD §12. Literal → Maximum Persuasive; Authoritative Facts stay locked at every level. */
export const CREATIVE_LATITUDES = ["LITERAL", "CONSERVATIVE", "AGGRESSIVE", "MAXIMUM"] as const;
export type CreativeLatitude = (typeof CREATIVE_LATITUDES)[number];
/** Ticket #16: aggressive Creative Latitude by default. */
export const DEFAULT_CREATIVE_LATITUDE: CreativeLatitude = "AGGRESSIVE";

/** AUTO submits every qualified, acceptable Match. Opt-in Review rules arrive with Tracer Bullet 3. */
export const SUBMISSION_POLICIES = ["AUTO"] as const;
export type SubmissionPolicy = (typeof SUBMISSION_POLICIES)[number];

/** Used when a Hunt sets no override: a posting's genuinely required years may be up to 2× the Candidate's. */
/**
 * Whether a Browser Run submits (§5). Effective mode = the Candidate's choice for one run >
 * the Driving Hunt's > the global setting; the agent never picks live itself. Dry Run fills
 * everything and stops before submitting.
 */
export const SUBMISSION_MODES = ["DRY_RUN", "LIVE"] as const;
export type SubmissionMode = (typeof SUBMISSION_MODES)[number];

export const DEFAULT_EXPERIENCE_STRETCH = 2;

const phrases = z
	.array(z.string().trim().min(1, "Remove the empty value").max(100, "Keep each value under 100 characters"))
	.max(50, "List at most 50 values per tier");

/** One targeting dimension: values per preference tier, and whether anything unlisted is unacceptable. */
export const targetingSchema = z
	.object({
		ideal: phrases,
		good: phrases,
		acceptable: phrases,
		unacceptable: phrases,
		anythingElseUnacceptable: z.boolean(),
	})
	.superRefine((targeting, ctx) => {
		// A value in two tiers (or twice in one) has no single meaning; matching ignores case.
		const seen = new Map<string, Tier>();
		for (const tier of TIERS) {
			targeting[tier].forEach((value, index) => {
				const key = value.toLowerCase();
				const first = seen.get(key);
				if (first) {
					ctx.addIssue({
						code: "custom",
						path: [tier, index],
						message: `"${value}" is already listed as ${TIER_LABELS[first]}`,
					});
				} else seen.set(key, tier);
			});
		}
		if (targeting.anythingElseUnacceptable && acceptableCount(targeting) === 0) {
			ctx.addIssue({
				code: "custom",
				path: ["anythingElseUnacceptable"],
				message: "List at least one Ideal, Good or Acceptable value, or nothing would be acceptable",
			});
		}
	});
export type Targeting = z.infer<typeof targetingSchema>;

function acceptableCount(targeting: Pick<Targeting, "ideal" | "good" | "acceptable">): number {
	return targeting.ideal.length + targeting.good.length + targeting.acceptable.length;
}

export const huntCriteriaSchema = z.object({
	/** Job titles. A Hunt searches for one kind of role, so it names at least one it would take. */
	roles: targetingSchema.refine((roles) => acceptableCount(roles) > 0, {
		path: ["ideal"],
		message: "List at least one Ideal, Good or Acceptable role",
	}),
	/** Places and arrangements as the Candidate words them, such as "San Francisco" or "Remote US". */
	locations: targetingSchema,
	/** USD per year. Pay below it is UNACCEPTABLE; a posting is rejected only when its whole range is below. */
	payFloor: z.int("Enter a whole number of dollars").min(1, "Enter a positive amount").max(10_000_000).nullable(),
	/** Overrides DEFAULT_EXPERIENCE_STRETCH; null keeps the default. */
	experienceStretch: z.number().min(1, "The stretch is at least 1×").max(5, "The stretch is at most 5×").nullable(),
});
export type HuntCriteria = z.infer<typeof huntCriteriaSchema>;

/** Everything the Candidate sets on a Hunt through the criteria form, for create and edit alike. */
export const huntInputSchema = z.object({
	name: z.string().trim().min(1, "Name the Hunt").max(80, "Keep the name under 80 characters"),
	criteria: huntCriteriaSchema,
	creativeLatitude: z.enum(CREATIVE_LATITUDES).default(DEFAULT_CREATIVE_LATITUDE),
	submissionPolicy: z.enum(SUBMISSION_POLICIES).default("AUTO"),
	/** Null follows the global setting. */
	submissionMode: z.enum(SUBMISSION_MODES).nullable().default(null),
});
export type HuntInput = z.input<typeof huntInputSchema>;

export const HUNT_STATUSES = ["ACTIVE", "PAUSED"] as const;
export type HuntStatus = (typeof HUNT_STATUSES)[number];
