import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptedLlm } from "../../ai/testing";
import type { AnswerPolicy, CandidateContext, ContextFact } from "../../candidate/index";
import type { UserId } from "../../db/ownership";
import { type ApplicationQuestion, createGreenhouseAdapter, createSourceHttp } from "../../discovery/index";
import { type AnswerInput, answerQuestions, type JobSnapshot, type Strategy } from "../index";

// Recorded Greenhouse forms (`questions=true`), translated by the real adapter. They are
// recorded once, beside the adapter's own tests.
const FIXTURES = join(import.meta.dirname, "..", "..", "discovery", "tests", "fixtures");
const NATIVE_IDS = { anthropic: "5456619008", figma: "5426468004", discord: "8945798002" } as const;

async function recordedQuestions(token: keyof typeof NATIVE_IDS): Promise<ApplicationQuestion[]> {
	const fixture = JSON.parse(readFileSync(join(FIXTURES, `greenhouse-questions-${token}.json`), "utf8"));
	const adapter = createGreenhouseAdapter(
		createSourceHttp({
			fetch: async (input) => {
				if (String(input) !== fixture.url) throw new Error(`no route for ${String(input)}`);
				return new Response(JSON.stringify(fixture.body), { status: 200 });
			},
			minIntervalMs: 0,
		}),
	);
	const found = await adapter.fetchQuestions({ board: { source: "greenhouse", token }, nativeId: NATIVE_IDS[token] });
	if (!Array.isArray(found)) throw new Error("no questions");
	return found;
}

const AUTHORITATIVE = ["name", "email", "phone", "employer", "title", "work_authorization", "earliest_start"];
const fact = (id: string, kind: string, value: string): ContextFact => ({
	id,
	kind,
	value,
	provenance: "USER_EXPLICIT",
	authoritative: AUTHORITATIVE.includes(kind),
});

/** A fixture Candidate (§18). */
function candidate(answerPolicies: AnswerPolicy[] = [], extra: ContextFact[] = []): CandidateContext {
	const facts = [
		fact("f-name", "name", "Ada King Lovelace"),
		fact("f-email", "email", "ada@example.com"),
		fact("f-phone", "phone", "(512) 555-0142"),
		fact("f-start", "earliest_start", "2027-01"),
		fact("f-ts", "skill", "TypeScript"),
		...extra,
	];
	const entries: CandidateContext["entries"] = [
		{
			id: "e-acme",
			kind: "role",
			parentId: null,
			facts: [
				fact("f-acme", "employer", "Acme"),
				fact("f-acme-title", "title", "Staff Engineer"),
				fact("f-acme-a1", "accomplishment", "Cut model spend 38% with an LLM gateway"),
			],
		},
	];
	const all = [...facts, ...entries.flatMap((e) => e.facts)];
	return {
		facts,
		entries,
		authoritativeFacts: all
			.filter((f) => f.authoritative)
			.map((f) => ({ ...f, entryId: f.id.startsWith("f-acme") ? "e-acme" : null })),
		baseResume: null,
		answerPolicies,
		budget: { limitTokens: 60_000, usedTokens: 1_000, omittedFactIds: [] },
	};
}

const strategy: Strategy = {
	themes: [{ theme: "Safe, cost-aware AI", why: "The posting leads with it" }],
	selectedFactIds: { summary: ["f-acme-a1"], experience: ["f-acme-a1"], projects: [], skills: [], coverLetter: [] },
	keywords: [],
	framings: [],
	leadAngle: "Engineer who cut model spend",
	coverLetterAngle: "Cost discipline",
	latitude: "AGGRESSIVE",
};

const snapshot = {
	title: "Engineer",
	employerName: "Anthropic",
	locationText: "San Francisco, CA",
	descriptionMarkdown: "Build safe AI.",
} as JobSnapshot;

const input = (context: CandidateContext, questions: ApplicationQuestion[]): AnswerInput => ({
	context,
	snapshot,
	latitude: "AGGRESSIVE",
	attribution: { userId: "u-1" as UserId },
	strategy,
	hunt: {
		id: "h-1",
		locations: {
			ideal: ["San Francisco"],
			good: [],
			acceptable: [],
			unacceptable: [],
			anythingElseUnacceptable: false,
		},
		payFloor: null,
	},
	questions,
});

type ModelAnswer = { class: string; text?: string | null; choices?: string[]; cites?: string[] };
const answerStep = (answers: Record<string, ModelAnswer>) => ({
	task: "answer" as const,
	output: {
		answers: Object.entries(answers).map(([questionId, a]) => ({
			questionId,
			class: a.class,
			text: a.text ?? null,
			choices: a.choices ?? [],
			cites: a.cites ?? [],
		})),
	},
});

/** The questions the model was asked, by id. */
function asked(llm: ReturnType<typeof createScriptedLlm>): string[] {
	const call = llm.calls[0];
	if (call?.method !== "generate") return [];
	const content = String(call.request.messages[0]?.content);
	const questions = content.slice(content.indexOf("<questions>") + 12, content.indexOf("</questions>"));
	return (JSON.parse(questions) as { questionId: string }[]).map((q) => q.questionId);
}

describe("answerQuestions", () => {
	it("answers identity, start date and EEO by code, the rest in one call, and escalates only a required gap", async () => {
		const questions = await recordedQuestions("anthropic");
		const llm = createScriptedLlm([
			answerStep({
				question_19018739008: { class: "PREFERENCE", choices: ["Yes"] },
				question_19018742008: { class: "PREFERENCE", choices: ["Yes"] },
				question_19018743008: {
					class: "PERSUASIVE",
					text: "I cut model spend 38% with an LLM gateway and want to do that for safe AI.",
					cites: ["f-acme-a1"],
				},
				// No Fact or Policy states sponsorship: an AUTHORITATIVE question gets no answer.
				question_19018744008: { class: "AUTHORITATIVE", choices: [] },
				// An AUTHORITATIVE answer that rests on no authority is dropped, not trusted.
				question_19018745008: { class: "AUTHORITATIVE", choices: ["No"], cites: ["f-ts"] },
				// Relocation commits to the Hunt's own targeting.
				question_19018748008: { class: "AUTHORITATIVE", choices: ["Yes"], cites: ["hunt:h-1"] },
				// Inferred from the work history, citing it.
				question_19018750008: { class: "INFERABLE", choices: ["No"], cites: ["f-acme"] },
				// Another Candidate's fact: citation integrity drops it.
				question_19018751008: {
					class: "PREFERENCE",
					choices: ["I will read the arbitration agreement below."],
					cites: ["f-someone-else"],
				},
				question_19018752008: { class: "PREFERENCE", choices: ["A choice the form does not offer"] },
				// Optional and unknown: stays blank.
				question_19018738008: { class: "UNKNOWN" },
			}),
		]);
		const result = await answerQuestions(llm, input(candidate(), questions));
		expect(llm.remaining()).toBe(0);
		const by = new Map(result.answers.map((a) => [a.question.id, a]));

		// Code answered these: the model never saw them.
		const modelSaw = asked(llm);
		for (const id of ["first_name", "last_name", "email", "phone", "question_19018740008", "race", "gender"]) {
			expect(modelSaw).not.toContain(id);
		}
		// File uploads are the Package's documents, not answers.
		expect(by.has("resume")).toBe(false);
		expect(by.get("first_name")).toMatchObject({
			text: "Ada",
			sources: ["f-name"],
			via: "FACT",
			class: "AUTHORITATIVE",
		});
		expect(by.get("last_name")).toMatchObject({ text: "King Lovelace", sources: ["f-name"] });
		expect(by.get("phone")).toMatchObject({ text: "(512) 555-0142", sources: ["f-phone"] });
		expect(by.get("question_19018740008")).toMatchObject({ text: "2027-01", sources: ["f-start"], via: "FACT" });

		// EEO: the decline choice, never the first option (which for veteran status is also decline).
		expect(by.get("race")).toMatchObject({ choices: ["Decline To Self Identify"], via: "DECLINE" });
		expect(by.get("gender")).toMatchObject({ choices: ["Decline To Self Identify"], via: "DECLINE" });
		expect(by.get("veteran_status")).toMatchObject({ choices: ["I don't wish to answer"], via: "DECLINE" });

		expect(by.get("question_19018743008")).toMatchObject({ class: "PERSUASIVE", via: "MODEL", sources: ["f-acme-a1"] });
		expect(by.get("question_19018748008")).toMatchObject({ choices: ["Yes"], sources: ["hunt:h-1"] });
		expect(by.get("question_19018750008")).toMatchObject({ choices: ["No"], class: "INFERABLE" });
		expect(result.droppedAnswers).toBe(3);

		// Narrow escalation: only required questions left blank, never optional ones.
		const escalated = result.answers.filter((a) => a.escalation).map((a) => [a.question.id, a.escalation]);
		expect(escalated).toEqual([
			["question_19018744008", "AUTHORITATIVE_FACT_REQUIRED"],
			["question_19018745008", "AUTHORITATIVE_FACT_REQUIRED"],
			["question_19018751008", "AUTHORITATIVE_FACT_REQUIRED"],
			["question_19018752008", "AUTHORITATIVE_FACT_REQUIRED"],
		]);
		expect(by.get("question_19018738008")).toMatchObject({ text: null, choices: [], escalation: null });
		expect(result.callId).not.toBeNull();
	});

	it("uses Answer Policies, lets an Authoritative Fact win over a conflicting one, and declines a flagged survey", async () => {
		const policies: AnswerPolicy[] = [
			{ id: "p-sponsor", topic: "sponsorship", answer: "No" },
			{ id: "p-auth", topic: "work_authorization", answer: "No" },
			{ id: "p-gender", topic: "gender", answer: "Female" },
			// Declining by Policy: the decline choice, wherever the form lists it.
			{ id: "p-race", topic: "race", answer: null },
		];
		const context = candidate(policies, [fact("f-auth", "work_authorization", "Yes")]);

		const figma = await recordedQuestions("figma");
		const figmaLlm = createScriptedLlm([{ task: "answer", output: { answers: [] } }]);
		const figmaAnswers = new Map(
			(await answerQuestions(figmaLlm, input(context, figma))).answers.map((a) => [a.question.id, a]),
		);
		// The Fact says Yes; the conflicting Policy says No. Authoritative reality wins.
		expect(figmaAnswers.get("question_12497125004")).toMatchObject({
			choices: ["Yes"],
			sources: ["f-auth"],
			via: "FACT",
		});
		expect(figmaAnswers.get("gender")).toMatchObject({ choices: ["Female"], sources: ["p-gender"], via: "POLICY" });
		// Pronouns: self-identification with no decline choice and no Policy stays blank (it is optional).
		expect(figmaAnswers.get("question_12497121004")).toMatchObject({ choices: [], via: null, escalation: null });
		expect(asked(figmaLlm)).not.toContain("question_12497121004");

		const anthropic = await recordedQuestions("anthropic");
		const anthropicAnswers = new Map(
			(
				await answerQuestions(
					createScriptedLlm([{ task: "answer", output: { answers: [] } }]),
					input(context, anthropic),
				)
			).answers.map((a) => [a.question.id, a]),
		);
		for (const id of ["question_19018744008", "question_19018745008"]) {
			expect(anthropicAnswers.get(id)).toMatchObject({ choices: ["No"], sources: ["p-sponsor"], via: "POLICY" });
		}

		// Discord's survey is required and lists decline second: the flagged decline, never the first option.
		const discord = await recordedQuestions("discord");
		const discordAnswers = (
			await answerQuestions(createScriptedLlm([{ task: "answer", output: { answers: [] } }]), input(context, discord))
		).answers.filter((a) => a.question.section === "eeo");
		const race = discordAnswers.find((a) => a.question.label === "Race and Ethnicity");
		expect(race).toMatchObject({
			choices: ["I don't wish to answer"],
			sources: ["p-race"],
			via: "DECLINE",
			escalation: null,
		});
		expect(discordAnswers.find((a) => a.question.label === "Gender")).toMatchObject({ choices: ["Female"] });
		expect(discordAnswers.every((a) => a.escalation === null && a.choices.length === 1)).toBe(true);
	});

	it("makes no model call when code answers every question, and never takes a demographic answer from the model", async () => {
		const eeo = (await recordedQuestions("anthropic")).filter((q) => q.section === "eeo" || q.id === "email");
		const none = createScriptedLlm([]);
		const result = await answerQuestions(none, input(candidate(), eeo));
		expect(none.calls).toHaveLength(0);
		expect(result.callId).toBeNull();
		expect(result.answers.every((a) => a.via === "DECLINE" || a.via === "FACT")).toBe(true);

		// A disclosure question code did not recognise: the model's pick is replaced by a decline.
		const disguised: ApplicationQuestion = {
			id: "question_1",
			label: "Tell us about yourself (voluntary)",
			description: null,
			required: false,
			type: "single_select",
			options: [
				{ label: "Option A", value: "1", decline: false },
				{ label: "Prefer not to say", value: "2", decline: false },
			],
			section: "application",
		};
		const llm = createScriptedLlm([
			answerStep({ question_1: { class: "OPTIONAL_DISCLOSURE", choices: ["Option A"] } }),
		]);
		const [answer] = (await answerQuestions(llm, input(candidate(), [disguised]))).answers;
		expect(answer).toMatchObject({ choices: ["Prefer not to say"], via: "DECLINE" });

		// A real assessment is never answered and asks the Candidate.
		const assessment = { ...disguised, id: "question_2", required: true, type: "textarea" as const, options: [] };
		const assessed = createScriptedLlm([answerStep({ question_2: { class: "ASSESSMENT", text: "my solution" } })]);
		const [graded] = (await answerQuestions(assessed, input(candidate(), [assessment]))).answers;
		expect(graded).toMatchObject({ text: null, escalation: "ASSESSMENT_REQUIRED" });
	});
});
