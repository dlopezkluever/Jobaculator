import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Route } from "playwright";

// Recorded real Greenhouse form pages and their `questions=true` JSON, replayed through
// Playwright request interception (§18). Test code only: `pnpm test:record-forms` records them.

const fixture = (name: string) => fileURLToPath(new URL(`./tests/fixtures/${name}`, import.meta.url));

export type RecordedForm = {
	/** The hosted application page. */
	url: string;
	/** The same form as Greenhouse's embed, which employer career pages put in an iframe. */
	embedUrl: string;
	questionsUrl: string;
	/** What the tests type into the location search, recorded with the pages. */
	locationSearch: string;
	/** The hosts whose GETs are recorded and replayed; every other request is aborted. */
	hosts: RegExp;
	har: string;
	questions: string;
	/** Where the form posts the application, and the confirmation page it then opens (hosted form). */
	submitUrl: string;
	confirmationUrl: string;
	/** The recorded confirmation page: a plain GET of its URL, which shows it to anyone. */
	confirmation: string;
};

export const RECORDED_FORMS = {
	figma: {
		url: "https://job-boards.greenhouse.io/figma/jobs/5426468004",
		embedUrl: "https://job-boards.greenhouse.io/embed/job_app?for=figma&token=5426468004",
		questionsUrl: "https://boards-api.greenhouse.io/v1/boards/figma/jobs/5426468004?questions=true",
		locationSearch: "Austin",
		// Not the upload's presigned fields (boards.greenhouse.io): they carry a signed AWS policy.
		hosts:
			/^https:\/\/(job-boards\.greenhouse\.io|job-boards\.cdn\.greenhouse\.io|my\.greenhouse\.io|s4-recruiting\.cdn\.greenhouse\.io|api-geocode-earth-proxy\.greenhouse\.io)\//,
		har: fixture("greenhouse-figma.har.zip"),
		questions: fixture("greenhouse-questions-figma.json"),
		submitUrl: "https://boards.greenhouse.io/figma/jobs/5426468004",
		confirmationUrl: "https://job-boards.greenhouse.io/figma/jobs/5426468004/confirmation",
		confirmation: fixture("greenhouse-confirmation-figma.html"),
	},
} as const satisfies Record<string, RecordedForm>;

/** The recorded `questions=true` response body of a form, as the Source's public API returned it. */
export function recordedQuestions(form: RecordedForm): unknown {
	return (JSON.parse(readFileSync(form.questions, "utf8")) as { body: unknown }).body;
}

/** An employer careers page that embeds the form in an iframe, as Greenhouse's embed code does. */
export const EMBEDDING_PAGE = "https://careers.example.com/jobs/platform?gh_jid=5426468004";

/**
 * Serves the recorded form in `context` with nothing reaching the network: the pages from the
 * HAR, the resume upload answered as S3 would, and an employer page embedding the form at
 * `EMBEDDING_PAGE`. Every other request is aborted. Returns each request the pages made.
 */
export async function replayRecordedForm(
	context: BrowserContext,
	form: RecordedForm,
): Promise<{ method: string; url: string }[]> {
	const requests: { method: string; url: string }[] = [];
	context.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
	await context.route("**/*", (route) => route.abort());
	await context.routeFromHAR(form.har, { url: form.hosts, notFound: "abort" });
	// Cross-origin, as on the live site: the form's origin is allowed.
	const cors = (route: Route) => ({
		"Access-Control-Allow-Origin": route.request().headers().origin ?? "*",
		"Access-Control-Allow-Credentials": "true",
		"Access-Control-Allow-Methods": "GET, POST",
	});
	await context.route("https://boards.greenhouse.io/uncacheable_attributes/presigned_fields**", (route) =>
		route.fulfill({
			headers: cors(route),
			json: {
				url: "https://grnhse-recorded.s3.us-west-2.amazonaws.com",
				...Object.fromEntries(
					new URL(route.request().url()).searchParams.getAll("fields[]").map((field) => [
						field,
						{
							fields: { success_action_status: "201", policy: "recorded", "x-amz-signature": "recorded" },
							key: `stash/applications/${field}s/{timestamp}-{unique_id}-recorded`,
						},
					]),
				),
			},
		}),
	);
	// An intercepted request reports no upload progress, which the form waits for: report it as S3's would.
	await context.addInitScript(() => {
		const open = XMLHttpRequest.prototype.open;
		const send = XMLHttpRequest.prototype.send;
		const urls = new WeakMap<XMLHttpRequest, string>();
		XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
			urls.set(this, String(args[1]));
			return (open as (...a: unknown[]) => void).apply(this, args);
		} as typeof open;
		XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body) {
			if (/\.amazonaws\.com/.test(urls.get(this) ?? "")) {
				this.addEventListener("load", () =>
					this.upload.dispatchEvent(new ProgressEvent("progress", { lengthComputable: true, loaded: 1, total: 1 })),
				);
			}
			return send.call(this, body);
		};
	});
	await context.route("https://*.amazonaws.com/**", (route) =>
		route.fulfill({
			status: 201,
			headers: cors(route),
			contentType: "application/xml",
			body: '<?xml version="1.0" encoding="UTF-8"?><PostResponse><Location>https://example.s3.amazonaws.com/stash/recorded</Location><Bucket>example</Bucket><Key>stash/recorded</Key><ETag>"recorded"</ETag></PostResponse>',
		}),
	);
	await context.route(EMBEDDING_PAGE, (route) =>
		route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><title>Platform Engineer</title><h1>Platform Engineer</h1><iframe id="grnhse_iframe" src="${form.embedUrl}" width="100%" height="3000"></iframe>`,
		}),
	);
	return requests;
}

/**
 * Stands in for Greenhouse accepting the hosted form's application, in a context already
 * replaying it: `accept` answers the POST as Greenhouse does and serves the recorded
 * confirmation page it then opens; `fail` makes the POST fail as a lost connection would.
 * Returns the application bodies posted.
 */
export async function answerSubmissions(
	context: BrowserContext,
	form: RecordedForm,
	answer: "accept" | "fail",
): Promise<unknown[]> {
	const posted: unknown[] = [];
	await context.route(form.submitUrl, (route) => {
		if (route.request().method() === "OPTIONS") {
			return route.fulfill({
				status: 204,
				headers: {
					"Access-Control-Allow-Origin": route.request().headers().origin ?? "*",
					"Access-Control-Allow-Methods": "POST",
					"Access-Control-Allow-Headers": "content-type",
					"Access-Control-Allow-Credentials": "true",
				},
			});
		}
		posted.push(route.request().postDataJSON());
		if (answer === "fail") return route.abort("connectionreset");
		return route.fulfill({
			headers: {
				"Access-Control-Allow-Origin": route.request().headers().origin ?? "*",
				"Access-Control-Allow-Credentials": "true",
			},
			json: {},
		});
	});
	await context.route(form.confirmationUrl, (route) =>
		route.fulfill({ contentType: "text/html", body: readFileSync(form.confirmation, "utf8") }),
	);
	return posted;
}
