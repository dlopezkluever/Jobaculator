import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { LAUNCH_STEPS } from "./types";

/**
 * Global (ADR 0006): one row per recorded launch-gate step (§17), such as a passed restore
 * drill or the journal's activation. Rows are only ever added.
 */
export const launchStep = pgTable(
	"launch_step",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		step: text("step", { enum: LAUNCH_STEPS }).notNull(),
		/** What the recording command reports, such as the drill's recovery point; never secrets. */
		detail: jsonb("detail").$type<Record<string, string>>().notNull().default({}),
		recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("launch_step_step_idx").on(t.step, t.recordedAt)],
);
