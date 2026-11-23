/// <reference lib="dom" />
import type { BrowserContext, Frame, Page } from "playwright";
import { capture } from "./evidence";
import { defaultFillers, type FormAdapter, type FormField, runFormSession } from "./form-session";
import { type GuardedActions, guardedActions } from "./guard";
import type { Driver, FieldType, PackagePort } from "./types";

// The Greenhouse adapter (§10): the hosted form and the embed employers put on their own
// career pages. Only what is site-specific lives here: recognizing the form, its widgets
// (react-select, the async location search, intl-tel-input, file uploads) and its field ids.

const HOSTED = /^(job-boards|boards)(\.eu)?\.greenhouse\.io$/;
const EMBED = /^https:\/\/(job-boards|boards)(\.eu)?\.greenhouse\.io\/embed\/job_app\b/;
const FORM = "form#application-form";
/** The classic EEO block; the schema's `race` appears on the page only after "Hispanic/Latino". */
const EEO_KEYS = new Set(["gender", "race", "hispanic_ethnicity", "veteran_status", "disability_status"]);
/** The page's async city search answers the schema's `location` question. */
const LOCATION_KEY = "candidate-location";

const id = (key: string) => `[id=${JSON.stringify(key)}]`;
const normal = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

/** The frame with the form: the page itself, or the Greenhouse embed inside it. */
async function formFrame(page: Page): Promise<Frame | null> {
	if (HOSTED.test(new URL(page.url()).hostname) && (await page.locator(FORM).count()) > 0) return page.mainFrame();
	for (const frame of page.frames()) {
		if (EMBED.test(frame.url()) && (await frame.locator(FORM).count()) > 0) return frame;
	}
	return null;
}

/**
 * In the page: every field of the form, the way a person would see it. No inner functions:
 * runners that keep function names would make the page call a helper it does not have.
 */
function discoverFields(selector: { form: string; eeo: string[]; location: string }) {
	const form = document.querySelector(selector.form);
	const fields: { key: string; label: string; type: string; required: boolean; section: string }[] = [];
	if (!form) return fields;
	for (const el of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
		if (!el.id || el.disabled || el.type === "hidden" || el.type === "search" || el.type === "file") continue;
		// The phone widget's country list and search are not fields of the application.
		if (el.closest(".iti__dropdown-content, .iti__country-container")) continue;
		const labelled = (document.getElementById(`${el.id}-label`) ?? el.labels?.[0]) as HTMLElement | null | undefined;
		const label = labelled?.innerText?.trim() || el.getAttribute("aria-label") || "";
		let type = el instanceof HTMLTextAreaElement ? "textarea" : el.type === "checkbox" ? "checkbox" : "text";
		if (el.getAttribute("role") === "combobox") {
			const multi = el.closest(".select__control")?.querySelector(".select__value-container--is-multi");
			type = el.id === selector.location ? "search" : multi ? "multi_select" : "select";
		}
		fields.push({
			key: el.id,
			label: label.replace(/\s*\*\s*$/, "").trim(),
			type,
			required: el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label),
			section: selector.eeo.includes(el.id) ? "eeo" : "application",
		});
	}
	// An upload is a group whose input is replaced by the file's name once it is attached.
	for (const group of form.querySelectorAll('[role=group][aria-labelledby^="upload-label-"]')) {
		const labelId = group.getAttribute("aria-labelledby") ?? "";
		const label = (document.getElementById(labelId) as HTMLElement | null)?.innerText?.trim() ?? "";
		fields.push({
			key: labelId.slice("upload-label-".length),
			label: label.replace(/\s*\*\s*$/, "").trim(),
			type: "file",
			required: group.getAttribute("aria-required") === "true" || /\*\s*$/.test(label),
			section: "application",
		});
	}
	return fields;
}

/** Greenhouse's widgets. Every interaction goes through the guarded action layer. */
function greenhouseForm(frame: Frame, actions: GuardedActions): FormAdapter {
	const options = (field: FormField) => frame.locator(`[id^=${JSON.stringify(`react-select-${field.key}-option`)}]`);
	const chosen = async (field: FormField) =>
		frame.locator(id(field.key)).evaluate((el) =>
			[
				...(el.closest(".select__control")?.querySelectorAll(".select__single-value, .select__multi-value__label") ??
					[]),
			].map((v) => {
				// The phone country picker shows only a flag and the dialing code ("+1"); its option read "United States +1".
				const flag = [...(v.querySelector(".iti__flag")?.classList ?? [])].find((c) => /^iti__[a-z]{2}$/.test(c));
				const text = (v as HTMLElement).innerText.trim();
				if (!flag) return text;
				const region = new Intl.DisplayNames(["en"], { type: "region" }).of(flag.slice(5).toUpperCase());
				return `${region} ${text}`;
			}),
		);
	/** Opens the menu and clicks the option whose label is `choice`; on a retry, types it to filter first. */
	const pick = async (field: FormField, choice: string, attempt: number) => {
		const input = frame.locator(id(field.key));
		await actions.click(input);
		if (attempt > 0) await actions.type(input, choice);
		await options(field).first().waitFor({ timeout: 5_000 });
		const labels = await options(field).allInnerTexts();
		const index = labels.findIndex((label) => normal(label) === normal(choice));
		if (index < 0) {
			await actions.press(input, "Escape");
			throw new Error("the menu has no such option");
		}
		await actions.click(options(field).nth(index));
	};
	const select = {
		async fill(field: FormField, value: string[], attempt: number) {
			const shown = (await chosen(field)).map(normal);
			for (const choice of value) if (!shown.includes(normal(choice))) await pick(field, choice, attempt);
		},
		observe: chosen,
	};
	const upload = (field: FormField) =>
		frame.locator(`[aria-labelledby=${JSON.stringify(`upload-label-${field.key}`)}]`);
	const defaults = defaultFillers(frame, actions);
	const fillers: Partial<Record<FieldType, FormAdapter["fillers"][FieldType]>> = {
		...defaults,
		select,
		multi_select: select,
		search: {
			// Type the place's first part, then take the result that reads like the answer, else the first.
			async fill(field, [value = ""], attempt) {
				const input = frame.locator(id(field.key));
				const query = (attempt === 0 ? value.split(",")[0] : value.split(/[\s,]+/)[0])?.trim() ?? value;
				await actions.click(input);
				await actions.type(input, query);
				await options(field).first().waitFor({ timeout: 8_000 });
				const labels = (await options(field).allInnerTexts()).map(normal);
				const exact = labels.indexOf(normal(value));
				const prefixed = labels.findIndex((label) => label.startsWith(normal(value)));
				await actions.click(options(field).nth(exact >= 0 ? exact : Math.max(prefixed, 0)));
			},
			observe: chosen,
		},
		file: {
			async fill(field, [path = ""], attempt) {
				// The form fetches its upload fields as it loads; a retry waits for them.
				if (attempt > 0) await frame.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
				await actions.upload(upload(field).locator('input[type="file"]'), path);
				await upload(field)
					.locator(".file-upload__filename")
					.waitFor({ timeout: 15_000 })
					.catch(() => {});
			},
			async observe(field) {
				const name = upload(field).locator(".file-upload__filename");
				return (await name.count()) > 0 ? [(await name.innerText()).trim()] : [];
			},
		},
	};
	return {
		discover: async () =>
			(await frame.evaluate(discoverFields, {
				form: FORM,
				eeo: [...EEO_KEYS],
				location: LOCATION_KEY,
			})) as FormField[],
		// The schema's `location` is the page's city search. Other renamed fields match by label.
		schemaId: (field) => (field.key === LOCATION_KEY ? "location" : field.key),
		async options(field) {
			const input = frame.locator(id(field.key));
			await actions.click(input);
			await options(field)
				.first()
				.waitFor({ timeout: 5_000 })
				.catch(() => {});
			const labels = (await options(field).allInnerTexts()).map((label) => label.trim()).filter(Boolean);
			await actions.press(input, "Escape");
			return labels;
		},
		document: (field) => (field.key === "resume" ? "resume" : field.key === "cover_letter" ? "coverLetter" : null),
		fillers,
	};
}

/**
 * Defense in depth for a Dry Run (§10): no write reaches the form's own hosts, where the final
 * submission goes. Uploads go to storage elsewhere and still happen (a Dry Run uploads, #19).
 */
async function blockFormWrites(context: BrowserContext): Promise<void> {
	await context.route(/^https:\/\/(job-boards|boards)(\.eu)?\.greenhouse\.io\//, (route) =>
		route.request().method() === "GET" ? route.fallback() : route.abort("blockedbyclient"),
	);
}

const documentPaths = (documents: PackagePort["documents"]) =>
	Object.values(documents).flatMap((file) => (file ? [file.path] : []));

export const greenhouseDriver: Driver = {
	name: "greenhouse",
	matches: async (_url, page) => (await formFrame(page)) !== null,
	async run(input) {
		const { page, events, signal } = input;
		const frame = await formFrame(page);
		if (!frame) return { kind: "failed", category: "SITE_CHANGED", detail: "no form", url: page.url(), fields: [] };
		await events.record({ type: "driver_selected", driver: "greenhouse", embedded: frame !== page.mainFrame() });
		if (input.mode === "dry") await blockFormWrites(page.context());
		const actions = guardedActions(events, documentPaths(input.package.documents));
		await capture(page, events, "Form opened", frame.locator(FORM));
		const result = await runFormSession({
			adapter: greenhouseForm(frame, actions),
			package: input.package,
			events,
			signal,
		});
		await capture(page, events, "Form filled", frame.locator(FORM));
		if (result.failure) {
			await events.record({ type: "failed", category: result.failure.category });
			return { kind: "failed", ...result.failure, url: page.url(), fields: result.fields };
		}
		await events.record({ type: "stopped_before_submit" });
		return { kind: "dry_run_complete", url: page.url(), fields: result.fields };
	},
};
