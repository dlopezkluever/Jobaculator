import type { ApplicationAnswer, JobSnapshot } from "../../generation/index";
import type { Decision, DecisiveReason, DimensionJudgement } from "../../matching/index";

/** Application events are recorded against this subject type; read them with `listEvents`. */
export const APPLICATION_SUBJECT = "application";

/** The Application lifecycle (§4, #9, ADR 0002): it ends at SUBMITTED; no outcome or duplicate states. */
export const APPLICATION_STATUSES = [
	"PREPARING",
	"READY",
	"APPLYING",
	"IN_REVIEW",
	"SUBMITTING",
	"SUBMITTED",
	"SUBMIT_UNKNOWN",
	"NEEDS_YOU",
	"ABANDONED",
	"EXPIRED",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/**
 * Every allowed transition (§5, #12). Nothing leaves SUBMITTED; SUBMITTING ends only in
 * SUBMITTED or SUBMIT_UNKNOWN, and SUBMIT_UNKNOWN never goes back to APPLYING or SUBMITTING
 * by itself: only the Candidate's "it didn't go through" makes it READY again (ADR 0004).
 */
export const TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
	// Package ready; a missing required document; the Candidate declines; the posting closes.
	PREPARING: ["READY", "NEEDS_YOU", "ABANDONED", "EXPIRED"],
	// A Browser Run starts.
	READY: ["APPLYING", "NEEDS_YOU", "ABANDONED", "EXPIRED"],
	// Review stop; the submit boundary; a pre-boundary failure or finished Dry Run; an Intervention.
	APPLYING: ["IN_REVIEW", "SUBMITTING", "READY", "NEEDS_YOU", "EXPIRED"],
	// Approved (refill_and_submit), or abandoned, or the posting closes while waiting.
	IN_REVIEW: ["APPLYING", "ABANDONED", "EXPIRED"],
	SUBMITTING: ["SUBMITTED", "SUBMIT_UNKNOWN"],
	SUBMITTED: [],
	// Candidate only: went through, didn't (fresh attempts), or Skip.
	SUBMIT_UNKNOWN: ["SUBMITTED", "READY", "ABANDONED"],
	// Retry agent, Take over, Skip, or the posting closes.
	NEEDS_YOU: ["READY", "APPLYING", "ABANDONED", "EXPIRED"],
	// Revived by the Candidate only.
	ABANDONED: ["PREPARING", "READY"],
	// The posting reopened: the same Application is reconsidered.
	EXPIRED: ["PREPARING", "READY"],
};

/** The Match evaluation and policy that authorized the Application, frozen at creation (ADR 0001). */
export type FrozenEvaluation = {
	matchId: string;
	huntId: string;
	fit: number;
	decision: Decision;
	reason: DecisiveReason;
	dimensions: DimensionJudgement[];
	evaluatedAt: string;
	submissionPolicy: string;
	/** Whether any qualifying Match's explicit Review rule asks for Review before submission. */
	review: boolean;
};

/** The most recent AI failure while preparing: how many times in a row this same failure happened. */
export type PreparationFailure = { fingerprint: string; errorClass: string; count: number; at: string };

// ——— Browser Runs (§10, #17) ———

/** §5: what a Browser Run is for. `refill_and_submit` arrives with Review (TB3). */
export const RUN_MODES = ["dry", "live", "refill_and_submit"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** QUEUED: claimed, waiting for the worker. RUNNING: a worker owns it and heartbeats. ABORTED uses no attempt. */
export const BROWSER_RUN_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "ABORTED"] as const;
export type BrowserRunStatus = (typeof BROWSER_RUN_STATUSES)[number];

/** The closed §96 failure categories (§5 retry table). */
export const FAILURE_CATEGORIES = [
	"NETWORK",
	"BROWSER_FAILURE",
	"UPLOAD_FAILURE",
	"UNKNOWN",
	"SITE_CHANGED",
	"UNKNOWN_QUESTION",
	"CAPTCHA",
	"AUTH_REQUIRED",
	"AUTHORITATIVE_FACT_REQUIRED",
	"ASSESSMENT_REQUIRED",
	"UNSUPPORTED_FLOW",
	"JOB_EXPIRED",
	"DUPLICATE_APPLICATION",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * How a pre-boundary failure is classified (§10): `page` and `error` are deterministic rules
 * on what the page showed and what failed, `driver` is the adapter's own finding, `model` the
 * bounded LLM classification, `none` nothing decided (UNKNOWN).
 */
export type ClassifiedBy = "page" | "driver" | "error" | "model" | "none";

export type FieldType = "text" | "textarea" | "select" | "multi_select" | "search" | "file" | "checkbox";

/**
 * One form field as the Browser Run left it (§10, §11): what it meant to put there and what
 * the page showed afterwards. Observed form state, never claimed to be the network payload.
 */
export type FieldRecord = {
	/** The field on the page, such as `question_12497120004` or `resume`. */
	key: string;
	label: string;
	type: FieldType;
	required: boolean;
	section: "application" | "eeo";
	/** Where the value came from: the Package, generated mid-run, one of its documents, or nothing. */
	source: "package" | "generated" | "document" | "blank";
	/** Text, the chosen option labels, or the uploaded file's name. */
	value: string[];
	observed: string[];
	ok: boolean;
};

/** A compact typed event of a Browser Run (§10): codes, counts and evidence refs, no answers. */
export type RunEvent =
	| { type: "opened"; url: string; status: number | null }
	| { type: "driver_selected"; driver: string; embedded: boolean }
	| { type: "fields_discovered"; round: number; fields: number; new: number }
	| { type: "answers_generated"; round: number; questions: number }
	| { type: "fields_filled"; round: number; filled: number; failed: number }
	| { type: "action_refused"; action: string; reason: string }
	| { type: "screenshot"; label: string; ref: string }
	| { type: "verified"; fields: number; required: number; missing: number }
	| { type: "submit_blocked"; attempts: number }
	| { type: "stopped_before_submit" }
	| { type: "submit_refused" }
	| { type: "submit_clicked" }
	| { type: "confirmation_detected"; url: string }
	| { type: "no_confirmation"; detail: string }
	/** `by`: what decided the category (§10: deterministic detection first, then the model). */
	| { type: "failed"; category: FailureCategory; by?: ClassifiedBy };
export type StoredRunEvent = RunEvent & { at: string };

/** Where a Browser Run stopped (§11): the page, the field ledger and the Package files it uploaded. */
export type RunCheckpoint = { url: string | null; fields: FieldRecord[]; uploads: { key: string; blob: string }[] };
export type RunFailure = { category: FailureCategory; detail: string };

/** The positive confirmation a submission is recorded on (§10, §13: permanent evidence). */
export type Confirmation = {
	/** The confirmation the page showed, as text. */
	text: string;
	url: string;
	at: string;
	/** Evidence ref of the confirmation page's screenshot. */
	screenshot: string | null;
	/** An application id the page showed, if any. */
	applicationId: string | null;
};

/** OPEN: past the boundary, outcome not recorded. UNKNOWN: an Uncertain Submission, still open until the Candidate resolves it. */
export const SUBMIT_INTENT_STATUSES = ["OPEN", "SUBMITTED", "UNKNOWN", "NOT_SUBMITTED"] as const;
export type SubmitIntentStatus = (typeof SUBMIT_INTENT_STATUSES)[number];

/** The Package as it was submitted (§13), frozen at the boundary: what the employer received. */
export type PackageRevision = {
	jobSnapshot: JobSnapshot;
	answers: ApplicationAnswer[];
	/** Each uploaded file: its blob and the filename the employer saw. */
	files: { key: string; blob: string; filename: string }[];
	/** The fields as the run left them before the final click. */
	fields: FieldRecord[];
};

/**
 * What an Intervention asks the Candidate to resolve (§5): an Uncertain Submission, the
 * automatic Browser Runs used up, or a pre-boundary failure only they can get past.
 */
export const INTERVENTION_KINDS = [
	"SUBMIT_UNKNOWN",
	"ATTEMPTS_EXHAUSTED",
	"CAPTCHA",
	"AUTH_REQUIRED",
	"AUTHORITATIVE_FACT_REQUIRED",
	"ASSESSMENT_REQUIRED",
	"UNSUPPORTED_FLOW",
	"DUPLICATE_APPLICATION",
] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];
