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
	uuid,
} from "drizzle-orm/pg-core";
import { opportunity } from "../../discovery/tables";
import type { ApplicationAnswer, JobSnapshot, ResumeDocument, Strategy, TemplateId } from "../../generation/index";
import { hunt } from "../../hunts/tables";
import { match } from "../../matching/tables";
import { blob } from "../../storage/tables";
import { user } from "../../users/tables";
import { APPLICATION_STATUSES, type FrozenEvaluation, type PreparationFailure } from "./types";

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
