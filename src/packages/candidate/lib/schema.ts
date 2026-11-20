import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "../../users/tables";

/** The person the system represents; exactly one per User in Phase 0. Later tickets add the Knowledge Base under it. */
export const candidate = pgTable("candidate", {
	id: uuid("id").primaryKey().defaultRandom(),
	userId: uuid("user_id")
		.notNull()
		.unique()
		.references(() => user.id, { onDelete: "cascade" }),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
