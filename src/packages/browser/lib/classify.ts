/// <reference lib="dom" />
import { errors, type Page } from "playwright";
import { z } from "zod";
import { FAILURE_CATEGORIES } from "../../applications/index";
import type { ClassifiedBy, FailureCategory, RunAi } from "./types";

// Failure classification (§10): a Browser Run that fails before the submit boundary gets one
// category of the closed §96 enum. Deterministic detection first (what the page shows, then
// the driver's own finding, then what failed), then one bounded model call on the page's
// text, else UNKNOWN. The category decides recovery (§5 retry table), so the rules are narrow.

/** Greenhouse sends a closed posting's URL to its Board with `?error=true`. */
const GREENHOUSE = /(^|\.)greenhouse\.io$/;
const EXPIRED_TEXT = [
	/no longer accepting applications/i,
	/\b(job|position|posting|role|opening)\b[^.\n]{0,40}\b(no longer (available|open|active)|(has been|is) (closed|filled|removed))/i,
];
const DUPLICATE_TEXT =
	/you('ve| have) already (applied|submitted an application)|already (received|submitted) an application/i;
const CAPTCHA_TEXT = /verify (that )?you are (a )?human|are you a robot|complete the security check/i;
/** A visible challenge, not the invisible reCAPTCHA every Greenhouse form loads. */
const CHALLENGE_FRAME =
	/recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com\/.*frame=challenge|challenges\.cloudflare\.com/;
const AUTH_TEXT = /\b(sign|log) ?in to (apply|continue)\b|create an account to (apply|continue)/i;

/** What the page showed when the run failed, across its frames. */
type PageReading = { url: string; text: string; challenge: boolean; password: boolean };

/** In the page: its visible text and whether it shows a password field. No inner functions (see greenhouse.ts). */
function readFrame() {
	let password = false;
	for (const el of document.querySelectorAll("input[type=password]")) {
		const box = el.getBoundingClientRect();
		if (box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden") password = true;
	}
	return { text: (document.body?.innerText ?? "").slice(0, 20_000), password };
}

const within = <T>(promise: Promise<T>, ms: number) =>
	Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

async function readPage(page: Page): Promise<PageReading> {
	const frames = await Promise.all(
		page.frames().map(async (frame) => {
			const read = await within(frame.evaluate(readFrame), 5_000).catch(() => ({ text: "", password: false }));
			const challenge =
				frame !== page.mainFrame() &&
				CHALLENGE_FRAME.test(frame.url()) &&
				(await within(
					frame.frameElement().then((el) => el.isVisible()),
					2_000,
				).catch(() => false));
			return { ...read, challenge };
		}),
	);
	return {
		url: page.url(),
		text: frames.map((f) => f.text).join("\n"),
		challenge: frames.some((f) => f.challenge),
		password: frames.some((f) => f.password),
	};
}

/** The deterministic page rules, most decisive first. */
function pageCategory(reading: PageReading, status: number | null): FailureCategory | null {
	if (status === 404 || status === 410) return "JOB_EXPIRED";
	const url = URL.parse(reading.url);
	if (url && GREENHOUSE.test(url.hostname) && url.searchParams.get("error") === "true") return "JOB_EXPIRED";
	if (EXPIRED_TEXT.some((re) => re.test(reading.text))) return "JOB_EXPIRED";
	if (DUPLICATE_TEXT.test(reading.text)) return "DUPLICATE_APPLICATION";
	if (reading.challenge || CAPTCHA_TEXT.test(reading.text)) return "CAPTCHA";
	if (reading.password || AUTH_TEXT.test(reading.text)) return "AUTH_REQUIRED";
	return null;
}

function errorCategory(error: unknown, browserGone: boolean): FailureCategory | null {
	if (browserGone) return "BROWSER_FAILURE";
	if (error instanceof errors.TimeoutError) return "NETWORK";
	if (error instanceof Error && /net::ERR_/.test(error.message)) return "NETWORK";
	return null;
}

/** The page's text the model sees: its top (a closed-posting banner) and its end (the form, its errors). */
const MODEL_HEAD_CHARS = 1_500;
const MODEL_TAIL_CHARS = 4_500;
const excerpt = (text: string) =>
	text.length <= MODEL_HEAD_CHARS + MODEL_TAIL_CHARS
		? text
		: `${text.slice(0, MODEL_HEAD_CHARS)}\n…\n${text.slice(-MODEL_TAIL_CHARS)}`;
const MODEL_TIMEOUT_MS = 20_000;
const SYSTEM = `A browser was filling in a job application for a candidate and stopped before submitting it. From the page it stopped on, pick the one category that explains why. Answer UNKNOWN unless the page clearly shows one of the others.

- JOB_EXPIRED: the posting is closed, filled or gone.
- DUPLICATE_APPLICATION: the employer says this candidate already applied.
- CAPTCHA: a human-verification challenge.
- AUTH_REQUIRED: the employer requires signing in or creating an account.
- ASSESSMENT_REQUIRED: a test, quiz, coding exercise or video interview must be completed.
- UNSUPPORTED_FLOW: the page is not an application form the browser can fill (another site, a redirect it cannot follow, an email-only application).
- AUTHORITATIVE_FACT_REQUIRED: a required question only the candidate can answer truthfully.
- UPLOAD_FAILURE: a document upload failed.
- SITE_CHANGED: the form looks broken or different from what was expected.
- NETWORK: the page did not load or shows a connection error.
- UNKNOWN: none of these is clear.`;

/**
 * The category of a run that failed before the boundary. `reported` is what the driver or the
 * runner found; it stands unless the page shows something more decisive. Never throws.
 */
export async function classifyFailure(input: {
	page: Page | null;
	/** The HTTP status the posting opened with. */
	status: number | null;
	reported: { category: FailureCategory; detail: string };
	error: unknown;
	browserGone: boolean;
	ai: RunAi;
	signal: AbortSignal;
}): Promise<{ category: FailureCategory; by: ClassifiedBy }> {
	const reading = input.page && !input.browserGone ? await readPage(input.page).catch(() => null) : null;
	const fromPage = reading ? pageCategory(reading, input.status) : null;
	if (fromPage) return { category: fromPage, by: "page" };
	if (input.reported.category !== "UNKNOWN") return { category: input.reported.category, by: "driver" };
	const fromError = errorCategory(input.error, input.browserGone);
	if (fromError) return { category: fromError, by: "error" };
	if (!reading || input.signal.aborted) return { category: "UNKNOWN", by: "none" };
	try {
		const { output } = await input.ai.llm.generate({
			task: "classify",
			attribution: input.ai.attribution,
			system: SYSTEM,
			messages: [
				{
					role: "user",
					content: `What the browser found: ${input.reported.detail}\nPage URL: ${reading.url}\nPage text:\n${excerpt(reading.text)}`,
				},
			],
			output: z.object({ category: z.enum(FAILURE_CATEGORIES) }),
			maxOutputTokens: 200,
			signal: AbortSignal.any([input.signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
		});
		return output.category === "UNKNOWN"
			? { category: "UNKNOWN", by: "none" }
			: { category: output.category, by: "model" };
	} catch {
		return { category: "UNKNOWN", by: "none" };
	}
}
