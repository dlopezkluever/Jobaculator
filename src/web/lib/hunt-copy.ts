import type { CreativeLatitude } from "../../packages/hunts/criteria";

/** PRD §12.3: the control explains each level instead of showing a number. */
export const LATITUDE_COPY: Record<CreativeLatitude, { label: string; description: string }> = {
	LITERAL: {
		label: "Literal",
		description: "Uses only your documented language and facts: reorganizes, shortens and formats.",
	},
	CONSERVATIVE: {
		label: "Conservative",
		description: "Paraphrases and emphasizes, translating your experience into the job's language and keywords.",
	},
	AGGRESSIVE: {
		label: "Aggressive",
		description:
			"Strongly adapts your real experience to each position, including inferred transferable skills and job-specific language.",
	},
	MAXIMUM: {
		label: "Maximum Persuasive",
		description:
			"Makes broad professional inferences and heavily optimizes wording around each posting's requirements.",
	},
};

export const AUTO_POLICY_COPY = {
	label: "Submit automatically",
	description: "Every qualified Match is prepared and submitted without waiting for you.",
};

export function formatPay(dollars: number): string {
	return `$${dollars.toLocaleString("en-US")} / year`;
}
