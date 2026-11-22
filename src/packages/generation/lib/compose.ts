import type { CandidateContext, ContextFact } from "../../candidate/index";
import type { Bullet, Claim, ResumeDocument, ResumeOutput } from "./types";

/** Every fact id that belongs to the Candidate, including ones the context budget left out. */
export function knownFactIds(context: CandidateContext): Set<string> {
	return new Set([
		...context.facts.map((f) => f.id),
		...context.entries.flatMap((e) => e.facts.map((f) => f.id)),
		...context.authoritativeFacts.map((f) => f.id),
		...context.budget.omittedFactIds,
	]);
}

/**
 * The one value of a kind, or null when there is none or its Facts contradict each other:
 * generation uses only what contradicting claims agree on (#10), and never chooses between them.
 */
function single(facts: readonly ContextFact[], kind: string): string | null {
	const found = facts.filter((f) => f.kind === kind);
	if (found.length === 0 || found.some((f) => (f.conflictsWith?.length ?? 0) > 0)) return null;
	return found[0]?.value ?? null;
}
const all = (facts: readonly ContextFact[], kind: string) => facts.filter((f) => f.kind === kind).map((f) => f.value);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2021-03" → "Mar 2021", "2021" stays, "present" → "Present". Precision is never invented. */
export function formatDate(value: string | null): string | null {
	if (value === null) return null;
	if (value === "present") return "Present";
	const [year, month] = value.split("-");
	const name = month ? MONTHS[Number(month) - 1] : undefined;
	return name ? `${name} ${year}` : (year ?? value);
}

/**
 * Builds the resume from the Facts and the model's output (#16). Code writes identity,
 * employers, titles, dates, schools, degrees, certifications and contact; the model's
 * summary, skills and bullets are kept only when every fact id they cite belongs to the
 * Candidate (citation integrity). An invalid citation drops that one claim, nothing else.
 */
export function composeResume(
	context: CandidateContext,
	output: ResumeOutput,
): { document: ResumeDocument; droppedClaims: number } {
	const known = knownFactIds(context);
	let droppedClaims = 0;
	const valid = (claim: Claim) => {
		const ok = claim.cites.length > 0 && claim.cites.every((id) => known.has(id)) && claim.text.trim().length > 0;
		if (!ok) droppedClaims++;
		return ok;
	};
	const clean = (claim: Claim): Claim => ({ text: claim.text.trim(), cites: [...new Set(claim.cites)] });

	const name = single(context.facts, "name");
	const email = single(context.facts, "email");
	// The contact-identity Hold keeps preparation from starting without both (#21).
	if (!name || !email) throw new Error("the Candidate's contact identity is missing");

	const bulletsByEntry = new Map<string, Bullet[]>();
	const entryKinds = new Map(context.entries.map((e) => [e.id, e.kind]));
	for (const group of output.entries) {
		const kind = entryKinds.get(group.entryId);
		const placeable = kind === "role" || kind === "project" || kind === "education";
		for (const bullet of group.bullets) {
			// A bullet for an Entry the Candidate does not have, or one a resume has no place for, is a dropped claim.
			if (!placeable) {
				droppedClaims++;
				continue;
			}
			if (!valid(bullet)) continue;
			const priority = Math.min(3, Math.max(1, Math.round(bullet.priority))) as Bullet["priority"];
			const list = bulletsByEntry.get(group.entryId) ?? [];
			list.push({ ...clean(bullet), priority });
			bulletsByEntry.set(group.entryId, list);
		}
	}
	const bullets = (entryId: string) => bulletsByEntry.get(entryId) ?? [];

	const document: ResumeDocument = {
		identity: {
			name,
			email,
			phone: single(context.facts, "phone"),
			location: single(context.facts, "location"),
			links: all(context.facts, "link"),
		},
		summary: output.summary && valid(output.summary) ? clean(output.summary) : null,
		skills: output.skills
			.map((group) => ({ group: group.group.trim(), items: group.items.filter(valid).map(clean) }))
			.filter((group) => group.items.length > 0),
		// Employment and education structure always stays, whatever the model chose to write about.
		experience: context.entries
			.filter((e) => e.kind === "role")
			.map((e) => ({
				entryId: e.id,
				employer: single(e.facts, "employer"),
				title: single(e.facts, "title"),
				location: single(e.facts, "location"),
				start: formatDate(single(e.facts, "start_date")),
				end: formatDate(single(e.facts, "end_date")),
				bullets: bullets(e.id),
			})),
		// A project appears only when the model wrote about it.
		projects: context.entries
			.filter((e) => e.kind === "project" && bullets(e.id).length > 0)
			.map((e) => ({
				entryId: e.id,
				name: single(e.facts, "project_name"),
				links: all(e.facts, "link"),
				bullets: bullets(e.id),
			})),
		education: context.entries
			.filter((e) => e.kind === "education")
			.map((e) => {
				const degree = single(e.facts, "degree");
				const field = single(e.facts, "field_of_study");
				return {
					entryId: e.id,
					school: single(e.facts, "institution"),
					degree: [degree, field].filter(Boolean).join(", ") || null,
					start: formatDate(single(e.facts, "start_date")),
					end: formatDate(single(e.facts, "end_date")),
					bullets: bullets(e.id),
				};
			}),
		certifications: context.entries
			.filter((e) => e.kind === "certification")
			.map((e) => ({
				entryId: e.id,
				name: single(e.facts, "certification"),
				issuer: single(e.facts, "issuer"),
				issued: formatDate(single(e.facts, "issued_date")),
			})),
	};
	return { document, droppedClaims };
}
