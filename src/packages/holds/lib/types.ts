/**
 * `contact_identity`: the Candidate lacks a name or email, so nothing of theirs is prepared (#21).
 * `journal`: the submit-intent journal could not be written, so no live run of theirs is dispatched (#22).
 */
export const HOLD_SCOPES = ["contact_identity", "journal"] as const;
export type HoldScope = (typeof HOLD_SCOPES)[number];
