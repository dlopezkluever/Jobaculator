import { z } from "zod";
import type { PostingSnapshot } from "../../discovery/index";
import type { CreativeLatitude } from "../../hunts/criteria";

/**
 * The posting as it read when preparation started (§13): captured once per Application and
 * never overwritten, even if the posting later changes or disappears.
 */
export type JobSnapshot = PostingSnapshot;

const ids = z.array(z.string());

/**
 * What the `strategy` call returns (#16): a writing plan, not an evidence whitelist. No
 * length limits in the schema: code trims, so a long answer never fails the call.
 */
export const strategyOutputSchema = z.object({
	/** The employer's themes, most important first. */
	themes: z.array(z.object({ theme: z.string(), why: z.string() })),
	/** Fact ids chosen for each part of the Package, most important first. */
	selectedFactIds: z.object({ summary: ids, experience: ids, projects: ids, skills: ids, coverLetter: ids }),
	/** Posting keywords, each backed by Facts or marked as a transferable framing with its rationale. */
	keywords: z.array(
		z.object({ keyword: z.string(), factIds: ids, transferable: z.boolean(), rationale: z.string().nullable() }),
	),
	/** How a requirement is met by the Candidate's Facts. */
	framings: z.array(z.object({ requirement: z.string(), factIds: ids, framing: z.string() })),
	/** The resume's lead: what the summary opens with. */
	leadAngle: z.string(),
	coverLetterAngle: z.string(),
});
export type StrategyOutput = z.output<typeof strategyOutputSchema>;

/** The stored Application Strategy: the plan with unknown fact ids removed, and the latitude it was written for. */
export type Strategy = StrategyOutput & { latitude: CreativeLatitude };

const claim = { text: z.string(), cites: ids };

/** What the `write` call returns for the resume (#16): only the persuasive parts, each citing fact ids. */
export const resumeOutputSchema = z.object({
	summary: z.object(claim).nullable(),
	skills: z.array(z.object({ group: z.string(), items: z.array(z.object(claim)) })),
	entries: z.array(
		z.object({
			entryId: z.string(),
			/** `priority` 1 must stay, 3 is the first cut when the resume overflows. */
			bullets: z.array(z.object({ ...claim, priority: z.number() })),
		}),
	),
});
export type ResumeOutput = z.output<typeof resumeOutputSchema>;

/** One generated statement and the Candidate Facts it rests on. */
export type Claim = { text: string; cites: string[] };
export type Bullet = Claim & { priority: 1 | 2 | 3 };

/**
 * The resume as rendered. Code writes identity, employers, titles, dates, schools, degrees,
 * certifications and contact from Candidate Facts; only the summary, skills and bullets are
 * generated, and each of those cites the Facts it rests on.
 */
export type ResumeDocument = {
	identity: { name: string; email: string; phone: string | null; location: string | null; links: string[] };
	summary: Claim | null;
	skills: { group: string; items: Claim[] }[];
	experience: {
		entryId: string;
		employer: string | null;
		title: string | null;
		location: string | null;
		start: string | null;
		end: string | null;
		bullets: Bullet[];
	}[];
	projects: { entryId: string; name: string | null; links: string[]; bullets: Bullet[] }[];
	education: {
		entryId: string;
		school: string | null;
		degree: string | null;
		start: string | null;
		end: string | null;
		bullets: Bullet[];
	}[];
	certifications: { entryId: string; name: string | null; issuer: string | null; issued: string | null }[];
};

/** Resume templates behind the `templateId` seam (#30). Classic and the Candidate's choice come later. */
export const TEMPLATE_IDS = ["modern"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export const DEFAULT_TEMPLATE: TemplateId = "modern";
