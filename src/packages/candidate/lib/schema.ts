import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	foreignKey,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { user } from "../../users/tables";
import type { Provenance } from "../kinds";

/** The person the system represents; exactly one per User in Phase 0. */
export const candidate = pgTable("candidate", {
	id: uuid("id").primaryKey().defaultRandom(),
	userId: uuid("user_id")
		.notNull()
		.unique()
		.references(() => user.id, { onDelete: "cascade" }),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Who said a Fact's value, and what exactly they said (so a precision merge shows which part only one source supports). */
export type StoredSource =
	| { kind: "candidate"; via: string; stated: string; at: string }
	| { kind: "document"; documentId: string; stated: string; inferred: boolean; evidence?: string[]; at: string };

/** One thing in the Candidate's history that Facts group under. A parent is at most one level up. */
export const candidateEntry = pgTable(
	"candidate_entry",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => candidate.userId, { onDelete: "cascade" }),
		kind: text("kind").notNull(),
		parentId: uuid("parent_id"),
		// clock_timestamp, not now(): rows written in one transaction keep their order.
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
	},
	(t) => [
		unique("candidate_entry_id_user_key").on(t.id, t.userId),
		// Composite keys keep every link inside one User (ADR 0006).
		foreignKey({ columns: [t.parentId, t.userId], foreignColumns: [t.id, t.userId] }),
		index("candidate_entry_user_idx").on(t.userId),
	],
);

/**
 * One claim about the Candidate (#10). Edited in place and soft-deleted; no version history.
 * A Fact the Candidate corrected points at the correction through `superseded_by`; Facts
 * sharing a `conflict_group` contradict each other and are kept linked.
 */
export const candidateFact = pgTable(
	"candidate_fact",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => candidate.userId, { onDelete: "cascade" }),
		entryId: uuid("entry_id"),
		kind: text("kind").notNull(),
		value: text("value").notNull(),
		provenance: text("provenance").$type<Provenance>().notNull(),
		authoritative: boolean("authoritative").notNull(),
		verified: boolean("verified").notNull(),
		sources: jsonb("sources").$type<StoredSource[]>().notNull(),
		conflictGroup: uuid("conflict_group"),
		supersededBy: uuid("superseded_by"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
	},
	(t) => [
		unique("candidate_fact_id_user_key").on(t.id, t.userId),
		foreignKey({ columns: [t.entryId, t.userId], foreignColumns: [candidateEntry.id, candidateEntry.userId] }),
		foreignKey({
			columns: [t.supersededBy, t.userId],
			foreignColumns: [t.id as AnyPgColumn, t.userId as AnyPgColumn],
		}),
		index("candidate_fact_slot_idx").on(t.userId, t.entryId, t.kind),
	],
);
