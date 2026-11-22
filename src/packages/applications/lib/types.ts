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
