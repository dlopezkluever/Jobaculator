import { describe, expect, it } from "vitest";
import {
	type BoardListing,
	canonicalUrl,
	createGreenhouseAdapter,
	createSourceHttp,
	sanitizedMarkdown,
	USER_AGENT,
} from "../index";
import { boardFixture, boardRoutes, greenhouseOver, questionsFixture, type Route, routedFetch } from "./helpers";

const stripe = { source: "greenhouse", token: "stripe" } as const;

describe("Greenhouse adapter", () => {
	it("translates a recorded listing into stated fields only", async () => {
		const listing = (await greenhouseOver(boardRoutes("anthropic")).listBoard({
			source: "greenhouse",
			token: "anthropic",
		})) as BoardListing;
		expect(listing.complete).toBe(true);
		expect(listing.postings).toHaveLength(2);
		const posting = listing.postings.find((p) => p.nativeId === "5456619008");
		expect(posting).toMatchObject({
			source: "greenhouse",
			boardToken: "anthropic",
			requisitionId: null,
			title: "3P Revenue Accounting & Reporting",
			employerName: "Anthropic",
			locationText: "San Francisco, CA | Seattle, WA",
			// Stated by the employer's "Location Type" field, not inferred from the prose.
			workplaceType: "ONSITE",
			employmentType: null,
			salary: null,
			firstPublishedAt: "2026-10-19T15:17:24.000Z",
			listed: true,
		});
		// The API entity-encodes the description; the adapter hands over real HTML.
		expect(posting?.descriptionHtml?.startsWith("<")).toBe(true);
		expect(posting?.raw).toEqual(boardFixture("anthropic").body.jobs[0]);
	});

	it("states no workplace type when the employer did not", async () => {
		const listing = (await greenhouseOver(boardRoutes("stripe")).listBoard(stripe)) as BoardListing;
		expect(listing.postings.map((p) => p.workplaceType)).toEqual([null, null, null]);
	});

	it("never calls a short or misshapen listing complete", async () => {
		const fixture = boardFixture("stripe");
		const short = { ...fixture.body, meta: { total: fixture.body.meta.total + 1 } };
		const wrong = { ...fixture.body, jobs: [...fixture.body.jobs.slice(1), { id: "x" }] };
		for (const body of [short, wrong, { jobs: "none" }]) {
			const adapter = greenhouseOver(new Map([[fixture.url, { status: 200, body }]]));
			expect(await adapter.listBoard(stripe)).toMatchObject({ failure: "MALFORMED" });
		}
	});

	it("reports a missing Board as NOT_FOUND and a missing posting as Gone", async () => {
		const routes = new Map<string, Route>([
			["https://boards-api.greenhouse.io/v1/boards/nope/jobs?content=true", { status: 404, body: { status: 404 } }],
			["https://boards-api.greenhouse.io/v1/boards/stripe/jobs/1?pay_transparency=true", { status: 404 }],
		]);
		const adapter = greenhouseOver(routes);
		expect(await adapter.listBoard({ source: "greenhouse", token: "nope" })).toMatchObject({ failure: "NOT_FOUND" });
		expect(await adapter.fetchPosting({ board: stripe, nativeId: "1" })).toEqual({ gone: true });
	});

	it("reads the stated pay range from a posting's detail", async () => {
		const job = { ...(boardFixture("figma").body.jobs[0] as object) };
		const detail = { ...job, pay_input_ranges: [{ min_cents: 16500000, max_cents: 19000000, currency_type: "USD" }] };
		const url = "https://boards-api.greenhouse.io/v1/boards/figma/jobs/5426468004?pay_transparency=true";
		const adapter = greenhouseOver(new Map([[url, { status: 200, body: detail }]]));
		const posting = await adapter.fetchPosting({
			board: { source: "greenhouse", token: "figma" },
			nativeId: "5426468004",
		});
		expect(posting).toMatchObject({ salary: { min: 165000, max: 190000, currency: "USD" } });
	});

	it("translates a recorded posting form into its application questions", async () => {
		const read = async (token: string, nativeId: string) => {
			const fixture = questionsFixture(token);
			const adapter = greenhouseOver(new Map([[fixture.url, { status: 200, body: fixture.body }]]));
			const found = await adapter.fetchQuestions({ board: { source: "greenhouse", token }, nativeId });
			if (!Array.isArray(found)) throw new Error("no questions");
			return found;
		};
		const anthropic = await read("anthropic", "5456619008");
		expect(anthropic.slice(0, 5).map((q) => [q.id, q.type, q.required])).toEqual([
			["first_name", "text", true],
			["last_name", "text", true],
			["email", "text", true],
			["phone", "text", true],
			// A file with a paste-in alternative is a file question.
			["resume", "file", true],
		]);
		expect(anthropic.find((q) => q.id === "question_19018744008")).toEqual({
			id: "question_19018744008",
			label: "Do you require visa sponsorship?",
			description: null,
			required: true,
			type: "single_select",
			options: [
				{ label: "Yes", value: "1", decline: false },
				{ label: "No", value: "0", decline: false },
			],
			section: "application",
		});
		// The arbitration agreement's HTML arrives as Markdown, never as HTML.
		const arbitration = anthropic.find((q) => q.label === "Please read the arbitration agreement below");
		expect(arbitration?.description).toMatch(/^\*\*_Agreement to Arbitrate_\*\*/);
		expect(arbitration?.description).not.toContain("<");
		// The EEO block follows the form's own questions, with readable labels.
		expect(anthropic.filter((q) => q.section === "eeo").map((q) => [q.id, q.label, q.required])).toEqual([
			["veteran_status", "Veteran status", false],
			["race", "Race", false],
			["gender", "Gender", false],
		]);

		// The location's hidden coordinates are not questions; the location itself is.
		const stripeForm = await read("stripe", "8172510");
		expect(stripeForm.map((q) => q.id)).not.toContain("latitude");
		expect(stripeForm.find((q) => q.id === "location")).toMatchObject({ type: "text", required: true });
		expect(stripeForm.find((q) => q.id === "question_68935510[]")).toMatchObject({ type: "multi_select" });

		// The newer self-identification survey flags its decline choices, which are not always first.
		const discord = await read("discord", "8945798002");
		const race = discord.find((q) => q.label === "Race and Ethnicity");
		expect(race).toMatchObject({ section: "eeo", required: true, type: "single_select" });
		expect(race?.options[0]).toMatchObject({ label: "American Indian or Alaska Native", decline: false });
		expect(race?.options.filter((o) => o.decline).map((o) => o.label)).toEqual(["I don't wish to answer"]);
	});

	it("reports a missing posting's questions as Gone", async () => {
		const url = "https://boards-api.greenhouse.io/v1/boards/stripe/jobs/1?questions=true";
		const adapter = greenhouseOver(new Map([[url, { status: 404 }]]));
		expect(await adapter.fetchQuestions({ board: stripe, nativeId: "1" })).toEqual({ gone: true });
	});

	it("resolves Board tokens and Board URLs, and nothing else", () => {
		const { resolveBoard } = createGreenhouseAdapter(createSourceHttp({ fetch: routedFetch(new Map()).fetch }));
		const ref = (token: string) => ({ source: "greenhouse", token });
		expect(resolveBoard("Stripe")).toEqual(ref("stripe"));
		expect(resolveBoard("https://job-boards.greenhouse.io/anthropic/jobs/4461450008")).toEqual(ref("anthropic"));
		expect(resolveBoard("https://boards.greenhouse.io/embed/job_board?for=figma")).toEqual(ref("figma"));
		expect(resolveBoard("https://boards-api.greenhouse.io/v1/boards/figma/jobs")).toEqual(ref("figma"));
		expect(resolveBoard("https://jobs.lever.co/figma")).toBeNull();
		expect(resolveBoard("figma careers page")).toBeNull();
	});
});

describe("Source HTTP", () => {
	const url = "https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true";

	function harness(responses: Route[], options: { maxRetryAfterMs?: number } = {}) {
		let clock = 0;
		const sleeps: number[] = [];
		const { fetch, requests } = routedFetch(new Map([[url, responses]]));
		const http = createSourceHttp({
			fetch,
			minIntervalMs: 1000,
			backoffMs: 2000,
			maxAttempts: 3,
			...options,
			now: () => clock,
			sleep: async (ms) => {
				sleeps.push(ms);
				clock += ms;
			},
		});
		return { http, sleeps, requests, at: () => clock };
	}

	it("spaces requests to one host ~1 s apart, and sends the generic User-Agent", async () => {
		const ok = { status: 200, body: {} };
		const { http, sleeps, requests } = harness([ok, ok, ok]);
		await Promise.all([http.getJson(url), http.getJson(url), http.getJson(url)]);
		expect(sleeps).toEqual([1000, 1000]);
		expect(requests.map((r) => r.headers.get("user-agent"))).toEqual([USER_AGENT, USER_AGENT, USER_AGENT]);
	});

	it("waits out Retry-After on a 429 before retrying, holding back the whole host", async () => {
		const { http, at } = harness([
			{ status: 429, headers: { "retry-after": "30" } },
			{ status: 200, body: { ok: 1 } },
		]);
		expect(await http.getJson(url)).toEqual({ status: 200, body: { ok: 1 } });
		expect(at()).toBe(30_000);
	});

	it("gives up as RATE_LIMITED when Retry-After is too long to wait", async () => {
		const { http, requests } = harness([{ status: 429, headers: { "retry-after": "3600" } }], {
			maxRetryAfterMs: 120_000,
		});
		expect(await http.getJson(url)).toMatchObject({ failure: "RATE_LIMITED" });
		expect(requests).toHaveLength(1);
	});

	it("backs off exponentially on 5xx, then fails as TRANSIENT", async () => {
		const { http, sleeps } = harness([{ status: 502 }, { status: 500 }, { status: 500 }]);
		expect(await http.getJson(url)).toMatchObject({ failure: "TRANSIENT" });
		const backoffs = sleeps.filter((ms) => ms !== 1000);
		expect(backoffs).toHaveLength(2);
		expect(backoffs[0]).toBeGreaterThanOrEqual(1500);
		expect(backoffs[0]).toBeLessThanOrEqual(2500);
		expect(backoffs[1]).toBeGreaterThanOrEqual(3000);
		expect(backoffs[1]).toBeLessThanOrEqual(5000);
	});

	it("does not retry a 404 or a 403", async () => {
		expect(await harness([{ status: 404 }]).http.getJson(url)).toMatchObject({ failure: "NOT_FOUND" });
		expect(await harness([{ status: 403 }]).http.getJson(url)).toMatchObject({ failure: "BLOCKED" });
	});
});

describe("normalization boundary", () => {
	it("canonicalizes URLs, dropping tracking but keeping identity-bearing parameters", () => {
		expect(canonicalUrl("http://stripe.com/jobs/search/?utm_source=li&gh_jid=8172510&gh_src=abc#apply")).toBe(
			"https://stripe.com/jobs/search?gh_jid=8172510",
		);
		expect(canonicalUrl("https://x.com/j?b=2&a=1")).toBe(canonicalUrl("https://x.com/j?a=1&b=2"));
	});

	it("turns hostile HTML into inert Markdown", () => {
		const markdown = sanitizedMarkdown(
			`<p>Join <b>us</b><script>alert(1)</script><style>p{}</style></p>
			<p><a href="javascript:alert(1)">click</a> <a href="https://e.com/a?utm_medium=x&id=2">apply</a></p>
			<img src="https://tracker/p.gif" onerror="alert(1)"><iframe src="https://evil"></iframe>
			<p>&lt;script&gt;alert(2)&lt;/script&gt;</p>`,
		);
		expect(markdown).toContain("Join **us**");
		expect(markdown).toContain("[apply](https://e.com/a?id=2)");
		expect(markdown).not.toMatch(/alert\(1\)|javascript:|tracker|evil/);
		// No unescaped `<` is left for a Markdown renderer to read as HTML.
		expect(markdown).not.toMatch(/(^|[^\\])</);
		expect(markdown).toContain("\\<script\\>alert(2)\\</script\\>");
	});
});
