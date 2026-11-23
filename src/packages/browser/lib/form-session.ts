import type { Frame } from "playwright";
import type { ApplicationQuestion, QuestionType } from "../../discovery/index";
import type { ApplicationAnswer } from "../../generation/index";
import { type GuardedActions, UnsafeAction } from "./guard";
import type { FailureCategory, FieldRecord, FieldType, PackagePort, RunEventSink } from "./types";

// `FormSession` (§10, #17): the toolkit every driver fills forms with, a bounded
// Discover → Answer → Fill → Verify → Re-discover loop. The page is the truth: the posting's
// public schema only seeds it, and a field is required when either says so. Answers come from
// the Package, gaps from `generateMissing`. Verification drives correction, not interruption.

/** One field as discovered on the page. */
export type FormField = {
	key: string;
	label: string;
	type: FieldType;
	required: boolean;
	section: "application" | "eeo";
};

export type Filler = {
	/** Puts `value` in the field; `attempt` > 0 asks for an alternative strategy. */
	fill(field: FormField, value: string[], attempt: number): Promise<void>;
	/** What the field shows now. */
	observe(field: FormField): Promise<string[]>;
};

/** What a driver supplies: discovery, its widgets' fillers (overriding the defaults) and its schema ids. */
export type FormAdapter = {
	discover(): Promise<FormField[]>;
	/** The schema question a page field answers, when its id differs on the page. */
	schemaId(field: FormField): string;
	/** A select's choices, read from the page, for a question the schema does not list. */
	options(field: FormField): Promise<string[]>;
	/** Which Package document a file field takes. */
	document(field: FormField): keyof PackagePort["documents"] | null;
	fillers: Partial<Record<FieldType, Filler>>;
};

export type SessionResult = {
	fields: FieldRecord[];
	/** Null when every required field shows a value. */
	failure: { category: FailureCategory; detail: string } | null;
};

/** Discovery rounds: conditional fields appear after others are answered. */
const MAX_ROUNDS = 4;
/** Fill attempts per field: the filler's own strategy, then its alternative. */
const MAX_ATTEMPTS = 2;

const normal = (value: string) =>
	value
		.toLowerCase()
		.replace(/[’']/g, "'")
		.replace(/[^\p{L}\p{N}' ]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
const digits = (value: string) => value.replace(/\D+/g, "");

/** Whether the page shows what was meant to be there. */
function satisfied(type: FieldType, value: string[], observed: string[]): boolean {
	if (value.length === 0) return true;
	const [want = ""] = value;
	const [seen = ""] = observed;
	switch (type) {
		case "file":
			return observed.some((o) => o.includes(want));
		case "search":
			return observed.length > 0;
		case "checkbox":
			return seen === "checked";
		case "multi_select":
			return value.length === observed.length && value.every((v) => observed.some((o) => normal(o) === normal(v)));
		default:
			// A phone field may reformat the number it is given.
			return normal(seen) === normal(want) || (digits(want).length >= 7 && digits(seen) === digits(want));
	}
}

const QUESTION_TYPES: Record<FieldType, QuestionType> = {
	text: "text",
	textarea: "textarea",
	search: "text",
	select: "single_select",
	multi_select: "multi_select",
	checkbox: "single_select",
	file: "file",
};

/** The generic fillers: plain inputs by id. Drivers override what their widgets need. */
export function defaultFillers(
	frame: Frame,
	actions: GuardedActions,
): Record<"text" | "textarea" | "checkbox", Filler> {
	const input = (field: FormField) => frame.locator(`[id=${JSON.stringify(field.key)}]`);
	const text: Filler = {
		async fill(field, [value = ""], attempt) {
			if (attempt === 0) return actions.fill(input(field), value);
			await actions.fill(input(field), "");
			await actions.type(input(field), value);
		},
		observe: async (field) => {
			const value = await input(field).inputValue();
			return value ? [value] : [];
		},
	};
	return {
		text,
		textarea: text,
		checkbox: {
			async fill(field) {
				if (!(await input(field).isChecked())) await actions.click(input(field));
			},
			observe: async (field) => ((await input(field).isChecked()) ? ["checked"] : []),
		},
	};
}

/**
 * Runs the loop until no new field appears (bounded), then re-reads every field. A required
 * field that still shows nothing fails the session, with the category that explains why.
 */
export async function runFormSession(options: {
	adapter: FormAdapter;
	package: PackagePort;
	events: RunEventSink;
	signal: AbortSignal;
}): Promise<SessionResult> {
	const { adapter, events, signal } = options;
	const pkg = options.package;
	const schema = new Map(pkg.schema.map((q) => [q.id, q]));
	const answers = new Map(pkg.answers.map((a) => [a.question.id, a]));
	const byLabel = (label: string) => pkg.schema.find((q) => normal(q.label) === normal(label));
	const handled = new Map<string, { field: FormField; record: FieldRecord; answer: ApplicationAnswer | null }>();

	const filler = (type: FieldType) => {
		const found = adapter.fillers[type];
		if (!found) throw new Error(`no filler for ${type} fields`);
		return found;
	};

	for (let round = 1; round <= MAX_ROUNDS; round++) {
		signal.throwIfAborted();
		const fields = await adapter.discover();
		const fresh = fields.filter((f) => !handled.has(f.key));
		await events.record({ type: "fields_discovered", round, fields: fields.length, new: fresh.length });
		if (fresh.length === 0) break;

		// Answer: the Package first, then one mid-run generation call for the gaps.
		const planned = fresh.map((field) => {
			const question = schema.get(adapter.schemaId(field)) ?? byLabel(field.label);
			const merged: FormField = {
				...field,
				required: field.required || (question?.required ?? false),
				section: question?.section ?? field.section,
			};
			// A field the schema lacks keeps the answer an earlier run generated under its own id.
			const answer = answers.get(question?.id ?? adapter.schemaId(field)) ?? null;
			return { field: merged, question, answer };
		});
		const gaps = planned.filter((p) => p.field.type !== "file" && !p.answer);
		if (gaps.length > 0) {
			const questions: ApplicationQuestion[] = [];
			for (const gap of gaps) {
				const known = gap.question;
				const choosing = gap.field.type === "select" || gap.field.type === "multi_select";
				const labels = known?.options.length ? [] : choosing ? await adapter.options(gap.field) : [];
				questions.push(
					known && !labels.length
						? known
						: {
								id: known?.id ?? gap.field.key,
								label: gap.field.label,
								description: known?.description ?? null,
								required: gap.field.required,
								type: QUESTION_TYPES[gap.field.type],
								options: labels.map((label) => ({ label, value: label, decline: false })),
								section: gap.field.section,
							},
				);
			}
			const generated = await pkg.generateMissing(questions);
			await events.record({ type: "answers_generated", round, questions: questions.length });
			for (const answer of generated) answers.set(answer.question.id, answer);
			for (const [i, gap] of gaps.entries()) {
				const id = questions[i]?.id;
				gap.answer = id ? (answers.get(id) ?? null) : null;
			}
		}

		// Fill, and verify each field by reading it back.
		let filled = 0;
		let failed = 0;
		for (const { field, answer } of planned) {
			signal.throwIfAborted();
			const doc = field.type === "file" ? adapter.document(field) : null;
			const file = doc ? pkg.documents[doc] : null;
			const value =
				field.type === "file"
					? file
						? [file.filename]
						: []
					: !answer
						? []
						: field.type === "checkbox"
							? answer.text || answer.choices.length
								? ["checked"]
								: []
							: answer.text
								? [answer.text]
								: answer.choices;
			const generated = answer !== null && !pkg.answers.includes(answer);
			const record: FieldRecord = {
				key: field.key,
				label: field.label,
				type: field.type,
				required: field.required,
				section: field.section,
				source: value.length === 0 ? "blank" : field.type === "file" ? "document" : generated ? "generated" : "package",
				value,
				observed: [],
				ok: false,
			};
			const fill = filler(field.type);
			const upload = field.type === "file" && file ? [file.path] : value;
			for (let attempt = 0; attempt < MAX_ATTEMPTS && value.length > 0; attempt++) {
				try {
					await fill.fill(field, upload, attempt);
				} catch (error) {
					// A refused action is never retried another way; anything else tries the alternative.
					if (error instanceof UnsafeAction) break;
				}
				record.observed = await fill.observe(field).catch(() => []);
				if (satisfied(field.type, value, record.observed)) break;
			}
			record.ok = satisfied(field.type, value, record.observed) && (value.length > 0 || !field.required);
			if (value.length > 0) record.ok ? filled++ : failed++;
			handled.set(field.key, { field, record, answer });
		}
		await events.record({ type: "fields_filled", round, filled, failed });
	}

	// Verify the whole form once more: later fields can reset earlier ones.
	for (const { field, record } of handled.values()) {
		record.observed = await filler(field.type)
			.observe(field)
			.catch(() => []);
		record.ok = satisfied(field.type, record.value, record.observed) && (record.value.length > 0 || !field.required);
	}
	const all = [...handled.values()];
	const missing = all.filter(({ record }) => record.required && !record.ok);
	await events.record({
		type: "verified",
		fields: all.length,
		required: all.filter(({ record }) => record.required).length,
		missing: missing.length,
	});
	return { fields: all.map(({ record }) => record), failure: missing.length > 0 ? explain(missing) : null };
}

/** Why required fields are still empty, most decisive reason first. */
function explain(
	missing: { field: FormField; record: FieldRecord; answer: ApplicationAnswer | null }[],
): SessionResult["failure"] {
	const escalated = missing.find((m) => m.answer?.escalation);
	if (escalated?.answer?.escalation) {
		return { category: escalated.answer.escalation, detail: "a required question needs the Candidate" };
	}
	if (missing.some((m) => m.field.type === "file" && m.record.value.length === 0)) {
		return { category: "UNSUPPORTED_FLOW", detail: "a required document is not in the Package" };
	}
	if (missing.some((m) => m.field.type === "file")) {
		return { category: "UPLOAD_FAILURE", detail: "a document did not upload" };
	}
	if (missing.some((m) => m.record.value.length > 0)) {
		return { category: "SITE_CHANGED", detail: "a required field did not take its answer" };
	}
	return { category: "UNKNOWN", detail: "a required field has no answer" };
}
