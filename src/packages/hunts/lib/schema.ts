import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "../../users/tables";
import {
	CREATIVE_LATITUDES,
	HUNT_STATUSES,
	type HuntCriteria,
	SUBMISSION_MODES,
	SUBMISSION_POLICIES,
} from "../criteria";

/** A persistent search for one kind of role. Criteria are validated by `huntCriteriaSchema` before every write. */
export const hunt = pgTable(
	"hunt",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		status: text("status", { enum: HUNT_STATUSES }).notNull().default("ACTIVE"),
		criteria: jsonb("criteria").$type<HuntCriteria>().notNull(),
		creativeLatitude: text("creative_latitude", { enum: CREATIVE_LATITUDES }).notNull(),
		submissionPolicy: text("submission_policy", { enum: SUBMISSION_POLICIES }).notNull().default("AUTO"),
		/** Overrides the global submission mode for the Hunt's Applications; null follows it (§5). */
		submissionMode: text("submission_mode", { enum: SUBMISSION_MODES }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("hunt_user_idx").on(t.userId, t.createdAt)],
);
