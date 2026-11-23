import { sql } from "drizzle-orm";
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
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { opportunity } from "../../discovery/tables";
import type { ApplicationAnswer, JobSnapshot, ResumeDocument, Strategy, TemplateId } from "../../generation/index";
import { SUBMISSION_MODES } from "../../hunts/criteria";
import { hunt } from "../../hunts/tables";
import { match } from "../../matching/tables";
import { blob } from "../../storage/tables";
import { user } from "../../users/tables";
import {
	APPLICATION_STATUSES,
	BROWSER_RUN_STATUSES,
	type FrozenEvaluation,
	type PreparationFailure,
	RUN_MODES,
	type RunCheckpoint,
	type RunFailure,
	type StoredRunEvent,
} from "./types";

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
		/** The Candidate's explicit choice for the next Browser Run (§5); cleared when one is dispatched. */
		requestedMode: text("requested_mode", { enum: SUBMISSION_MODES }),
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

/**
 * An Application's Package (§9, §13, #16): one per Application. The Job Snapshot is captured
 * once and never overwritten; the Strategy is generated once; each artifact keeps the input
 * hash it was made from, for idempotency only. Frozen at the submit boundary (TB1-14).
 */
export const applicationPackage = pgTable(
	"application_package",
	{
		applicationId: uuid("application_id").primaryKey(),
		userId: uuid("user_id").notNull(),
		jobSnapshot: jsonb("job_snapshot").$type<JobSnapshot>().notNull(),
		strategy: jsonb("strategy").$type<Strategy>(),
		strategyInputHash: text("strategy_input_hash"),
		strategyCallId: uuid("strategy_call_id"),
		resume: jsonb("resume").$type<ResumeDocument>(),
		resumeInputHash: text("resume_input_hash"),
		resumeCallId: uuid("resume_call_id"),
		resumeTemplate: text("resume_template").$type<TemplateId>(),
		resumePdf: text("resume_pdf").references(() => blob.hash),
		resumePages: integer("resume_pages"),
		/** The Application Answers (#16), one per question of the posting's form, with class and sources. */
		answers: jsonb("answers").$type<ApplicationAnswer[]>(),
		answersInputHash: text("answers_input_hash"),
		/** Null when code answered every question without a model call. */
		answersCallId: uuid("answers_call_id"),
		/** The most recent AI failure of preparation, so the same failure repeating can suspend it. */
		failure: jsonb("failure").$type<PreparationFailure>(),
		/** Paid retries stopped after repeated identical failures, until the User's AI keys or settings change. */
		suspendedAt: timestamp("suspended_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		foreignKey({
			columns: [t.applicationId, t.userId],
			foreignColumns: [application.id, application.userId],
		}).onDelete("cascade"),
	],
);

/** The global submission mode (§5, §16 Settings), per User. No row: Dry Run. */
export const submissionSettings = pgTable("submission_settings", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	mode: text("mode", { enum: SUBMISSION_MODES }).notNull().default("DRY_RUN"),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One Browser Run of an Application (§5, §10): compact typed events with evidence refs, and the
 * checkpoint it left (§11). At most one is active per Application. The worker that runs it
 * heartbeats; the sweeper reclaims it only once that worker ended or its heartbeat expired.
 */
export const browserRun = pgTable(
	"browser_run",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id").notNull(),
		applicationId: uuid("application_id").notNull(),
		mode: text("mode", { enum: RUN_MODES }).notNull(),
		status: text("status", { enum: BROWSER_RUN_STATUSES }).notNull().default("QUEUED"),
		/** The worker process that owns the run while RUNNING. */
		workerId: text("worker_id"),
		heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
		events: jsonb("events").$type<StoredRunEvent[]>().notNull().default([]),
		checkpoint: jsonb("checkpoint").$type<RunCheckpoint>(),
		failure: jsonb("failure").$type<RunFailure>(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		startedAt: timestamp("started_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
	},
	(t) => [
		uniqueIndex("browser_run_active_idx").on(t.applicationId).where(sql`${t.status} in ('QUEUED', 'RUNNING')`),
		index("browser_run_application_idx").on(t.userId, t.applicationId, t.createdAt),
		index("browser_run_status_idx").on(t.status),
		foreignKey({
			columns: [t.applicationId, t.userId],
			foreignColumns: [application.id, application.userId],
		}).onDelete("cascade"),
	],
);
