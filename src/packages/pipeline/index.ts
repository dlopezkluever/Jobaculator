import { z } from "zod";
import type { LlmClient } from "../ai/index";
import { experienceYears } from "../candidate/index";
import { SEED_BOARDS } from "../config/index";
import type { Db, Tx } from "../db/index";
import type { UserId } from "../db/ownership";
import {
	type Adapters,
	discover,
	dueBoards,
	getOpportunity,
	type Ingested,
	ingest,
	sourcePostingSchema,
	watchBoards,
} from "../discovery/index";
import { getHunt, hasActiveHunt, listHunts, usersWithActiveHunts } from "../hunts/index";
import { defineQueue, type Jobs } from "../jobs/index";
import type { Logger } from "../log/index";
import { evaluate, getMatch, requestEvaluations } from "../matching/index";
import type { Storage } from "../storage/index";

// Pipeline steps 1–3 (§5): `discover(userId, board)` → `ingest(posting)` → `evaluate(match)`.

/** At most one poll per (User, Board) is queued or running; a poll due meanwhile is skipped, not queued (§6). */
export const discoverQueue = defineQueue("discover", { boardId: z.uuid() }, { policy: "exclusive" });
export const ingestQueue = defineQueue("ingest", {
	boardId: z.uuid(),
	continuous: z.boolean(),
	posting: sourcePostingSchema,
});
/** One Match to evaluate; a nudge for a Match that moved on does nothing. */
export const evaluateQueue = defineQueue("evaluate", { matchId: z.uuid() });
export const PIPELINE_QUEUES = [discoverQueue, ingestQueue, evaluateQueue];

/**
 * Ingest's next step, in its transaction (§5): every ACTIVE Hunt evaluates a new, changed or
 * reopened Opportunity. Another Sighting, or nothing new, leaves the Matches as they are.
 */
async function requestHuntEvaluations(jobs: Jobs, tx: Tx, owner: UserId, ingested: Ingested) {
	if (ingested.outcome === "SIGHTED" || ingested.outcome === "UNCHANGED") return;
	const active = (await listHunts(tx, owner)).filter((hunt) => hunt.status === "ACTIVE");
	const ids = await requestEvaluations(
		tx,
		owner,
		ingested.opportunityId,
		active.map((hunt) => hunt.id),
	);
	for (const matchId of ids) await jobs.send(evaluateQueue, { userId: owner, matchId }, { tx });
}

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
					await ingest(db, storage, userId, boardId, posting, {
						continuous,
						onIngested: (tx, ingested) => requestHuntEvaluations(jobs, tx, userId, ingested),
					});
				},
				{ localConcurrency: 4, burst: true },
			);
		},
	};
}

export type MatchingPipeline = {
	runEvaluate(userId: UserId, matchId: string): Promise<void>;
	/** Registers the `evaluate` consumer. */
	work(): Promise<void>;
};

export function createMatchingPipeline(deps: { db: Db; jobs: Jobs; llm: LlmClient; log: Logger }): MatchingPipeline {
	const { db, jobs, llm, log } = deps;

	async function runEvaluate(userId: UserId, matchId: string) {
		// The revision is read before the inputs, so inputs changed meanwhile make the write a no-op.
		const pending = await getMatch(db, userId, matchId);
		if (pending?.status !== "PENDING") return;
		// A paused Hunt does not evaluate; its Match waits, PENDING.
		const hunt = await getHunt(db, userId, pending.huntId);
		if (hunt?.status !== "ACTIVE") return;
		const opportunity = await getOpportunity(db, userId, pending.opportunityId);
		if (opportunity?.status !== "OPEN") return;
		const evaluated = await evaluate({ db, llm }, userId, pending, {
			criteria: hunt.criteria,
			opportunity,
			experienceYears: await experienceYears(db, userId),
		});
		if (evaluated) {
			log.info({
				event: "match_evaluated",
				userId,
				matchId,
				decision: evaluated.decision,
				reason: evaluated.reason,
				fit: evaluated.fit,
			});
		}
	}

	return {
		runEvaluate,
		async work() {
			// A Board's first import asks every Hunt to judge every posting at once, so evaluate drains its backlog.
			await jobs.work(evaluateQueue, ({ userId, matchId }) => runEvaluate(userId, matchId), {
				localConcurrency: 4,
				burst: true,
			});
		},
	};
}
