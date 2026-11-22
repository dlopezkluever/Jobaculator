import { foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { opportunity } from "../../discovery/tables";
import { hunt } from "../../hunts/tables";
import { user } from "../../users/tables";
import { type Attributes, DECISIONS, DECISIVE_REASONS, type DimensionJudgement, MATCH_STATUSES } from "./types";

/** One Hunt's judgement of one Opportunity (ADR 0001): qualification, Fit and the policy decision. */
export const match = pgTable(
	"match",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		huntId: uuid("hunt_id")
			.notNull()
			.references(() => hunt.id, { onDelete: "cascade" }),
		opportunityId: uuid("opportunity_id").notNull(),
		status: text("status", { enum: MATCH_STATUSES }).notNull().default("PENDING"),
		/** Bumped by every request to evaluate; an evaluation writes only if no newer request came in meanwhile. */
		revision: integer("revision").notNull().default(0),
		fit: integer("fit"),
		decision: text("decision", { enum: DECISIONS }),
		reason: text("reason", { enum: DECISIVE_REASONS }),
		dimensions: jsonb("dimensions").$type<DimensionJudgement[]>(),
		evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique().on(t.huntId, t.opportunityId),
		index("match_user_opportunity_idx").on(t.userId, t.opportunityId),
		foreignKey({
			columns: [t.opportunityId, t.userId],
			foreignColumns: [opportunity.id, opportunity.userId],
		}).onDelete("cascade"),
	],
);

/**
 * The cached LLM extraction of one Opportunity (§7): Hunt-independent, so every Hunt reuses
 * it. `inputHash` covers the text it read, so a changed posting is extracted again.
 */
export const opportunityExtraction = pgTable(
	"opportunity_extraction",
	{
		opportunityId: uuid("opportunity_id").primaryKey(),
		userId: uuid("user_id").notNull(),
		inputHash: text("input_hash").notNull(),
		attributes: jsonb("attributes").$type<Attributes>().notNull(),
		/** The `ai_call` that produced it. */
		callId: uuid("call_id").notNull(),
		extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		foreignKey({
			columns: [t.opportunityId, t.userId],
			foreignColumns: [opportunity.id, opportunity.userId],
		}).onDelete("cascade"),
	],
);
