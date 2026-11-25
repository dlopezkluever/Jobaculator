import type { Page } from "playwright";
import type { Attribution, LlmClient } from "../../ai/index";
import type { Confirmation, FailureCategory, FieldRecord, RunEvent, RunMode } from "../../applications/index";
import type { ApplicationQuestion } from "../../discovery/index";
import type { ApplicationAnswer } from "../../generation/index";

// The Browser Run's record (modes, events, the field ledger, failure categories) is the
// `applications` module's: it stores them on the `browser_run` row.
export type {
	ClassifiedBy,
	Confirmation,
	FailureCategory,
	FieldRecord,
	FieldType,
	RunEvent,
	RunMode,
} from "../../applications/index";

/** Where a Browser Run's events and evidence go: the `browser_run` row (§10). */
export type RunEventSink = {
	record(event: RunEvent): Promise<void>;
	/** Stores a screenshot and returns its evidence ref. */
	evidence(label: string, png: Buffer): Promise<string>;
};

/** The run's model access (§12), on the run's attribution: bounded failure classification (§10). */
export type RunAi = { llm: LlmClient; attribution: Attribution };

/** A file from the current Package that a field may upload (§14: uploads only from the Package). */
export type PackageFile = { path: string; filename: string };

/** The Package as a Browser Run sees it (§10): answers first, generation for the gaps. */
export type PackagePort = {
	/** The posting's public form schema (`questions=true`): it seeds discovery; the page is the truth. */
	schema: readonly ApplicationQuestion[];
	answers: readonly ApplicationAnswer[];
	/** Answers questions the Package has none for, mid-run (§9), and saves them onto the Package. */
	generateMissing(questions: ApplicationQuestion[]): Promise<ApplicationAnswer[]>;
	documents: { resume: PackageFile | null; coverLetter: PackageFile | null };
};

/**
 * The submit boundary (§5, §10): the journal entry, then the boundary transaction. True: the
 * run may perform the final click now, once. False: refused before the boundary (a journal
 * Hold, the launch gate, the recovery marker, the canary User); stop without submitting.
 * Only `live` runs ask; a Dry Run never does.
 */
export type SubmitGate = {
	/** `fields`: the form as the run leaves it before the final click, frozen with the Package revision. */
	cross(fields: FieldRecord[]): Promise<boolean>;
};

export type RunInput = {
	page: Page;
	mode: RunMode;
	package: PackagePort;
	events: RunEventSink;
	gate: SubmitGate;
	signal: AbortSignal;
	/** How long the page has to confirm after the final click. */
	confirmationTimeoutMs: number;
};

/**
 * The Browser Run's result (§10), not an Application state. After the final click only a
 * positive confirmation is `submitted`; anything else is `submit_unknown`. Review-ready is TB3's.
 */
export type RunOutcome =
	| { kind: "dry_run_complete"; url: string; fields: FieldRecord[] }
	| { kind: "submitted"; confirmation: Confirmation; url: string; fields: FieldRecord[] }
	| { kind: "submit_unknown"; detail: string; url: string | null; fields: FieldRecord[] }
	/** Before the boundary. A driver reports its own finding; the runner classifies it (§10). */
	| { kind: "failed"; category: FailureCategory; detail: string; url: string | null; fields: FieldRecord[] }
	| { kind: "aborted"; reason: string; url: string | null; fields: FieldRecord[] };

/** An ATS adapter or the general agent (§10). `browser_run` never knows which one ran. */
export type Driver = {
	name: string;
	/** Whether this driver handles the page: its URL, or a form embedded in it. */
	matches(url: string, page: Page): Promise<boolean>;
	run(input: RunInput): Promise<RunOutcome>;
};
