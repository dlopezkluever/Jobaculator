import { type SQL, sql } from "drizzle-orm";
import { opportunity } from "../../discovery/tables";
import { application } from "./schema";

/** Opportunity Value (#29): high Fit is at least this, a posting is recent when known and at most this old. */
export const OPPORTUNITY_VALUE = { highFit: 80, recentDays: 3 } as const;

/**
 * The Opportunity Value tier (§5) of an Application joined with its Opportunity: 1 is high Fit
 * and recent, 4 acceptable and older. Order by it, then Fit descending.
 */
export function valueTier(now: Date): SQL<number> {
	const recentSince = new Date(now.getTime() - OPPORTUNITY_VALUE.recentDays * 24 * 60 * 60 * 1000).toISOString();
	const recent = sql`${opportunity.postedAt} >= ${recentSince}::timestamptz`;
	const high = sql`${application.fit} >= ${OPPORTUNITY_VALUE.highFit}`;
	// An unknown age compares as null, so it falls to the older tier: no boost, no penalty.
	return sql<number>`case when ${high} and ${recent} then 1 when ${high} then 2 when ${recent} then 3 else 4 end`;
}
