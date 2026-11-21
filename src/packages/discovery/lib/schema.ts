import {
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { blob } from "../../storage/tables";
import { user } from "../../users/tables";
import type { FieldHashes } from "./normalize";
import { LISTING_FAILURES, SOURCES, type SourcePosting, WORKPLACE_TYPES } from "./types";

export const BOARD_ORIGINS = ["SEED", "USER", "AUTO"] as const;
export const OPPORTUNITY_STATUSES = ["OPEN", "CLOSED"] as const;
export const POSTED_AT_SOURCES = ["SOURCE", "FIRST_SEEN"] as const;

/** A Board one User watches, with its polling schedule and Board health (§6). */
export const watchedBoard = pgTable(
	"watched_board",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		source: text("source", { enum: SOURCES }).notNull(),
		token: text("token").notNull(),
		employerName: text("employer_name").notNull(),
		origin: text("origin", { enum: BOARD_ORIGINS }).notNull(),
		/** Null: due now. */
		nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
		lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
		/** The last complete, successful listing. */
		lastListedAt: timestamp("last_listed_at", { withTimezone: true }),
		lastFailure: text("last_failure", { enum: LISTING_FAILURES }),
		lastFailureDetail: text("last_failure_detail"),
		consecutiveFailures: integer("consecutive_failures").notNull().default(0),
		/** The current run of genuine NOT_FOUNDs; other failures neither count nor reset it. */
		notFoundCount: integer("not_found_count").notNull().default(0),
		notFoundSince: timestamp("not_found_since", { withTimezone: true }),
		goneAt: timestamp("gone_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [unique("watched_board_id_user_key").on(t.id, t.userId), unique().on(t.userId, t.source, t.token)],
);

/**
 * One real job posting, per User (ADR 0006), deduplicated on exact keys. Its content is
 * the normalized form of the Sighting that created it; the raw payload is a blob.
 */
export const opportunity = pgTable(
	"opportunity",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		dedupKey: text("dedup_key").notNull(),
		status: text("status", { enum: OPPORTUNITY_STATUSES }).notNull().default("OPEN"),
		employerName: text("employer_name").notNull(),
		title: text("title").notNull(),
		titleNormalized: text("title_normalized").notNull(),
		locationText: text("location_text"),
		workplaceType: text("workplace_type", { enum: WORKPLACE_TYPES }),
		employmentType: text("employment_type"),
		salary: jsonb("salary").$type<SourcePosting["salary"]>(),
		canonicalUrl: text("canonical_url").notNull(),
		descriptionMarkdown: text("description_markdown"),
		rawBlob: text("raw_blob").references(() => blob.hash),
		/** Posting age: the Source's trustworthy date, or first seen under continuous polling; null is unknown. */
		postedAt: timestamp("posted_at", { withTimezone: true }),
		postedAtSource: text("posted_at_source", { enum: POSTED_AT_SOURCES }),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
		closedAt: timestamp("closed_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("opportunity_id_user_key").on(t.id, t.userId),
		unique().on(t.userId, t.dedupKey),
		index("opportunity_user_seen_idx").on(t.userId, t.firstSeenAt),
	],
);

/** Every exact identity key an Opportunity is known by; at most one Opportunity per key per User. */
export const opportunityAlias = pgTable(
	"opportunity_alias",
	{
		userId: uuid("user_id").notNull(),
		key: text("key").notNull(),
		opportunityId: uuid("opportunity_id").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.key] }),
		foreignKey({
			columns: [t.opportunityId, t.userId],
			foreignColumns: [opportunity.id, opportunity.userId],
		}).onDelete("cascade"),
	],
);

/** One place an Opportunity is listed: one post on one watched Board, with its own link and location. */
export const sighting = pgTable(
	"sighting",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id").notNull(),
		opportunityId: uuid("opportunity_id").notNull(),
		boardId: uuid("board_id").notNull(),
		nativeId: text("native_id").notNull(),
		url: text("url").notNull(),
		applyUrl: text("apply_url").notNull(),
		title: text("title").notNull(),
		locationText: text("location_text"),
		status: text("status", { enum: OPPORTUNITY_STATUSES }).notNull().default("OPEN"),
		contentHash: text("content_hash").notNull(),
		fieldHashes: jsonb("field_hashes").$type<FieldHashes>().notNull(),
		rawBlob: text("raw_blob").references(() => blob.hash),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
		/** Consecutive complete listings without this post; 2 closes it. */
		missedListings: integer("missed_listings").notNull().default(0),
		closedAt: timestamp("closed_at", { withTimezone: true }),
	},
	(t) => [
		unique().on(t.boardId, t.nativeId),
		index("sighting_opportunity_idx").on(t.opportunityId),
		foreignKey({
			columns: [t.opportunityId, t.userId],
			foreignColumns: [opportunity.id, opportunity.userId],
		}).onDelete("cascade"),
		foreignKey({
			columns: [t.boardId, t.userId],
			foreignColumns: [watchedBoard.id, watchedBoard.userId],
		}).onDelete("cascade"),
	],
);
