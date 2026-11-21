import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Db, Executor } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { modelInfo, PRICE_TABLE_VERSION, priceSnapshot } from "./models";
import { aiCall, aiCallPayload, aiScopeHealth, aiSettings } from "./schema";
import type { Attribution, Fingerprint, Preset, Task, Usage } from "./types";

/** Namespace (first int) of the two-int advisory lock taken per User for reserve-and-check. */
const BUDGET_LOCK_NAMESPACE = 0x41494244; // "AIBD"
export const PAYLOAD_RETENTION_DAYS = 14;

export type Settings = {
	preset: Preset;
	taskPresets: Partial<Record<Task, Preset>>;
	dailyCapMicroUsd: number | null;
	timeZone: string;
};

export const DEFAULT_SETTINGS: Settings = {
	preset: "standard",
	taskPresets: {},
	dailyCapMicroUsd: null,
	timeZone: "UTC",
};

export async function readSettings(exec: Executor, owner: UserId): Promise<Settings> {
	const [row] = await exec.select().from(aiSettings).where(eq(aiSettings.userId, owner));
	if (!row) return DEFAULT_SETTINGS;
	return {
		preset: row.preset as Preset,
		taskPresets: row.taskPresets as Settings["taskPresets"],
		dailyCapMicroUsd: row.dailyCapMicroUsd,
		timeZone: row.timeZone,
	};
}

export class SettingsError extends Error {
	override name = "SettingsError";
}

/** Writes the User's routing and spend settings; the next call re-reads them. */
export async function writeSettings(exec: Executor, owner: UserId, settings: Settings): Promise<void> {
	if (
		settings.dailyCapMicroUsd !== null &&
		(!Number.isInteger(settings.dailyCapMicroUsd) || settings.dailyCapMicroUsd < 0)
	) {
		throw new SettingsError("the daily cap must be a non-negative amount");
	}
	try {
		new Intl.DateTimeFormat("en", { timeZone: settings.timeZone });
	} catch {
		throw new SettingsError("unknown time zone");
	}
	const values = {
		preset: settings.preset,
		taskPresets: settings.taskPresets,
		dailyCapMicroUsd: settings.dailyCapMicroUsd,
		timeZone: settings.timeZone,
		updatedAt: sql`now()`,
	};
	await exec
		.insert(aiSettings)
		.values({ userId: owner, ...values })
		.onConflictDoUpdate({ target: aiSettings.userId, set: values });
}

/**
 * What the User has spent today, in the Candidate's time zone. Every row counts once:
 * its measured cost if finalised with one, otherwise its reservation.
 */
export async function spentTodayMicroUsd(exec: Executor, owner: UserId, timeZone: string): Promise<number> {
	const result = await exec.execute<{ spent: string | null }>(sql`
		select sum(coalesce(${aiCall.measuredMicroUsd}, ${aiCall.reservedMicroUsd})) as spent
		from ${aiCall}
		where ${aiCall.userId} = ${owner}
			and ${aiCall.startedAt} >= (date_trunc('day', now() at time zone ${timeZone}) at time zone ${timeZone})
	`);
	return Number(result.rows[0]?.spent ?? 0);
}

export type Reservation = {
	task: Task;
	provider: string;
	model: string;
	reservedMicroUsd: number;
	promptTokensEstimate: number;
	attribution: Attribution;
	/** Stored in `ai_call_payload`, never in the ledger row. */
	request: unknown;
};

export type ReserveOutcome = { ok: true; callId: string } | { ok: false; capMicroUsd: number; spentMicroUsd: number };

/**
 * Reserve-and-check (§12): one short transaction under a per-User advisory lock, so two
 * processes cannot both pass the same budget check. Inserts the reservation only if it
 * fits under the daily cap.
 */
export async function reserve(db: Db, r: Reservation): Promise<ReserveOutcome> {
	const owner = r.attribution.userId;
	const info = modelInfo(r.provider, r.model);
	return db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(${BUDGET_LOCK_NAMESPACE}, hashtext(${owner}))`);
		const settings = await readSettings(tx, owner);
		if (settings.dailyCapMicroUsd !== null) {
			const spent = await spentTodayMicroUsd(tx, owner, settings.timeZone);
			if (spent + r.reservedMicroUsd > settings.dailyCapMicroUsd) {
				return { ok: false, capMicroUsd: settings.dailyCapMicroUsd, spentMicroUsd: spent };
			}
		}
		const [row] = await tx
			.insert(aiCall)
			.values({
				userId: owner,
				task: r.task,
				provider: r.provider,
				model: r.model,
				reservedMicroUsd: r.reservedMicroUsd,
				priceTableVersion: PRICE_TABLE_VERSION,
				priceSnapshot: {
					applied: priceSnapshot(r.provider, r.model, r.promptTokensEstimate),
					...(info.longContext ? { longContext: info.longContext } : {}),
				},
				huntId: r.attribution.huntId ?? null,
				applicationId: r.attribution.applicationId ?? null,
				browserRunId: r.attribution.browserRunId ?? null,
				opportunityId: r.attribution.opportunityId ?? null,
			})
			.returning({ id: aiCall.id });
		if (!row) throw new Error("the ai_call reservation was not written");
		await tx.insert(aiCallPayload).values({ callId: row.id, userId: owner, request: r.request as object });
		return { ok: true, callId: row.id };
	});
}

export type Finalisation = {
	/** Null keeps the reservation counting (the provider may have billed a call whose fate is unknown). */
	measuredMicroUsd: number | null;
	usage: Usage | null;
	requestId: string | null;
	outcome: string;
	error?: { kind: string; scope: string; fingerprint: Fingerprint };
	response?: unknown;
};

/** Finalises a reservation exactly once; the append-only trigger rejects any later change. */
export async function finalise(db: Db, owner: UserId, callId: string, f: Finalisation): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.update(aiCall)
			.set({
				measuredMicroUsd: f.measuredMicroUsd,
				inputTokens: f.usage?.inputTokens ?? null,
				outputTokens: f.usage?.outputTokens ?? null,
				cacheReadTokens: f.usage?.cacheReadTokens ?? null,
				cacheWriteTokens: f.usage?.cacheWriteTokens ?? null,
				requestId: f.requestId,
				outcome: f.outcome,
				errorKind: f.error?.kind ?? null,
				errorScope: f.error?.scope ?? null,
				fingerprint: f.error ? fingerprintText(f.error.fingerprint) : null,
				finishedAt: sql`now()`,
			})
			.where(and(eq(aiCall.id, callId), eq(aiCall.userId, owner), isNull(aiCall.finishedAt)));
		if (f.response !== undefined) {
			await tx
				.update(aiCallPayload)
				.set({ response: f.response as object })
				.where(and(eq(aiCallPayload.callId, callId), eq(aiCallPayload.userId, owner)));
		}
	});
}

export function fingerprintText(f: Fingerprint): string {
	return [f.task, f.provider ?? "-", f.model ?? "-", f.errorClass, f.schemaHash ?? "-"].join("|");
}

/** Scopes (`key:openai`, `model:anthropic/claude-haiku-5-5`, ...) currently in cooldown for this User. */
export async function unhealthyScopes(exec: Executor, owner: UserId): Promise<Set<string>> {
	const rows = await exec
		.select({ scope: aiScopeHealth.scope })
		.from(aiScopeHealth)
		.where(and(eq(aiScopeHealth.userId, owner), gt(aiScopeHealth.unhealthyUntil, sql`now()`)));
	return new Set(rows.map((row) => row.scope));
}

export async function markUnhealthy(
	exec: Executor,
	owner: UserId,
	scope: string,
	errorClass: string,
	cooldownSeconds: number,
): Promise<void> {
	const until = sql`now() + make_interval(secs => ${cooldownSeconds})`;
	await exec
		.insert(aiScopeHealth)
		.values({ userId: owner, scope, errorClass, unhealthyUntil: until })
		.onConflictDoUpdate({
			target: [aiScopeHealth.userId, aiScopeHealth.scope],
			set: { errorClass, unhealthyUntil: until },
		});
}

/** Deletes prompts and outputs older than the 14-day retention. Returns how many were removed. */
export async function purgeExpiredPayloads(exec: Executor): Promise<number> {
	const removed = await exec
		.delete(aiCallPayload)
		.where(lt(aiCallPayload.createdAt, sql`now() - make_interval(days => ${PAYLOAD_RETENTION_DAYS})`))
		.returning({ callId: aiCallPayload.callId });
	return removed.length;
}
