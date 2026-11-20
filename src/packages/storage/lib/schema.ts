import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Global (ADR 0006): reached only through owner-scoped domain references. */
export const blob = pgTable("blob", {
	hash: text("hash").primaryKey(),
	size: bigint("size", { mode: "number" }).notNull(),
	mediaType: text("media_type").notNull(),
	retentionClass: text("retention_class").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
