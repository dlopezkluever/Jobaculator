import { z } from "zod";
import { SEED_BOARDS } from "../config/index";
import type { Db } from "../db/index";
import type { UserId } from "../db/ownership";
import { type Adapters, discover, dueBoards, ingest, sourcePostingSchema, watchBoards } from "../discovery/index";
import { hasActiveHunt, usersWithActiveHunts } from "../hunts/index";
import { defineQueue, type Jobs } from "../jobs/index";
import type { Logger } from "../log/index";
import type { Storage } from "../storage/index";

// Pipeline steps 1–2 (§5): `discover(userId, board)` → `ingest(posting)`.

/** At most one poll per (User, Board) is queued or running; a poll due meanwhile is skipped, not queued (§6). */
export const discoverQueue = defineQueue("discover", { boardId: z.uuid() }, { policy: "exclusive" });
export const ingestQueue = defineQueue("ingest", {
	boardId: z.uuid(),
	continuous: z.boolean(),
	posting: sourcePostingSchema,
});
export const DISCOVERY_QUEUES = [discoverQueue, ingestQueue];

export type DiscoveryPipeline = {
	/** Enqueues a poll of every due Board of every User with an ACTIVE Hunt, watching the seed Boards first. */
	tick(): Promise<number>;
	runDiscover(userId: UserId, boardId: string): Promise<void>;
	/** Registers the `discover` and `ingest` consumers. */
	work(): Promise<void>;
};

export function createDiscoveryPipeline(deps: {
	db: Db;
	jobs: Jobs;
	storage: Storage;
	adapters: Adapters;
	log: Logger;
}): DiscoveryPipeline {
	const { db, jobs, storage, adapters, log } = deps;

	async function runDiscover(userId: UserId, boardId: string) {
		// Polling stops once none of the User's Hunts is active, even for a poll already queued.
		if (!(await hasActiveHunt(db, userId))) return;
		const outcome = await discover(db, adapters, userId, boardId);
		if (!outcome) return;
		if (outcome.status === "FAILED") {
			log.warn({ event: "board_poll_failed", userId, boardId, failure: outcome.failure, gone: outcome.gone });
			return;
		}
		// A posting whose ingest is lost is still unknown at the next poll, so it is offered again.
		for (const { posting, continuous } of outcome.toIngest) {
			await jobs.send(ingestQueue, { userId, boardId, continuous, posting });
		}
		log.info({
			event: "board_polled",
			userId,
			boardId,
			listed: outcome.listed,
			toIngest: outcome.toIngest.length,
			closedSightings: outcome.closedSightings,
		});
	}

	return {
		async tick() {
			let sent = 0;
			for (const owner of await usersWithActiveHunts(db)) {
				await watchBoards(db, owner, SEED_BOARDS, "SEED");
				for (const boardId of await dueBoards(db, owner)) {
					const id = await jobs.send(
						discoverQueue,
						{ userId: owner, boardId },
						{ singletonKey: `${owner}:${boardId}` },
					);
					if (id) sent++;
				}
			}
			return sent;
		},
		runDiscover,
		async work() {
			// Two polls at a time; the per-host limiter keeps each ATS at ~1 request/s regardless.
			await jobs.work(discoverQueue, ({ userId, boardId }) => runDiscover(userId, boardId), { localConcurrency: 2 });
			// A Board's first import hands over every posting at once (hundreds), so ingest drains its backlog.
			await jobs.work(
				ingestQueue,
				async ({ userId, boardId, continuous, posting }) => {
					await ingest(db, storage, userId, boardId, posting, { continuous });
				},
				{ localConcurrency: 4, burst: true },
			);
		},
	};
}
