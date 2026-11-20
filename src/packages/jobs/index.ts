import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import { z } from "zod";
import type { Tx } from "../db/index";
import { userIdSchema } from "../db/ownership";

/**
 * A typed pg-boss queue. Every payload carries the owning `userId` (ADR 0006);
 * handlers load records by `(id, user_id)`. Jobs are disposable nudges: state rows
 * are the truth (ADR 0004).
 */
export type Queue<S extends z.ZodObject = z.ZodObject> = { name: string; schema: S };

export function defineQueue<const Shape extends z.ZodRawShape>(name: string, shape: Shape) {
	return { name, schema: z.object({ userId: userIdSchema, ...shape }) };
}

export type Payload<Q extends Queue> = z.output<Q["schema"]>;

export type Jobs = {
	/** Installs pg-boss if needed and creates the given queues. */
	start(): Promise<void>;
	/**
	 * Validates and enqueues. Pass `tx` to enqueue in the caller's transaction, so a
	 * state change and its next job commit together.
	 */
	send<Q extends Queue>(queue: Q, payload: Payload<Q>, options?: { tx?: Tx }): Promise<string | null>;
	/** Consumes jobs one at a time; a payload that fails validation fails the job without calling `handler`. */
	work<Q extends Queue>(
		queue: Q,
		handler: (payload: Payload<Q>, job: { id: string }) => Promise<void>,
		options?: { localConcurrency?: number },
	): Promise<void>;
	/** Stops fetching and waits up to `timeoutMs` for running handlers. */
	stop(options?: { timeoutMs?: number }): Promise<void>;
};

export function createJobs(options: {
	databaseUrl: string;
	queues: readonly Queue[];
	onError?: (error: Error) => void;
}): Jobs {
	const boss = new PgBoss({ connectionString: options.databaseUrl });
	boss.on("error", (error: Error) => options.onError?.(error));

	return {
		async start() {
			await boss.start();
			const existing = new Set((await boss.getQueues()).map((queue) => queue.name));
			for (const queue of options.queues) {
				if (!existing.has(queue.name)) await boss.createQueue(queue.name);
			}
		},
		async send(queue, payload, sendOptions = {}) {
			const data = queue.schema.parse(payload);
			return sendOptions.tx
				? boss.send(queue.name, data, { db: fromDrizzle(sendOptions.tx, sql) })
				: boss.send(queue.name, data);
		},
		async work(queue, handler, workOptions = {}) {
			await boss.work(
				queue.name,
				{ batchSize: 1, localConcurrency: workOptions.localConcurrency ?? 1 },
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
