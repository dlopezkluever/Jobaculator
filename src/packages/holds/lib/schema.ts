import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "../../users/tables";
import { HOLD_SCOPES } from "./types";

/**
 * A scoped, automatic pause of the work that depends on one shared thing (§5). At most one
 * active Hold per owner and scope; a lifted Hold keeps its row. Only per-User scopes exist so
 * far; global scopes (site, disk, journal) will relax `user_id` when they arrive.
 */
export const hold = pgTable(
	"hold",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		scope: text("scope", { enum: HOLD_SCOPES }).notNull(),
		/** Reason codes only, such as the missing fact kinds (ADR 0008). */
		reason: text("reason").notNull(),
		raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
		liftedAt: timestamp("lifted_at", { withTimezone: true }),
	},
	(t) => [
		uniqueIndex("hold_active_idx").on(t.userId, t.scope).where(sql`${t.liftedAt} is null`),
		index("hold_user_idx").on(t.userId, t.raisedAt),
	],
);
