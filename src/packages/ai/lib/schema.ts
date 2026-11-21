import {
	bigint,
	customType,
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
import { user } from "../../users/tables";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

const owner = () =>
	uuid("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" });

/** A User's BYO provider key, sealed by `secrets` and bound to this row (§12). Only `last4` is ever shown. */
export const providerKey = pgTable(
	"provider_key",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: owner(),
		provider: text("provider").notNull(),
		sealed: bytea("sealed").notNull(),
		last4: text("last4").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [unique("provider_key_user_provider_unique").on(t.userId, t.provider)],
);

/** The User's model routing and spend settings; absent means the defaults. Re-read on every call. */
export const aiSettings = pgTable("ai_settings", {
	userId: owner().primaryKey(),
	preset: text("preset").notNull().default("standard"),
	/** Optional per-task preset override, e.g. `{"write": "best"}`. */
	taskPresets: jsonb("task_presets").notNull().default({}),
	/** Optional daily AI spend cap in micro-USD; null means no cap. */
	dailyCapMicroUsd: bigint("daily_cap_micro_usd", { mode: "number" }),
	/** The Candidate's IANA time zone, which decides when the cap's day starts. */
	timeZone: text("time_zone").notNull().default("UTC"),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per provider call attempt (§12). Written as a reservation before the call and
 * finalised once after it; a trigger rejects deletes and any change to a finalised row.
 * A row counts toward spend once: its measured cost if known, otherwise its reservation.
 */
export const aiCall = pgTable(
	"ai_call",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		// No cascade: the ledger is append-only, so a User with AI calls cannot be deleted by accident.
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id),
		task: text("task").notNull(),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		/** Conservative estimate held against the budget from before the call. */
		reservedMicroUsd: bigint("reserved_micro_usd", { mode: "number" }).notNull(),
		/** Cost from the provider's usage numbers; null while running or when the outcome is unknown. */
		measuredMicroUsd: bigint("measured_micro_usd", { mode: "number" }),
		priceTableVersion: text("price_table_version").notNull(),
		priceSnapshot: jsonb("price_snapshot").notNull(),
		inputTokens: integer("input_tokens"),
		outputTokens: integer("output_tokens"),
		cacheReadTokens: integer("cache_read_tokens"),
		cacheWriteTokens: integer("cache_write_tokens"),
		requestId: text("request_id"),
		/** `ok`, an error class such as `rate_limited`, or `unknown` when the call's fate is not known. */
		outcome: text("outcome"),
		errorKind: text("error_kind"),
		errorScope: text("error_scope"),
		fingerprint: text("fingerprint"),
		huntId: uuid("hunt_id"),
		applicationId: uuid("application_id"),
		browserRunId: uuid("browser_run_id"),
		opportunityId: uuid("opportunity_id"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
	},
	(t) => [index("ai_call_user_started_idx").on(t.userId, t.startedAt)],
);

/** Prompts and outputs of one call, kept 14 days and never copied into the ledger or logs. */
export const aiCallPayload = pgTable(
	"ai_call_payload",
	{
		callId: uuid("call_id")
			.primaryKey()
			.references(() => aiCall.id),
		userId: owner(),
		request: jsonb("request").notNull(),
		response: jsonb("response"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("ai_call_payload_created_idx").on(t.createdAt)],
);

/**
 * Scopes (`key:<provider>`, `provider:<provider>`, `model:<provider>/<model>`) the gateway
 * stopped calling after a shared or repeated transient failure, until `unhealthy_until`.
 * In Postgres so `web` and `worker` share it.
 */
export const aiScopeHealth = pgTable(
	"ai_scope_health",
	{
		userId: owner(),
		scope: text("scope").notNull(),
		unhealthyUntil: timestamp("unhealthy_until", { withTimezone: true }).notNull(),
		errorClass: text("error_class").notNull(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.scope] })],
);
