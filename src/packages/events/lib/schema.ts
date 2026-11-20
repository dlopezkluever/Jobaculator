import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Append-only (ADR 0008); a trigger in the migrations rejects UPDATE and DELETE. */
export const event = pgTable(
	"event",
	{
		id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		userId: uuid("user_id").notNull(),
		subjectType: text("subject_type").notNull(),
		subjectId: text("subject_id").notNull(),
		code: text("code").notNull(),
		payload: jsonb("payload").notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("event_subject_idx").on(t.userId, t.subjectType, t.subjectId, t.id)],
);
