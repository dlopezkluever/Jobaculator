import {
	boolean,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { opportunity } from "../../discovery/tables";
import { hunt } from "../../hunts/tables";
import { match } from "../../matching/tables";
import { user } from "../../users/tables";
import { APPLICATION_STATUSES, type FrozenEvaluation } from "./types";

/** The single attempt to apply to one Opportunity (ADR 0001): at most one per Opportunity. */
export const application = pgTable(
	"application",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		opportunityId: uuid("opportunity_id").notNull(),
		/** Fixed at creation: the highest-fit Match that wanted to apply. */
		drivingHuntId: uuid("driving_hunt_id")
			.notNull()
			.references(() => hunt.id),
		drivingMatchId: uuid("driving_match_id")
			.notNull()
			.references(() => match.id),
		status: text("status", { enum: APPLICATION_STATUSES }).notNull().default("PREPARING"),
		/** The Driving Hunt's Fit, frozen: Opportunity Value orders by it. */
		fit: integer("fit").notNull(),
		review: boolean("review").notNull(),
		evaluation: jsonb("evaluation").$type<FrozenEvaluation>().notNull(),
		/** When the dispatcher handed this PREPARING Application to `prepare`; null while it waits its turn. */
		preparationDispatchedAt: timestamp("preparation_dispatched_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("application_id_user_key").on(t.id, t.userId),
		unique("application_user_opportunity_key").on(t.userId, t.opportunityId),
		index("application_status_idx").on(t.status, t.preparationDispatchedAt),
		foreignKey({
			columns: [t.opportunityId, t.userId],
			foreignColumns: [opportunity.id, opportunity.userId],
		}).onDelete("cascade"),
	],
);
