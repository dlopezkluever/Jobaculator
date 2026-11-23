import type { Page } from "playwright";
import type { FailureCategory, FieldRecord, RunEvent, RunMode } from "../../applications/index";
import type { ApplicationQuestion } from "../../discovery/index";
import type { ApplicationAnswer } from "../../generation/index";

// The Browser Run's record (modes, events, the field ledger, failure categories) is the
// `applications` module's: it stores them on the `browser_run` row.
export type { FailureCategory, FieldRecord, FieldType, RunEvent, RunMode } from "../../applications/index";

/** Where a Browser Run's events and evidence go: the `browser_run` row (§10). */
export type RunEventSink = {
	record(event: RunEvent): Promise<void>;
	/** Stores a screenshot and returns its evidence ref. */
	evidence(label: string, png: Buffer): Promise<string>;
};

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

export type RunInput = {
	page: Page;
	mode: RunMode;
	package: PackagePort;
	events: RunEventSink;
	signal: AbortSignal;
};

/** The Browser Run's result (§10), not an Application state. Submitted and Review-ready arrive with TB1-14 and TB3. */
export type RunOutcome =
	| { kind: "dry_run_complete"; url: string; fields: FieldRecord[] }
	| { kind: "failed"; category: FailureCategory; detail: string; url: string | null; fields: FieldRecord[] }
	| { kind: "aborted"; reason: string; url: string | null; fields: FieldRecord[] };

/** An ATS adapter or the general agent (§10). `browser_run` never knows which one ran. */
export type Driver = {
	name: string;
	/** Whether this driver handles the page: its URL, or a form embedded in it. */
	matches(url: string, page: Page): Promise<boolean>;
	run(input: RunInput): Promise<RunOutcome>;
};
