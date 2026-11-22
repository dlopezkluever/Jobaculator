import { describe, expect, it } from "vitest";
import type { CandidateContext, ContextFact } from "../../candidate/index";
import { composeResume, MAX_PAGES, type ResumeDocument, type ResumeOutput, renderResume } from "../index";

// A fixture Candidate (#16, §18): what generation may only copy, never write.
const fact = (id: string, kind: string, value: string, extra: Partial<ContextFact> = {}): ContextFact => ({
	id,
	kind,
	value,
	provenance: "USER_EXPLICIT",
	authoritative: ["name", "email", "phone", "employer", "title", "start_date", "end_date", "institution", "degree"]
		.concat(["field_of_study", "certification", "issuer", "issued_date"])
		.includes(kind),
	...extra,
});

function candidate(): CandidateContext {
	const facts = [
		fact("f-name", "name", "Ada Lovelace"),
		fact("f-email", "email", "ada@example.com"),
		fact("f-phone", "phone", "(512) 555-0142"),
		fact("f-loc", "location", "Austin, TX"),
		fact("f-link", "link", "github.com/ada"),
		fact("f-ts", "skill", "TypeScript"),
	];
	const entries: CandidateContext["entries"] = [
		{
			id: "e-acme",
			kind: "role",
			parentId: null,
			facts: [
				fact("f-acme", "employer", "Acme, Inc."),
				fact("f-acme-title", "title", "Staff Engineer"),
				fact("f-acme-start", "start_date", "2021-03"),
				fact("f-acme-end", "end_date", "present"),
				fact("f-acme-a1", "accomplishment", "Cut model spend 38% with an LLM gateway"),
				fact("f-acme-a2", "accomplishment", "Built an eval harness of 2,400 cases"),
			],
		},
		{
			id: "e-globex",
			kind: "role",
			parentId: null,
			facts: [
				fact("f-globex", "employer", "Globex"),
				// Two sources disagree on this title; generation uses only what they agree on (#10).
				fact("f-globex-t1", "title", "Engineer II", { conflictsWith: ["f-globex-t2"] }),
				fact("f-globex-t2", "title", "Senior Engineer", { conflictsWith: ["f-globex-t1"] }),
				fact("f-globex-start", "start_date", "2018"),
				fact("f-globex-end", "end_date", "2021-02"),
				fact("f-globex-a1", "accomplishment", "Owned the scheduling service"),
			],
		},
		{
			id: "e-ut",
			kind: "education",
			parentId: null,
			facts: [
				fact("f-ut", "institution", "The University of Texas at Austin"),
				fact("f-ut-deg", "degree", "B.S."),
				fact("f-ut-field", "field_of_study", "Computer Science"),
				fact("f-ut-end", "end_date", "2018"),
			],
		},
		{
			id: "e-aws",
			kind: "certification",
			parentId: null,
			facts: [
				fact("f-aws", "certification", "AWS Certified Solutions Architect"),
				fact("f-aws-date", "issued_date", "2022-06"),
			],
		},
		{ id: "e-story", kind: "story", parentId: null, facts: [fact("f-story", "story_title", "The outage")] },
	];
	const all = [...facts, ...entries.flatMap((e) => e.facts)];
	return {
		facts,
		entries,
		authoritativeFacts: all.filter((f) => f.authoritative).map((f) => ({ ...f, entryId: null })),
		baseResume: null,
		answerPolicies: [],
		// A fact the context budget left out is still the Candidate's, so citing it is valid.
		budget: { limitTokens: 60_000, usedTokens: 1_000, omittedFactIds: ["f-omitted"] },
	};
}

const bullet = (text: string, cites: string[], priority = 2) => ({ text, cites, priority });

describe("composeResume", () => {
	it("writes identity, employers, titles, dates, education and certifications from the Facts alone", () => {
		// The model's output carries no authoritative field; anything else it sends is ignored.
		const output: ResumeOutput = {
			summary: { text: "Engineer who ships LLM features.", cites: ["f-acme-a1"] },
			skills: [{ group: "Languages", items: [{ text: "TypeScript", cites: ["f-ts"] }] }],
			entries: [
				{ entryId: "e-acme", bullets: [bullet("Cut model spend 38%.", ["f-acme-a1"], 1)] },
				{ entryId: "e-globex", bullets: [bullet("Owned scheduling.", ["f-globex-a1"])] },
			],
		};
		const { document, droppedClaims } = composeResume(candidate(), output);
		expect(droppedClaims).toBe(0);
		expect(document.identity).toEqual({
			name: "Ada Lovelace",
			email: "ada@example.com",
			phone: "(512) 555-0142",
			location: "Austin, TX",
			links: ["github.com/ada"],
		});
		expect(document.experience.map(({ bullets: _, ...e }) => e)).toEqual([
			{
				entryId: "e-acme",
				employer: "Acme, Inc.",
				title: "Staff Engineer",
				location: null,
				start: "Mar 2021",
				end: "Present",
			},
			// The contradicting titles are left out rather than one of them chosen.
			{ entryId: "e-globex", employer: "Globex", title: null, location: null, start: "2018", end: "Feb 2021" },
		]);
		expect(document.education).toEqual([
			{
				entryId: "e-ut",
				school: "The University of Texas at Austin",
				degree: "B.S., Computer Science",
				start: null,
				end: "2018",
				bullets: [],
			},
		]);
		expect(document.certifications).toEqual([
			{ entryId: "e-aws", name: "AWS Certified Solutions Architect", issuer: null, issued: "Jun 2022" },
		]);
	});

	it("drops only the claims whose citations are invalid", () => {
		const output: ResumeOutput = {
			// One unknown id among valid ones invalidates the whole claim.
			summary: { text: "Summary.", cites: ["f-acme-a1", "f-nope"] },
			skills: [
				{
					group: "Languages",
					items: [
						{ text: "TypeScript", cites: ["f-ts"] },
						{ text: "Rust", cites: ["f-rust"] },
					],
				},
				{ group: "Empty after drops", items: [{ text: "Go", cites: [] }] },
			],
			entries: [
				{
					entryId: "e-acme",
					bullets: [
						bullet("Kept.", ["f-acme-a1"], 1),
						bullet("Cites a budget-omitted fact.", ["f-omitted"]),
						bullet("Another Candidate's fact.", ["someone-elses-fact"]),
						bullet("Cites nothing.", [], 3),
					],
				},
				// An Entry the Candidate does not have, and one a resume has no place for.
				{ entryId: "e-invented", bullets: [bullet("Invented role.", ["f-acme-a1"], 1)] },
				{ entryId: "e-story", bullets: [bullet("A story.", ["f-story"], 1)] },
			],
		};
		const { document, droppedClaims } = composeResume(candidate(), output);
		expect(droppedClaims).toBe(7);
		expect(document.summary).toBeNull();
		expect(document.skills).toEqual([{ group: "Languages", items: [{ text: "TypeScript", cites: ["f-ts"] }] }]);
		expect(document.experience[0]?.bullets.map((b) => b.text)).toEqual(["Kept.", "Cites a budget-omitted fact."]);
		// Employment structure stays even for a role the model wrote nothing valid about.
		expect(document.experience.map((e) => e.employer)).toEqual(["Acme, Inc.", "Globex"]);
	});
});

async function pdfText(pdf: Buffer): Promise<string> {
	const { getDocument, VerbosityLevel } = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const doc = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, verbosity: VerbosityLevel.ERRORS })
		.promise;
	let text = "";
	for (let page = 1; page <= doc.numPages; page++) {
		for (const item of (await (await doc.getPage(page)).getTextContent()).items) {
			if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
		}
	}
	return text;
}

describe("renderResume", () => {
	it("renders a tagged PDF with the Facts as plain text, never as Typst markup", async () => {
		const { document } = composeResume(candidate(), {
			summary: { text: "Ships #features with $math$ and *stars*.", cites: ["f-acme-a1"] },
			skills: [],
			entries: [{ entryId: "e-acme", bullets: [bullet("Cut model spend 38%.", ["f-acme-a1"], 1)] }],
		});
		const rendered = renderResume("modern", document);
		expect(rendered).toMatchObject({ pages: 1, trimmedBullets: 0 });
		expect(rendered.pdf.subarray(0, 5).toString()).toBe("%PDF-");
		expect(rendered.pdf.toString("latin1")).toContain("/StructTreeRoot");
		const text = await pdfText(rendered.pdf);
		for (const value of ["Ada Lovelace", "ada@example.com", "Acme, Inc.", "Staff Engineer", "Mar 2021 – Present"]) {
			expect(text).toContain(value);
		}
		expect(text).toContain("Ships #features with $math$ and *stars*.");
		// Deterministic: Review edits re-render to the same bytes (#16).
		expect(renderResume("modern", document).pdf.equals(rendered.pdf)).toBe(true);
	});

	it("trims lowest-priority bullets to fit two pages, keeping every entry and its top accomplishment", async () => {
		const roles: ResumeDocument["experience"] = Array.from({ length: 14 }, (_, i) => ({
			entryId: `e${i}`,
			employer: `Employer ${i}`,
			title: "Engineer",
			location: null,
			start: "2015",
			end: "2016",
			bullets: Array.from({ length: 7 }, (_, j) => ({
				text: `${j === 0 ? "TOP" : "Detail"} ${i}.${j}: shipped a long-running piece of work that took many words to describe in full.`,
				cites: ["f"],
				priority: j === 0 ? 1 : j < 3 ? 2 : 3,
			})),
		}));
		const document: ResumeDocument = {
			identity: { name: "Ada Lovelace", email: "ada@example.com", phone: null, location: null, links: [] },
			summary: null,
			skills: [],
			experience: roles,
			projects: [],
			education: [],
			certifications: [],
		};
		const rendered = renderResume("modern", document);
		expect(rendered.pages).toBeLessThanOrEqual(MAX_PAGES);
		expect(rendered.trimmedBullets).toBeGreaterThan(0);
		const text = await pdfText(rendered.pdf);
		for (let i = 0; i < 14; i++) {
			expect(text).toContain(`Employer ${i}`);
			expect(text).toContain(`TOP ${i}.0`);
		}
		// Priority 3 goes before priority 2: some priority-2 bullet of the newest role survives.
		expect(text).toContain("Detail 0.1");
		expect(text).not.toContain("Detail 13.6");

		// When everything is priority 1, each entry still keeps its first bullet.
		const allTop = structuredClone(document);
		for (const role of allTop.experience) for (const b of role.bullets) b.priority = 1;
		const kept = await pdfText(renderResume("modern", allTop).pdf);
		for (let i = 0; i < 14; i++) expect(kept).toContain(`TOP ${i}.0`);
		expect(kept).not.toContain("Detail 13.6");
	});
});
