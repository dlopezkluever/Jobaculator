import { z } from "zod";
import type { LlmClient } from "../../ai/index";
import type { AnswerPolicy, CandidateContext, ContextFact, PolicyTopic } from "../../candidate/index";
import type { ApplicationQuestion } from "../../discovery/index";
import type { Targeting } from "../../hunts/criteria";
import { knownFactIds } from "./compose";
import type { Strategy } from "./types";
import { candidateView, type GenerationInput, inputHash, LATITUDE, postingText, RULES } from "./write";

/** PRD §37: what kind of question it is, which decides how it may be answered. */
export const QUESTION_CLASSES = [
	"AUTHORITATIVE",
	"FACTUAL",
	"INFERABLE",
	"PERSUASIVE",
	"PREFERENCE",
	"OPTIONAL_DISCLOSURE",
	"ASSESSMENT",
	"UNKNOWN",
] as const;
export type QuestionClass = (typeof QUESTION_CLASSES)[number];

/** The only two reasons a question asks the Candidate (#16): narrow escalation. */
export type Escalation = "AUTHORITATIVE_FACT_REQUIRED" | "ASSESSMENT_REQUIRED";

/**
 * One Application Answer (§4, #16): the question as the form stated it, the answer, its class
 * and the ids it rests on (Candidate Facts, Answer Policies, or `hunt:<id>` for the Driving
 * Hunt's targeting). A blank answer has no text and no choices.
 */
export type ApplicationAnswer = {
	question: ApplicationQuestion;
	class: QuestionClass;
	/** The answer to a text question. */
	text: string | null;
	/** The chosen option labels of a select, in the form's order. */
	choices: string[];
	sources: string[];
	/** How it was answered: by code from an Answer Policy or Fact, by declining, or by the model; null when blank. */
	via: "POLICY" | "FACT" | "DECLINE" | "MODEL" | null;
	escalation: Escalation | null;
};

/** The Driving Hunt's targeting: the Commitments the Hunt makes for relocation and pay (#10). */
export type HuntCommitments = { id: string; locations: Targeting; payFloor: number | null };

export type AnswerInput = GenerationInput & {
	strategy: Strategy;
	hunt: HuntCommitments;
	questions: readonly ApplicationQuestion[];
};

export type AnsweredQuestions = {
	/** One per question, in the form's order. File uploads are left out: the Package's documents fill them. */
	answers: ApplicationAnswer[];
	/** Model answers dropped for an invalid citation or a choice the form does not offer. */
	droppedAnswers: number;
	/** Null when code answered every question and no model call was made. */
	callId: string | null;
	inputHash: string;
};

// ——— Deterministic answers ———

const DECLINE =
	/decline|don'?t wish|do not wish|prefer not|not to (answer|say|disclose|identify)|choose not|rather not/i;

/** Question labels per Answer Policy topic. Disclosure topics are demographic: a Policy or a decline, never a guess. */
const TOPICS: { topic: PolicyTopic; pattern: RegExp; disclosure: boolean }[] = [
	{ topic: "sponsorship", pattern: /sponsor/i, disclosure: false },
	{
		topic: "work_authorization",
		pattern: /(authori[sz]ed|eligible|legally (able|permitted)|right) to work|work authori[sz]ation/i,
		disclosure: false,
	},
	{ topic: "relocation", pattern: /relocat/i, disclosure: false },
	{ topic: "veteran", pattern: /veteran/i, disclosure: true },
	{ topic: "disability", pattern: /disabilit/i, disclosure: true },
	{ topic: "sexual_orientation", pattern: /sexual orientation/i, disclosure: true },
	{ topic: "gender", pattern: /gender|transgender|\bsex\b/i, disclosure: true },
	{ topic: "race", pattern: /\brace\b|ethnicity|hispanic/i, disclosure: true },
];
/** Self-identification questions with no Policy topic of their own: always declined or left blank. */
const OTHER_DISCLOSURE = /pronoun|lgbt|queer|religio/i;

/** Question labels an Authoritative Fact answers as it stands, when the form takes its value. */
const FACT_LABELS: { kind: string; pattern: RegExp }[] = [
	{ kind: "earliest_start", pattern: /earliest.*start|start date|when (can|could) you start|available to start/i },
	{ kind: "notice_period", pattern: /notice period/i },
	{ kind: "clearance", pattern: /security clearance/i },
];

const normal = (value: string) =>
	value
		.toLowerCase()
		.replace(/[’']/g, "'")
		.replace(/[^\p{L}\p{N}' ]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();

/**
 * The option an answer names: the one whose label equals it, else the only one whose label
 * starts with it ("Yes" picks "Yes, I am authorized"). Null when none or several do.
 */
function matchOption(question: ApplicationQuestion, answer: string): string | null {
	const key = normal(answer);
	if (!key) return null;
	const exact = question.options.find((o) => normal(o.label) === key);
	if (exact) return exact.label;
	const prefixed = question.options.filter((o) => normal(o.label).startsWith(`${key} `));
	return prefixed.length === 1 ? (prefixed[0]?.label ?? null) : null;
}

/** The one Candidate-level Fact of a kind, or null when there is none or its Facts contradict each other (#10). */
function soleFact(context: CandidateContext, kind: string): ContextFact | null {
	const found = context.authoritativeFacts.filter((f) => f.kind === kind && f.entryId === null);
	if (found.length !== 1 || (found[0]?.conflictsWith?.length ?? 0) > 0) return null;
	return found[0] ?? null;
}

type Answer = Omit<ApplicationAnswer, "question" | "escalation">;
const blank = (cls: QuestionClass): Answer => ({ class: cls, text: null, choices: [], sources: [], via: null });

/** A value for the question: as text, or the option it names. Null when a select offers no such option. */
function fill(question: ApplicationQuestion, value: string): Pick<Answer, "text" | "choices"> | null {
	if (question.type === "text" || question.type === "textarea") return { text: value, choices: [] };
	const option = matchOption(question, value);
	return option ? { text: null, choices: [option] } : null;
}

/** Name, email and phone, from the Candidate's Authoritative Facts; first and last name split the name. */
function identity(question: ApplicationQuestion, context: CandidateContext): Answer | null {
	const field = question.id;
	const label = normal(question.label);
	const name = () => soleFact(context, "name");
	const pick = (fact: ContextFact | null, value?: (v: string) => string | null): Answer => {
		const text = fact ? (value ? value(fact.value) : fact.value) : null;
		return fact && text
			? { class: "AUTHORITATIVE", text, choices: [], sources: [fact.id], via: "FACT" }
			: blank("AUTHORITATIVE");
	};
	if (field === "first_name" || label === "first name") return pick(name(), (v) => v.trim().split(/\s+/)[0] ?? null);
	if (field === "last_name" || label === "last name")
		return pick(name(), (v) => v.trim().split(/\s+/).slice(1).join(" ") || null);
	if (label === "name" || label === "full name") return pick(name());
	if (label === "legal name" || label === "full legal name") return pick(soleFact(context, "legal_name") ?? name());
	if (field === "email" || label === "email" || label === "email address") return pick(soleFact(context, "email"));
	if (field === "phone" || label === "phone" || label === "phone number") return pick(soleFact(context, "phone"));
	return null;
}

/** A demographic question: the Candidate's Policy, else the form's decline choice, else blank. Never a default. */
function disclosure(question: ApplicationQuestion, policy: AnswerPolicy | undefined): Answer {
	if (policy?.answer) {
		const filled = fill(question, policy.answer);
		if (filled) return { class: "OPTIONAL_DISCLOSURE", ...filled, sources: [policy.id], via: "POLICY" };
	}
	const decline = question.options.find((o) => o.decline) ?? question.options.find((o) => DECLINE.test(o.label));
	if (decline) {
		return {
			class: "OPTIONAL_DISCLOSURE",
			text: null,
			choices: [decline.label],
			sources: policy ? [policy.id] : [],
			via: "DECLINE",
		};
	}
	return blank("OPTIONAL_DISCLOSURE");
}

/**
 * Code's answer, with no model text (#16): identity from the Facts; demographic questions by
 * Policy or decline; otherwise an Authoritative Fact the form takes as it stands, which wins
 * over a conflicting Policy, else the Policy for the topic. Null when the model must answer.
 */
function deterministic(question: ApplicationQuestion, context: CandidateContext): Answer | null {
	const known = identity(question, context);
	if (known) return known;
	const topic = TOPICS.find((t) => t.pattern.test(question.label));
	const policy = topic && context.answerPolicies.find((p) => p.topic === topic.topic);
	if (question.section === "eeo" || topic?.disclosure || OTHER_DISCLOSURE.test(question.label)) {
		return disclosure(question, policy);
	}
	const kind =
		topic?.topic === "work_authorization"
			? "work_authorization"
			: FACT_LABELS.find((f) => f.pattern.test(question.label))?.kind;
	const fact = kind ? soleFact(context, kind) : null;
	const fromFact = fact && fill(question, fact.value);
	if (fact && fromFact) return { class: "AUTHORITATIVE", ...fromFact, sources: [fact.id], via: "FACT" };
	if (policy) {
		const filled = policy.answer === null ? null : fill(question, policy.answer);
		if (filled) return { class: "AUTHORITATIVE", ...filled, sources: [policy.id], via: "POLICY" };
	}
	return null;
}

// ——— The model's answers ———

export const answersOutputSchema = z.object({
	answers: z.array(
		z.object({
			questionId: z.string(),
			class: z.enum(QUESTION_CLASSES),
			/** The answer to a text question, else null. */
			text: z.string().nullable(),
			/** For a select, the chosen option labels exactly as listed; else empty. */
			choices: z.array(z.string()),
			cites: z.array(z.string()),
		}),
	),
});
export type AnswersOutput = z.output<typeof answersOutputSchema>;

const ANSWER_SYSTEM = `You answer the application questions of one job application for a Candidate, following the Application Strategy. Answer every question listed; code has answered the others already.
${RULES}

For each question return its questionId, its class, the answer and the ids it rests on in cites:
- AUTHORITATIVE: a value only the Candidate controls (work authorization, sponsorship, clearance, compensation, relocation, travel, start date, other promises to the employer). Answer only from an Authoritative fact, an Answer Policy, or the Driving Hunt's targeting, and cite it. Never infer, invent or alter one: when none states it, give no answer.
- FACTUAL: stated by the Candidate's facts; cite them.
- INFERABLE: follows from the facts, such as prior employment at this employer from the work history; cite what it follows from.
- PERSUASIVE: motivation and free-text prompts. Write a strong, truthful answer from the facts, led by the Strategy, in plain text; cite the facts used.
- PREFERENCE: an acknowledgement, consent or communication preference; answer as a candidate who wants this job would.
- OPTIONAL_DISCLOSURE: demographic self-identification. Give no answer: code declines it.
- ASSESSMENT: a real test of skill, such as a coding exercise or a timed quiz. Routine screening questions are not assessments. Give no answer.
- UNKNOWN: none of the above.

Favor progress: answer every required question you truthfully can. Leave an optional question blank when the facts do not support an answer. Never pick an option just because it is listed first.
For a select, put the chosen option labels exactly as listed in choices (one for a single select) and set text to null; for a text question, put the answer in text and leave choices empty. Keep text answers under 1,500 characters, no Markdown.
The Driving Hunt's targeting lists the locations and pay the Candidate accepts: a location listed as Ideal, Good or Acceptable is one the Candidate commits to working in. Cite it as its id.`;

const MAX_DESCRIPTION_CHARS = 1_500;

function questionView(q: ApplicationQuestion) {
	return {
		questionId: q.id,
		label: q.label,
		...(q.description ? { description: q.description.slice(0, MAX_DESCRIPTION_CHARS) } : {}),
		required: q.required,
		type: q.type,
		...(q.options.length > 0 ? { options: q.options.map((o) => o.label) } : {}),
	};
}

const isBlank = (a: Answer) => a.text === null && a.choices.length === 0;

/**
 * Checks one model answer (#16): every cited id must be the Candidate's (citation integrity),
 * an AUTHORITATIVE answer must rest on an Authoritative Fact, a Policy or the Hunt, a FACTUAL
 * one on some Fact, and a select may only name the form's options. A failed check drops the
 * answer, nothing else. Demographic and assessment answers are never taken from the model.
 */
function checked(
	question: ApplicationQuestion,
	output: AnswersOutput["answers"][number] | undefined,
	known: ReadonlySet<string>,
	authorities: ReadonlySet<string>,
): { answer: Answer; dropped: boolean } {
	if (!output) return { answer: blank("UNKNOWN"), dropped: false };
	if (output.class === "OPTIONAL_DISCLOSURE") return { answer: disclosure(question, undefined), dropped: false };
	if (output.class === "ASSESSMENT") return { answer: blank("ASSESSMENT"), dropped: false };
	const sources = [...new Set(output.cites)];
	let answer: Answer;
	if (question.type === "text" || question.type === "textarea") {
		const text = output.text?.trim() || null;
		answer = { class: output.class, text, choices: [], sources, via: text ? "MODEL" : null };
	} else {
		// A choice put in `text` instead of `choices` still counts.
		const picks = output.choices.length > 0 ? output.choices : output.text ? [output.text] : [];
		const named = picks.map((c) => matchOption(question, c));
		const choices = question.options.map((o) => o.label).filter((label) => named.includes(label));
		const valid = !named.includes(null) && (question.type === "multi_select" || choices.length <= 1);
		if (!valid) return { answer: blank(output.class), dropped: true };
		answer = { class: output.class, text: null, choices, sources, via: choices.length > 0 ? "MODEL" : null };
	}
	if (isBlank(answer)) return { answer: { ...answer, sources: [] }, dropped: false };
	const supported =
		sources.every((id) => known.has(id)) &&
		(output.class !== "AUTHORITATIVE" || sources.some((id) => authorities.has(id))) &&
		(output.class !== "FACTUAL" || sources.length > 0);
	return supported ? { answer, dropped: false } : { answer: blank(output.class), dropped: true };
}

/**
 * Answers a posting's application questions (§9, #16), at preparation and later for questions
 * a Browser Run discovers. Code answers first, with no model text: identity, demographic
 * questions (a Policy or a decline, never a default option), and Authoritative Facts or
 * Policies the form takes as they stand. One batched `answer` call answers the rest. Escalation
 * is narrow: only a required question left blank asks the Candidate, as ASSESSMENT_REQUIRED
 * for a real assessment and AUTHORITATIVE_FACT_REQUIRED otherwise. Optional ones stay blank.
 */
export async function answerQuestions(llm: LlmClient, input: AnswerInput): Promise<AnsweredQuestions> {
	const questions = input.questions.filter((q) => q.type !== "file");
	const { context, hunt } = input;
	const settled = new Map<string, Answer>();
	for (const question of questions) {
		const answer = deterministic(question, context);
		if (answer) settled.set(question.id, answer);
	}
	const open = questions.filter((q) => !settled.has(q.id));

	const candidate = candidateView(context);
	const posting = postingText(input.snapshot);
	const { latitude: _, ...plan } = input.strategy;
	const huntId = `hunt:${hunt.id}`;
	const targeting = { id: huntId, locations: hunt.locations, payFloorUsdPerYear: hunt.payFloor };
	const policies = context.answerPolicies;
	const hash = inputHash("answers", input.questions, candidate, posting, plan, policies, targeting, input.latitude);

	let callId: string | null = null;
	let droppedAnswers = 0;
	if (open.length > 0) {
		const result = await llm.generate({
			task: "answer",
			attribution: input.attribution,
			system: `${ANSWER_SYSTEM}\n\n${LATITUDE[input.latitude]}`,
			messages: [
				{
					role: "user",
					content: [
						`<candidate>\n${JSON.stringify(candidate)}\n</candidate>`,
						`<answer_policies>\n${JSON.stringify(policies)}\n</answer_policies>`,
						`<driving_hunt_targeting>\n${JSON.stringify(targeting)}\n</driving_hunt_targeting>`,
						`<posting>\n${posting}\n</posting>`,
						`<strategy>\n${JSON.stringify(plan)}\n</strategy>`,
						`<questions>\n${JSON.stringify(open.map(questionView))}\n</questions>`,
					].join("\n\n"),
				},
			],
			output: answersOutputSchema,
			maxOutputTokens: 8_000,
		});
		callId = result.callId;
		const known = new Set([...knownFactIds(context), ...policies.map((p) => p.id), huntId]);
		const authorities = new Set([...context.authoritativeFacts.map((f) => f.id), ...policies.map((p) => p.id), huntId]);
		const byId = new Map(result.output.answers.map((a) => [a.questionId, a]));
		for (const question of open) {
			const { answer, dropped } = checked(question, byId.get(question.id), known, authorities);
			if (dropped) droppedAnswers++;
			settled.set(question.id, answer);
		}
	}

	const answers = questions.map((question): ApplicationAnswer => {
		const answer = settled.get(question.id) ?? blank("UNKNOWN");
		const escalation: Escalation | null =
			question.required && isBlank(answer)
				? answer.class === "ASSESSMENT"
					? "ASSESSMENT_REQUIRED"
					: "AUTHORITATIVE_FACT_REQUIRED"
				: null;
		return { question, ...answer, escalation };
	});
	return { answers, droppedAnswers, callId, inputHash: hash };
}
