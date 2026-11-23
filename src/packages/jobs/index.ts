import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import { z } from "zod";
import type { Tx } from "../db/index";
import { userIdSchema } from "../db/ownership";

/** Held by the one running `worker` for its lifetime (§17); `web` reads it for worker status. */
export const WORKER_LOCK_KEY = 0x4a4f42574b52n; // "JOBWKR"

/**
 * A typed pg-boss queue. Every payload carries the owning `userId` (ADR 0006);
 * handlers load records by `(id, user_id)`. Jobs are disposable nudges: state rows
 * are the truth (ADR 0004).
 */
export type Queue<S extends z.ZodObject = z.ZodObject> = {
	name: string;
	schema: S;
	/** `exclusive`: at most one job per `singletonKey` is queued or running; a send while one is returns null. */
	policy?: "standard" | "exclusive";
	/** pg-boss's automatic retries of a failed job; 0 for jobs that must never repeat by themselves. Default 2. */
	retryLimit?: number;
	/** How long a job may run before pg-boss expires it. Default 15 minutes. */
	expireInSeconds?: number;
};

export function defineQueue<const Shape extends z.ZodRawShape>(
	name: string,
	shape: Shape,
	options: Pick<Queue, "policy" | "retryLimit" | "expireInSeconds"> = {},
) {
	return {
		...options,
		name,
		schema: z.object({ userId: userIdSchema, ...shape }),
		policy: options.policy ?? "standard",
	};
}

export type Payload<Q extends Queue> = z.output<Q["schema"]>;

export type Jobs = {
	/** Installs pg-boss if needed and creates the given queues. */
	start(): Promise<void>;
	/**
	 * Validates and enqueues. Pass `tx` to enqueue in the caller's transaction, so a
	 * state change and its next job commit together.
	 */
	send<Q extends Queue>(
		queue: Q,
		payload: Payload<Q>,
		options?: { tx?: Tx; singletonKey?: string; startAfter?: Date },
	): Promise<string | null>;
	/**
	 * The payloads of the queue's live jobs: queued, retrying or running, or failed within the
	 * last `failedWithinMs` (default an hour), so a record whose job keeps failing is nudged
	 * again at most that often. The sweeper nudges records that have none (§5).
	 */
	live<Q extends Queue>(queue: Q, options?: { failedWithinMs?: number }): Promise<Payload<Q>[]>;
	/** Consumes jobs one at a time; a payload that fails validation fails the job without calling `handler`. */
	work<Q extends Queue>(
		queue: Q,
		handler: (payload: Payload<Q>, job: { id: string }) => Promise<void>,
		/**
		 * `burst`: while the queue has a backlog, fetch the next job at once instead of after the
		 * 2 s polling interval (pg-boss notices a backlog within its ~60 s stats cycle).
		 */
		options?: { localConcurrency?: number; burst?: boolean },
	): Promise<void>;
	/** Stops fetching and waits up to `timeoutMs` for running handlers. */
	stop(options?: { timeoutMs?: number }): Promise<void>;
};

const FAILED_STAYS_LIVE_MS = 60 * 60 * 1000;

export function createJobs(options: {
	databaseUrl: string;
	queues: readonly Queue[];
	onError?: (error: Error) => void;
	/**
	 * For `web`, which sends jobs and never consumes them (§3): no schema install, queue
	 * creation, maintenance or schedules (the worker owns those), and pg-boss starts on the
	 * first `send`, so `web` starts even before the worker has installed it.
	 */
	sendOnly?: boolean;
}): Jobs {
	const sendOnly = options.sendOnly ?? false;
	const boss = new PgBoss({
		connectionString: options.databaseUrl,
		...(sendOnly ? { supervise: false, schedule: false, migrate: false, createSchema: false } : {}),
	});
	boss.on("error", (error: Error) => options.onError?.(error));

	let started: Promise<unknown> | null = null;
	const ensureStarted = () => {
		started ??= boss.start().catch((error: unknown) => {
			started = null;
			throw error;
		});
		return started;
	};

	return {
		async start() {
			await ensureStarted();
			if (sendOnly) return;
			const existing = new Set((await boss.getQueues()).map((queue) => queue.name));
			for (const queue of options.queues) {
				if (existing.has(queue.name)) continue;
				await boss.createQueue(queue.name, {
					policy: queue.policy ?? "standard",
					...(queue.retryLimit !== undefined ? { retryLimit: queue.retryLimit } : {}),
					...(queue.expireInSeconds !== undefined ? { expireInSeconds: queue.expireInSeconds } : {}),
				});
			}
		},
		async send(queue, payload, sendOptions = {}) {
			const data = queue.schema.parse(payload);
			if (sendOnly) await ensureStarted();
			return boss.send(queue.name, data, {
				...(sendOptions.tx ? { db: fromDrizzle(sendOptions.tx, sql) } : {}),
				...(sendOptions.singletonKey ? { singletonKey: sendOptions.singletonKey } : {}),
				...(sendOptions.startAfter ? { startAfter: sendOptions.startAfter } : {}),
			});
		},
		async live(queue, liveOptions = {}) {
			await ensureStarted();
			const failedWithinSeconds = (liveOptions.failedWithinMs ?? FAILED_STAYS_LIVE_MS) / 1000;
			const result = await boss.getDb().executeSql(
				`select data from pgboss.job where name = $1
					and (state in ('created', 'retry', 'active')
						or (state = 'failed' and completed_on > now() - make_interval(secs => $2)))`,
				[queue.name, failedWithinSeconds],
			);
			// A job of an older payload shape names no record this release knows how to advance.
			return (result.rows as { data: unknown }[]).flatMap((row) => {
				const parsed = queue.schema.safeParse(row.data);
				return parsed.success ? [parsed.data as Payload<typeof queue>] : [];
			});
		},
		async work(queue, handler, workOptions = {}) {
			await boss.work(
				queue.name,
				{
					batchSize: 1,
					localConcurrency: workOptions.localConcurrency ?? 1,
					...(workOptions.burst ? { burstWhenReadyExceeds: 1 } : {}),
				},
				async ([job]) => {
					if (!job) return;
					await handler(queue.schema.parse(job.data) as Payload<typeof queue>, { id: job.id });
				},
			);
		},
		async stop(stopOptions = {}) {
			await boss.stop({ graceful: true, timeout: stopOptions.timeoutMs ?? 30_000 });
		},
	};
}
