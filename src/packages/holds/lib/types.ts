/** `contact_identity`: the Candidate lacks a name or email, so nothing of theirs is prepared (#21). */
export const HOLD_SCOPES = ["contact_identity"] as const;
export type HoldScope = (typeof HOLD_SCOPES)[number];
