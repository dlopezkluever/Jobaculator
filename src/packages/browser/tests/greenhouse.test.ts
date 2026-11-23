import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../applications/index";
import { type ApplicationQuestion, createGreenhouseAdapter, createSourceHttp } from "../../discovery/index";
import type { ApplicationAnswer } from "../../generation/index";
import { createBrowserRunner, type PackagePort, type SubmitGate } from "../index";
import { answerSubmissions, EMBEDDING_PAGE, RECORDED_FORMS, recordedQuestions, replayRecordedForm } from "../testing";

// Dry Runs of a recorded real Greenhouse form (§18), replayed through Playwright request
// interception: nothing reaches the network.

const form = RECORDED_FORMS.figma;
const dir = mkdtempSync(join(tmpdir(), "dry-run-"));
const resumePath = join(dir, "Ada Lovelace Resume.pdf");
writeFileSync(resumePath, "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

const http = createSourceHttp({
	fetch: async () => new Response(JSON.stringify(recordedQuestions(form))),
	minIntervalMs: 0,
});
const fetched = await createGreenhouseAdapter(http).fetchQuestions({
	board: { source: "greenhouse", token: "figma" },
	nativeId: "5426468004",
});
if (!Array.isArray(fetched)) throw new Error("the recorded form did not parse");
const schema: ApplicationQuestion[] = fetched;

const answer = (id: string, text: string | null, choices: string[] = []): ApplicationAnswer => {
	const question = schema.find((q) => q.id === id);
	if (!question) throw new Error(`no question ${id}`);
	return { question, class: "FACTUAL", text, choices, sources: [], via: "MODEL", escalation: null };
};

const EMAIL_LIKE: ApplicationQuestion = {
	id: "",
	label: "",
	description: null,
	required: true,
	type: "text",
	options: [],
	section: "application",
};

/** The Package's answers to the schema; the page also has fields the schema lacks (Country). */
const ANSWERS = [
	answer("first_name", "Ada"),
	answer("last_name", "Lovelace"),
	answer("email", "ada@example.com"),
	answer("phone", "+1 512 555 0147"),
	answer("question_12497120004", "I want to build tools designers love."),
	answer("question_12497123004", "Austin, TX"),
	answer("location", "Austin, Texas, United States"),
	answer("question_12497125004", null, ["Yes"]),
	answer("question_12497126004", null, ["No"]),
	answer("gender", null, ["Decline To Self Identify"]),
];

function dryRun(
	url: string,
	extra?: (context: BrowserContext) => Promise<unknown>,
	answers: ApplicationAnswer[] = ANSWERS,
	live?: { gate: SubmitGate },
) {
	const events: RunEvent[] = [];
	const generated: ApplicationQuestion[][] = [];
	let requests: { method: string; url: string }[] = [];
	const runner = createBrowserRunner({
		confirmationTimeoutMs: 5_000,
		onContext: async (context) => {
			requests = await replayRecordedForm(context, form);
			await extra?.(context);
		},
	});
	const pkg: PackagePort = {
		schema,
		answers,
		documents: { resume: { path: resumePath, filename: "Ada Lovelace Resume.pdf" }, coverLetter: null },
		// Mid-run generation: the questions the Package has no answer for, Country among them.
		async generateMissing(questions) {
			generated.push(questions);
			return questions.map((question) => {
				const decline = question.options.find((o) => /decline|don't wish/i.test(o.label));
				const choices = question.id === "country" ? ["United States +1"] : decline ? [decline.label] : [];
				return { question, class: "FACTUAL", text: null, choices, sources: [], via: "MODEL", escalation: null };
			});
		},
	};
	const run = runner
		.run({
			url,
			mode: live ? "live" : "dry",
			package: pkg,
			gate: live?.gate ?? {
				cross: async () => {
					throw new Error("a Dry Run never reaches the gate");
				},
			},
			signal: AbortSignal.timeout(90_000),
			events: {
				record: async (event) => {
					events.push(event);
				},
				evidence: async (label) => label,
			},
		})
		.finally(() => runner.close());
	return { run, events, generated, requests: () => requests };
}

/** Writes to Greenhouse other than its analytics: the application's own requests, where a submission would go. */
const formWrites = (requests: { method: string; url: string }[]) =>
	requests.filter(
		(r) => r.method !== "GET" && /greenhouse\.io/.test(new URL(r.url).hostname) && !r.url.includes("c.spl."),
	);

describe("a Dry Run of a recorded Greenhouse form", () => {
	it("fills every field and uploads the resume, then stops before submitting and sends nothing to the form", async () => {
		const { run, events, generated, requests } = dryRun(form.url);
		const outcome = await run;
		expect(outcome.kind).toBe("dry_run_complete");
		const observed = Object.fromEntries(outcome.fields.map((f) => [f.key, f.observed]));
		expect(observed).toMatchObject({
			first_name: ["Ada"],
			email: ["ada@example.com"],
			country: ["United States +1"],
			"candidate-location": ["Austin, Texas, United States"],
			question_12497125004: ["Yes"],
			gender: ["Decline To Self Identify"],
			resume: ["Ada Lovelace Resume.pdf"],
		});
		// The page has Country, which the schema lacks: answered mid-run, with the page's options.
		const country = generated.flat().find((q) => q.id === "country");
		expect(country?.options.length).toBeGreaterThan(200);
		// Required-ness merges the page and the schema: the page marks the resume required here.
		expect(outcome.fields.filter((f) => f.required && !f.ok)).toEqual([]);
		expect(outcome.fields.find((f) => f.key === "question_12497126004")).toMatchObject({ required: true, ok: true });
		// The resume upload went to storage, and nothing was written to the form's hosts.
		expect(requests().some((r) => r.method === "POST" && r.url.includes("amazonaws.com"))).toBe(true);
		expect(formWrites(requests())).toEqual([]);
		expect(events.map((e) => e.type)).toContain("stopped_before_submit");
		expect(events.filter((e) => e.type === "screenshot").map((e) => e.type === "screenshot" && e.label)).toEqual([
			"Form opened",
			"Form filled",
		]);
		expect(events.some((e) => e.type === "action_refused" || e.type === "submit_blocked")).toBe(false);
	}, 120_000);

	it("recognizes the form embedded in an employer's career page, and reuses answers an earlier run generated", async () => {
		// An earlier run answered Country, a field only the page has, onto the Package.
		const country: ApplicationAnswer = {
			question: { ...EMAIL_LIKE, id: "country", label: "Country", type: "single_select" },
			class: "FACTUAL",
			text: null,
			choices: ["United States +1"],
			sources: [],
			via: "MODEL",
			escalation: null,
		};
		const { run, events, generated } = dryRun(EMBEDDING_PAGE, undefined, [...ANSWERS, country]);
		const outcome = await run;
		expect(generated.flat().map((q) => q.id)).not.toContain("country");
		expect(outcome.fields.find((f) => f.key === "country")).toMatchObject({ source: "package", ok: true });
		expect(outcome.kind).toBe("dry_run_complete");
		expect(events).toContainEqual({ type: "driver_selected", driver: "greenhouse", embedded: true });
		expect(outcome.fields.find((f) => f.key === "resume")?.observed).toEqual(["Ada Lovelace Resume.pdf"]);
	}, 120_000);

	it("stops a page that tries to submit by itself: its form submission is cancelled and its POST never leaves", async () => {
		// A hostile page submits as soon as a field changes: through the form, and by posting itself.
		const failed: { url: string; error: string | undefined }[] = [];
		const { run, events } = dryRun(form.url, async (context) => {
			context.on("requestfailed", (r) => {
				if (r.method() === "POST") failed.push({ url: r.url(), error: r.failure()?.errorText });
			});
			await context.addInitScript(`document.addEventListener("change", () => {
				document.querySelector("form#application-form")?.requestSubmit();
				fetch(location.href, { method: "POST", body: "application" }).catch(() => {});
			}, true);`);
		});
		const outcome = await run;
		expect(outcome.kind).toBe("dry_run_complete");
		expect(events.find((e) => e.type === "submit_blocked")).toMatchObject({ attempts: expect.any(Number) });
		// Refused by the Dry Run's own block, not merely missing from the recording.
		const posts = failed.filter((f) => f.url === form.url);
		expect(posts.length).toBeGreaterThan(0);
		for (const post of posts) expect(post.error).toMatch(/ERR_BLOCKED_BY_CLIENT/);
	}, 120_000);
});

/** A gate that records what it was asked to freeze, and answers `crosses`. */
function gate(crosses: boolean) {
	const crossings: number[] = [];
	return {
		crossings,
		gate: {
			async cross(fields) {
				crossings.push(fields.length);
				return crosses;
			},
		} satisfies SubmitGate,
	};
}

describe("a live run of a recorded Greenhouse form", () => {
	it("crosses the gate once, clicks submit, and keeps the confirmation the page shows", async () => {
		const live = gate(true);
		let posted: unknown[] = [];
		const { run, events } = dryRun(
			form.url,
			async (context) => {
				posted = await answerSubmissions(context, form, "accept");
			},
			ANSWERS,
			live,
		);
		const outcome = await run;
		expect(outcome.kind).toBe("submitted");
		if (outcome.kind !== "submitted") return;
		expect(live.crossings).toHaveLength(1);
		expect(live.crossings[0]).toBeGreaterThan(5);
		// One application reached Greenhouse, with what was filled in.
		expect(posted).toHaveLength(1);
		expect(JSON.stringify(posted[0])).toContain("ada@example.com");
		expect(outcome.confirmation).toMatchObject({ url: form.confirmationUrl, screenshot: "Confirmation" });
		expect(outcome.confirmation.text).toMatch(/Thank you for applying/);
		const order = events.map((e) => e.type).filter((t) => t.startsWith("submit") || t.startsWith("confirmation"));
		expect(order).toEqual(["submit_clicked", "confirmation_detected"]);
	}, 120_000);

	it("never clicks submit when the gate refuses, and nothing reaches the form", async () => {
		const live = gate(false);
		let posted: unknown[] = [];
		const { run, events, requests } = dryRun(
			form.url,
			async (context) => {
				posted = await answerSubmissions(context, form, "accept");
			},
			ANSWERS,
			live,
		);
		const outcome = await run;
		expect(outcome.kind).toBe("aborted");
		expect(live.crossings).toHaveLength(1);
		expect(posted).toEqual([]);
		expect(formWrites(requests())).toEqual([]);
		expect(events.map((e) => e.type)).toContain("submit_refused");
		expect(events.map((e) => e.type)).not.toContain("submit_clicked");
	}, 120_000);

	it("is an Uncertain Submission when the page never confirms after the click", async () => {
		const live = gate(true);
		let posted: unknown[] = [];
		const { run, events } = dryRun(
			form.url,
			async (context) => {
				posted = await answerSubmissions(context, form, "fail");
			},
			ANSWERS,
			live,
		);
		const outcome = await run;
		expect(outcome.kind).toBe("submit_unknown");
		expect(posted).toHaveLength(1);
		expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["submit_clicked", "no_confirmation"]));
		expect(events.map((e) => e.type)).not.toContain("confirmation_detected");
	}, 120_000);
});
