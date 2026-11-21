import { z } from "zod";
import { defineEvent } from "../../events/index";
import { CONTENT_FIELDS } from "./normalize";

/** Opportunity events are recorded against this subject type. */
export const OPPORTUNITY_SUBJECT = "opportunity";

const sightingId = z.uuid();

export const postingDiscovered = defineEvent({
	code: "posting_discovered",
	subject: OPPORTUNITY_SUBJECT,
	payload: z.object({ sightingId }),
});
/** Another post proven to be the same Opportunity, and which exact key proved it. */
export const postingSighted = defineEvent({
	code: "posting_sighted",
	subject: OPPORTUNITY_SUBJECT,
	payload: z.object({ sightingId, matchedBy: z.enum(["posting", "requisition", "url"]) }),
});
/** Which normalized fields of one Sighting changed; Matches re-evaluate for future decisions only (§6). */
export const postingChanged = defineEvent({
	code: "posting_changed",
	subject: OPPORTUNITY_SUBJECT,
	payload: z.object({ sightingId, changed: z.array(z.enum(CONTENT_FIELDS)).min(1) }),
});
/** Every Sighting closed. */
export const postingClosed = defineEvent({
	code: "posting_closed",
	subject: OPPORTUNITY_SUBJECT,
	payload: z.object({}),
});
export const postingReopened = defineEvent({
	code: "posting_reopened",
	subject: OPPORTUNITY_SUBJECT,
	payload: z.object({ sightingId }),
});
