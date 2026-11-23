/// <reference lib="dom" />
import { randomUUID } from "node:crypto";
import type { BrowserContext, Frame, Locator } from "playwright";
import type { FieldRecord, RunEventSink, SubmitGate } from "./types";

// The guarded action layer (§10, #17): every browser action goes through it, so no click,
// Enter or form submit can bypass Dry Run or the submit boundary. An action that might submit
// the application, and whose safety cannot be established, is refused and not performed. The
// one final click is `submit`, and only after `SubmitGate` has crossed the boundary.

/**
 * What a run's context lets through: nothing submits and nothing is written to the form's
 * hosts until the gate has crossed (`crossed`); then exactly one form submission, authorized
 * in the page by a token the page's own scripts never see.
 */
type ContextGuard = { token: string; crossed: boolean };
const guards = new WeakMap<BrowserContext, ContextGuard>();
const guardOf = (context: BrowserContext) => {
	let guard = guards.get(context);
	if (!guard) {
		guard = { token: randomUUID(), crossed: false };
		guards.set(context, guard);
	}
	return guard;
};

/** A refused action: it might have submitted the application. */
export class UnsafeAction extends Error {
	override name = "UnsafeAction";
	constructor(
		readonly action: string,
		readonly reason: string,
	) {
		super(`refused ${action}: ${reason}`);
	}
}

const SUBMIT_WORDS = /\b(submit|apply|send)\b/i;

/** In the page: whether clicking `el` might submit its form or the application. */
function possiblySubmits(el: Element, words: string): string | null {
	const target = el.closest("button, input, a, [role=button]") ?? el;
	const text =
		(target.textContent ?? "") + (target.getAttribute("aria-label") ?? "") + (target.getAttribute("value") ?? "");
	const submitWords = new RegExp(words, "i");
	if (target instanceof HTMLButtonElement) {
		// A button's default type is submit: inside a form, it submits.
		if (target.type === "submit" && target.form) return "a submit button";
		if (submitWords.test(text)) return "a button that reads like submit";
		return null;
	}
	if (target instanceof HTMLInputElement) {
		if ((target.type === "submit" || target.type === "image") && target.form) return "a submit input";
		return null;
	}
	if (submitWords.test(text) && (target instanceof HTMLAnchorElement || target.getAttribute("role") === "button")) {
		return "a control that reads like submit";
	}
	return null;
}

export type GuardedActions = {
	click(locator: Locator): Promise<void>;
	/** Sets a text field's value. */
	fill(locator: Locator, text: string): Promise<void>;
	/** Types key by key, as a person would, for widgets that react to typing. */
	type(locator: Locator, text: string): Promise<void>;
	press(locator: Locator, key: string): Promise<void>;
	upload(locator: Locator, path: string): Promise<void>;
	/**
	 * The final click on `locator`, the form's submit button: crosses the submit boundary through
	 * the gate first, then clicks once. False when the gate refused (nothing was clicked). Only a
	 * live run has a gate; once per run. `fields` are frozen with the Package revision.
	 */
	submit(locator: Locator, fields: FieldRecord[]): Promise<boolean>;
};

/**
 * The only way drivers act on a page. `uploads` are the Package's files, the only ones a
 * field may upload (§14). `gate` is the live run's SubmitGate; a Dry Run has none. Refusals
 * are recorded as events and thrown as `UnsafeAction`.
 */
export function guardedActions(
	events: RunEventSink,
	uploads: readonly string[],
	gate: SubmitGate | null = null,
): GuardedActions {
	let submitted = false;
	const refuse = async (action: string, reason: string): Promise<never> => {
		await events.record({ type: "action_refused", action, reason });
		throw new UnsafeAction(action, reason);
	};
	const noEnter = async (locator: Locator, text: string) => {
		// Enter in a single-line field submits its form (implicit submission).
		if (/[\r\n]/.test(text) && !(await locator.evaluate((el) => el instanceof HTMLTextAreaElement))) {
			await refuse("type", "a line break in a single-line field");
		}
	};
	return {
		async click(locator) {
			const unsafe = await locator.evaluate(possiblySubmits, SUBMIT_WORDS.source);
			if (unsafe) await refuse("click", unsafe);
			await locator.click();
		},
		async fill(locator, text) {
			await noEnter(locator, text);
			await locator.fill(text);
		},
		async type(locator, text) {
			await noEnter(locator, text);
			await locator.pressSequentially(text, { delay: 40 });
		},
		async press(locator, key) {
			if (/^(Numpad)?Enter$/.test(key) || key.includes("Enter")) await refuse("press", "Enter may submit the form");
			await locator.press(key);
		},
		async upload(locator, path) {
			if (!uploads.includes(path)) await refuse("upload", "not a file of this Package");
			await locator.setInputFiles(path);
		},
		async submit(locator, fields) {
			if (!gate) return refuse("submit", "not a live run");
			if (submitted) return refuse("submit", "the run has already submitted");
			submitted = true;
			if (!(await gate.cross(fields))) {
				await events.record({ type: "submit_refused" });
				return false;
			}
			// Past the boundary: the context lets one submission and the form's writes through.
			const guard = guardOf(locator.page().context());
			guard.crossed = true;
			await locator.evaluate((_el, token) => {
				(window as unknown as { __jobaculatorAllowSubmit?: (t: string) => void }).__jobaculatorAllowSubmit?.(token);
			}, guard.token);
			await locator.click();
			await events.record({ type: "submit_clicked" });
			return true;
		},
	};
}

/**
 * Defense in depth: no write reaches `hosts`, where the final submission goes, until the gate
 * has crossed; in a Dry Run, never. Uploads go to storage elsewhere and still happen (#19).
 */
export async function blockWritesUntilSubmit(context: BrowserContext, hosts: RegExp): Promise<void> {
	const guard = guardOf(context);
	await context.route(hosts, (route) =>
		route.request().method() === "GET" || guard.crossed ? route.fallback() : route.abort("blockedbyclient"),
	);
}

/**
 * Defense in depth inside every page of the run: cancels every form submission, whether from
 * a submit event, `form.submit()` or `form.requestSubmit()`, and counts the attempts. The one
 * submission `submit` authorizes, with the context's token, goes through.
 */
export async function blockFormSubmission(context: BrowserContext): Promise<void> {
	const { token } = guardOf(context);
	// A string, so the page gets exactly this code whatever compiled the module.
	await context.addInitScript(`(() => {
		let allowed = 0;
		const token = ${JSON.stringify(token)};
		Object.defineProperty(window, "__jobaculatorAllowSubmit", {
			value: (t) => { if (t === token) allowed = 1; },
		});
		const blocked = () => { window.__jobaculatorBlockedSubmits = (window.__jobaculatorBlockedSubmits || 0) + 1; };
		document.addEventListener("submit", (event) => {
			if (allowed > 0) { allowed--; return; }
			event.preventDefault();
			event.stopImmediatePropagation();
			blocked();
		}, true);
		HTMLFormElement.prototype.submit = blocked;
		HTMLFormElement.prototype.requestSubmit = blocked;
	})();`);
}

/** How many form submissions the frames of the page attempted and had cancelled. */
export async function blockedSubmissions(frames: readonly Frame[]): Promise<number> {
	let total = 0;
	for (const frame of frames) {
		total += await frame
			.evaluate(() => (window as unknown as { __jobaculatorBlockedSubmits?: number }).__jobaculatorBlockedSubmits ?? 0)
			.catch(() => 0);
	}
	return total;
}
