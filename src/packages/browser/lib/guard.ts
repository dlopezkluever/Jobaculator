/// <reference lib="dom" />
import type { BrowserContext, Frame, Locator } from "playwright";
import type { RunEventSink } from "./types";

// The guarded action layer (§10, #17): every browser action goes through it, so no click,
// Enter or form submit can bypass Dry Run. An action that might submit the application, and
// whose safety cannot be established, is refused and not performed. Nothing can authorize a
// final submission until SubmitGate lands (TB1-14).

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
};

/**
 * The only way drivers act on a page. `uploads` are the Package's files, the only ones a
 * field may upload (§14). Refusals are recorded as events and thrown as `UnsafeAction`.
 */
export function guardedActions(events: RunEventSink, uploads: readonly string[]): GuardedActions {
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
	};
}

/**
 * Defense in depth inside every page of the run: cancels every form submission, whether from
 * a submit event, `form.submit()` or `form.requestSubmit()`, and counts the attempts.
 */
export async function blockFormSubmission(context: BrowserContext): Promise<void> {
	// A string, so the page gets exactly this code whatever compiled the module.
	await context.addInitScript(`(() => {
		const blocked = () => { window.__jobaculatorBlockedSubmits = (window.__jobaculatorBlockedSubmits || 0) + 1; };
		document.addEventListener("submit", (event) => {
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
