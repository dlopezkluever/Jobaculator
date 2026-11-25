import type { BrowserContext } from "playwright";
import { describe, expect, it } from "vitest";
import { createScriptedLlm, type ScriptedLlm } from "../../ai/testing";
import type { RunEvent } from "../../applications/index";
import { newUserId } from "../../db/testing";
import { createBrowserRunner, type PackagePort } from "../index";
import { RECORDED_FORMS, replayRecordedForm } from "../testing";

// Failure classification (§10) through the runner, in Chromium: deterministic page and error
// rules first, the driver's own finding next, one bounded model call last, else UNKNOWN.

const EMPTY: PackagePort = {
	schema: [],
	answers: [],
	documents: { resume: null, coverLetter: null },
	generateMissing: async () => [],
};

async function fail(
	url: string,
	setup: (context: BrowserContext) => Promise<unknown>,
	options: { llm?: ScriptedLlm; package?: PackagePort } = {},
) {
	const events: RunEvent[] = [];
	const llm = options.llm ?? createScriptedLlm([]);
	const runner = createBrowserRunner({
		onContext: async (context) => {
			await context.route("**/*", (route) => route.abort());
			await setup(context);
		},
	});
	const outcome = await runner
		.run({
			url,
			mode: "dry",
			package: options.package ?? EMPTY,
			gate: {
				cross: async () => {
					throw new Error("a Dry Run never reaches the gate");
				},
			},
			signal: AbortSignal.timeout(90_000),
			ai: { llm, attribution: { userId: newUserId() } },
			events: {
				record: async (event) => {
					events.push(event);
				},
				evidence: async (label) => label,
			},
		})
		.finally(() => runner.close());
	const failed = events.find((e) => e.type === "failed");
	return { outcome, failed, events, llm };
}

const html = (body: string) => async (context: BrowserContext) => {
	await context.route("https://careers.example.com/**", (route) =>
		route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Job</title><body>${body}</body>` }),
	);
	await context.route("https://www.google.com/recaptcha/**", (route) =>
		route.fulfill({ contentType: "text/html", body: "<div>Select all images with traffic lights</div>" }),
	);
};
const PAGE = "https://careers.example.com/jobs/42";

describe("classifying a Browser Run that failed before the submit boundary", () => {
	it.each([
		["a closed posting", "<h1>Sorry, this job is no longer accepting applications.</h1>", "JOB_EXPIRED"],
		["an employer saying you applied", "<p>You have already applied for this position.</p>", "DUPLICATE_APPLICATION"],
		[
			"a sign-in wall",
			'<h1>Sign in to apply</h1><form><input type="email"><input type="password"></form>',
			"AUTH_REQUIRED",
		],
		[
			"a visible challenge",
			'<p>One more step</p><iframe src="https://www.google.com/recaptcha/api2/bframe?k=x" width="400" height="580"></iframe>',
			"CAPTCHA",
		],
	] as const)(
		"reads %s off the page over the driver's finding",
		async (_name, body, category) => {
			const { outcome, failed, events, llm } = await fail(PAGE, html(body));
			expect(outcome).toMatchObject({ kind: "failed", category });
			expect(failed).toEqual({ type: "failed", category, by: "page" });
			// The page is the Intervention's evidence; no model was asked.
			expect(events).toContainEqual(expect.objectContaining({ type: "screenshot", label: "Failed" }));
			expect(llm.calls).toEqual([]);
		},
		60_000,
	);

	it("keeps the driver's finding when the page shows nothing decisive: a hidden password field or challenge is not a wall", async () => {
		const { outcome, failed } = await fail(
			PAGE,
			html(
				'<h1>Apply</h1><input type="password" style="display:none"><iframe src="https://www.google.com/recaptcha/api2/bframe?k=x" style="visibility:hidden"></iframe>',
			),
		);
		expect(outcome).toMatchObject({ kind: "failed", category: "UNSUPPORTED_FLOW" });
		expect(failed).toEqual({ type: "failed", category: "UNSUPPORTED_FLOW", by: "driver" });
	}, 60_000);

	it("expires a Greenhouse posting that redirects to its Board with ?error=true", async () => {
		const job = "https://job-boards.greenhouse.io/acme/jobs/1";
		const { outcome, failed } = await fail(job, async (context) => {
			await context.route(job, (route) =>
				route.fulfill({ status: 302, headers: { location: "https://job-boards.greenhouse.io/acme?error=true" } }),
			);
			await context.route("https://job-boards.greenhouse.io/acme?error=true", (route) =>
				route.fulfill({ contentType: "text/html", body: "<h1>Current openings at Acme</h1>" }),
			);
		});
		expect(outcome).toMatchObject({ kind: "failed", category: "JOB_EXPIRED" });
		expect(failed?.type === "failed" && failed.by).toBe("page");
	}, 60_000);

	it("is NETWORK when the posting does not load", async () => {
		const { outcome, failed } = await fail(PAGE, (context) =>
			context.route(PAGE, (route) => route.abort("connectionrefused")),
		);
		expect(outcome).toMatchObject({ kind: "failed", category: "NETWORK" });
		expect(failed).toEqual({ type: "failed", category: "NETWORK", by: "error" });
	}, 60_000);

	describe("on the recorded Greenhouse form, which loads an invisible reCAPTCHA", () => {
		const form = RECORDED_FORMS.figma;
		// The run breaks on something no rule recognizes.
		const broken: PackagePort = {
			...EMPTY,
			generateMissing: async () => {
				throw new Error("something unexpected");
			},
		};

		it("asks the model once, on the page's text, when no rule decides", async () => {
			const llm = createScriptedLlm([{ task: "classify", output: { category: "SITE_CHANGED" } }]);
			const { outcome, failed } = await fail(form.url, (context) => replayRecordedForm(context, form), {
				llm,
				package: broken,
			});
			expect(outcome).toMatchObject({ kind: "failed", category: "SITE_CHANGED" });
			expect(failed).toEqual({ type: "failed", category: "SITE_CHANGED", by: "model" });
			expect(llm.calls).toHaveLength(1);
			const [call] = llm.calls;
			expect(call?.method).toBe("generate");
			const prompt = call?.method === "generate" ? JSON.stringify(call.request.messages) : "";
			expect(prompt).toContain(form.url);
			// The model sees the form, past the long job description above it.
			expect(prompt).toMatch(/First Name/i);
		}, 120_000);

		it("is UNKNOWN when the model cannot answer", async () => {
			const { outcome, failed } = await fail(form.url, (context) => replayRecordedForm(context, form), {
				package: broken,
			});
			expect(outcome).toMatchObject({ kind: "failed", category: "UNKNOWN" });
			expect(failed).toEqual({ type: "failed", category: "UNKNOWN", by: "none" });
		}, 120_000);
	});
});
