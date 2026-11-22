import { z } from "zod";
import { aiSetupChangedAt, BudgetExceeded, type LlmClient, LlmError } from "../ai/index";
import {
	claimPreparations,
	clearPreparationFailure,
	createApplication,
	dispatchedPreparations,
	expireClosedApplications,
	getApplication,
	getApplicationForOpportunity,
	getPackage,
	lockOpportunityDecision,
	recordPreparationFailure,
	reviveExpired,
	saveAnswers,
	saveResume,
	saveStrategy,
	startPackage,
	transition,
	undecidedOpportunities,
	usersAwaitingPreparation,
} from "../applications/index";
import { buildCandidateContext, experienceYears, missingContactIdentity } from "../candidate/index";
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
	PostingUnavailable,
	readApplicationQuestions,
	readPostingSnapshot,
	sourcePostingSchema,
	watchBoards,
} from "../discovery/index";
import { answerQuestions, DEFAULT_TEMPLATE, planStrategy, renderResume, writeResume } from "../generation/index";
import { heldUsers, liftHold, raiseHold } from "../holds/index";
import { getHunt, type Hunt, hasActiveHunt, listHunts, usersWithActiveHunts } from "../hunts/index";
import { defineQueue, type Jobs } from "../jobs/index";
import type { Logger } from "../log/index";
import { evaluableMatches, evaluate, getMatch, listMatches, requestEvaluations } from "../matching/index";
import type { Storage } from "../storage/index";

// Pipeline steps 1–5 (§5): `discover(userId, board)` → `ingest(posting)` → `evaluate(match)` →
// `decide(opportunity)` → `prepare(application)`. State rows are the truth; jobs are nudges.

/** At most one poll per (User, Board) is queued or running; a poll due meanwhile is skipped, not queued (§6). */
export const discoverQueue = defineQueue("discover", { boardId: z.uuid() }, { policy: "exclusive" });
export const ingestQueue = defineQueue("ingest", {
	boardId: z.uuid(),
	continuous: z.boolean(),
	posting: sourcePostingSchema,
});
/** One Match to evaluate; a nudge for a Match that moved on does nothing. */
export const evaluateQueue = defineQueue("evaluate", { matchId: z.uuid() });
/**
 * Decide one Opportunity. Sent when its Matches settle, and as a `fallback` a while after they
 * were asked to evaluate, which decides on the Matches settled by then.
 */
export const decideQueue = defineQueue("decide", { opportunityId: z.uuid(), fallback: z.boolean() });
/** Prepare one Application's Package; sent by the dispatcher, the sweeper and its own retries. */
export const prepareQueue = defineQueue("prepare", { applicationId: z.uuid() });
export const PIPELINE_QUEUES = [discoverQueue, ingestQueue, evaluateQueue, decideQueue, prepareQueue];

/** How long `decide` waits for stalled evaluations before deciding on the Matches settled so far. */
export const DECIDE_FALLBACK_MS = 15 * 60 * 1000;
/** Prepared or preparing Applications kept ahead of the one browser (§5). */
export const DEFAULT_READY_BACKLOG = 8;

/**
 * Ingest's next step, in its transaction (§5): every ACTIVE Hunt evaluates a new, changed or
 * reopened Opportunity. Another Sighting, or nothing new, leaves the Matches as they are.
 */
async function requestHuntEvaluations(jobs: Jobs, tx: Tx, owner: UserId, ingested: Ingested) {
	if (ingested.outcome === "SIGHTED" || ingested.outcome === "UNCHANGED") return;
	const { opportunityId } = ingested;
	// A reopened posting reconsiders its Expired Application, the same one (§4).
	if (ingested.outcome === "REOPENED") await reviveExpired(tx, owner, opportunityId);
	const active = (await listHunts(tx, owner)).filter((hunt) => hunt.status === "ACTIVE");
	const ids = await requestEvaluations(
		tx,
		owner,
		opportunityId,
		active.map((hunt) => hunt.id),
	);
	for (const matchId of ids) await jobs.send(evaluateQueue, { userId: owner, matchId }, { tx });
	// A changed posting re-evaluates for future decisions only: an existing Application stays as it is.
	if (ids.length > 0 && !(await getApplicationForOpportunity(tx, owner, opportunityId))) {
		await jobs.send(
			decideQueue,
			{ userId: owner, opportunityId, fallback: true },
			{ tx, startAfter: new Date(Date.now() + DECIDE_FALLBACK_MS) },
		);
	}
}

const activeHunts = async (exec: Tx | Db, owner: UserId) =>
	new Map((await listHunts(exec, owner)).filter((h) => h.status === "ACTIVE").map((h): [string, Hunt] => [h.id, h]));

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
		const evaluated = await evaluate(
			{ db, llm },
			userId,
			pending,
			{ criteria: hunt.criteria, opportunity, experienceYears: await experienceYears(db, userId) },
			{
				// `decide` fires as soon as every ACTIVE Hunt's Match of the Opportunity has settled (§5).
				onEvaluated: async (tx, done) => {
					await lockOpportunityDecision(tx, userId, done.opportunityId);
					if (await getApplicationForOpportunity(tx, userId, done.opportunityId)) return;
					const hunts = await activeHunts(tx, userId);
					const matches = (await listMatches(tx, userId, [done.opportunityId])).filter((m) => hunts.has(m.huntId));
					if (matches.some((m) => m.status === "PENDING")) return;
					await jobs.send(decideQueue, { userId, opportunityId: done.opportunityId, fallback: false }, { tx });
				},
			},
		);
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

export type ApplicationPipeline = {
	/**
	 * `decide(opportunity)` (§5 step 4): once its ACTIVE Hunts' Matches have settled, or on the
	 * fallback with whatever has settled, creates its one Application. Safe to repeat.
	 */
	runDecide(userId: UserId, opportunityId: string, fallback: boolean): Promise<string | null>;
	/**
	 * One dispatcher tick for `prepare` (§5): refreshes each waiting Candidate's contact-identity
	 * Hold, then claims free capacity in Opportunity Value order and enqueues `prepare` with it.
	 */
	dispatch(): Promise<number>;
	/** Re-nudges records in an automated state with no live job, and expires Applications of closed postings. */
	sweep(): Promise<{ evaluate: number; decide: number; prepare: number; expired: number }>;
	/** Registers the `decide` consumer. */
	work(): Promise<void>;
};

export function createApplicationPipeline(deps: {
	db: Db;
	jobs: Jobs;
	log: Logger;
	readyBacklog?: number;
}): ApplicationPipeline {
	const { db, jobs, log } = deps;
	const backlog = deps.readyBacklog ?? DEFAULT_READY_BACKLOG;

	async function runDecide(userId: UserId, opportunityId: string, fallback: boolean) {
		const created = await db.transaction(async (tx) => {
			await lockOpportunityDecision(tx, userId, opportunityId);
			if (await getApplicationForOpportunity(tx, userId, opportunityId)) return null;
			if ((await getOpportunity(tx, userId, opportunityId))?.status !== "OPEN") return null;
			// A paused Hunt's Match neither creates an Application nor holds the decision back.
			const hunts = await activeHunts(tx, userId);
			const matches = (await listMatches(tx, userId, [opportunityId])).filter((m) => hunts.has(m.huntId));
			if (!fallback && matches.some((m) => m.status === "PENDING")) return null;
			return createApplication(
				tx,
				userId,
				opportunityId,
				matches.map((m) => ({ match: m, submissionPolicy: hunts.get(m.huntId)?.submissionPolicy ?? "AUTO" })),
			);
		});
		if (!created) return null;
		log.info({ event: "application_created", userId, applicationId: created.id, fit: created.fit });
		// A new Application nudges the dispatcher rather than waiting for its next tick.
		await dispatch();
		return created.id;
	}

	async function refreshContactHolds() {
		const owners = new Set([...(await usersAwaitingPreparation(db)), ...(await heldUsers(db, "contact_identity"))]);
		for (const owner of owners) {
			const missing = await missingContactIdentity(db, owner);
			const changed = await db.transaction((tx) =>
				missing.length > 0
					? raiseHold(tx, owner, "contact_identity", missing.join(","))
					: liftHold(tx, owner, "contact_identity"),
			);
			if (changed)
				log.info({
					event: missing.length > 0 ? "hold_raised" : "hold_lifted",
					userId: owner,
					scope: "contact_identity",
				});
		}
	}

	async function dispatch() {
		await refreshContactHolds();
		const held = await heldUsers(db, "contact_identity");
		const claimed = await db.transaction(async (tx) => {
			const picked = await claimPreparations(tx, { backlog, excludeUsers: held });
			for (const { userId, applicationId } of picked) {
				await jobs.send(prepareQueue, { userId, applicationId }, { tx });
			}
			return picked.length;
		});
		if (claimed > 0) log.info({ event: "preparations_dispatched", claimed });
		return claimed;
	}

	return {
		runDecide,
		dispatch,
		async sweep() {
			const [evaluating, deciding, preparing] = await Promise.all([
				jobs.live(evaluateQueue),
				jobs.live(decideQueue),
				jobs.live(prepareQueue),
			]);
			const counts = { evaluate: 0, decide: 0, prepare: 0, expired: 0 };
			const pendingMatches = new Set(evaluating.map((job) => job.matchId));
			for (const { userId, matchId } of await evaluableMatches(db)) {
				if (pendingMatches.has(matchId)) continue;
				await jobs.send(evaluateQueue, { userId, matchId });
				counts.evaluate++;
			}
			// Their own fallback is still waiting, or was lost: decide on what has settled.
			const pendingDecisions = new Set(deciding.map((job) => job.opportunityId));
			for (const { userId, opportunityId } of await undecidedOpportunities(db)) {
				if (pendingDecisions.has(opportunityId)) continue;
				await jobs.send(decideQueue, { userId, opportunityId, fallback: true });
				counts.decide++;
			}
			const pendingPreparations = new Set(preparing.map((job) => job.applicationId));
			for (const { userId, applicationId } of await dispatchedPreparations(db)) {
				if (pendingPreparations.has(applicationId)) continue;
				await jobs.send(prepareQueue, { userId, applicationId });
				counts.prepare++;
			}
			counts.expired = await expireClosedApplications(db);
			return counts;
		},
		async work() {
			await jobs.work(
				decideQueue,
				async ({ userId, opportunityId, fallback }) => {
					await runDecide(userId, opportunityId, fallback);
				},
				{ localConcurrency: 2 },
			);
		},
	};
}

/** The same AI failure this many times in a row suspends a Package's paid retries (§5). */
export const PREPARE_SUSPEND_AFTER = 3;
/** Retry delays after the 1st and 2nd identical failure; the 3rd suspends. */
const PREPARE_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000];
/** A spend cap or a posting fetch that failed: try again later, without counting toward suspension. */
const PREPARE_DEFER_MS = 30 * 60 * 1000;

export type PreparationPipeline = {
	/**
	 * `prepare(application)` (§5 step 5, §9): captures the Job Snapshot, then the Strategy, then
	 * the tailored resume and the answers to the posting's questions side by side, each
	 * checkpointed so a repeated job skips what exists. With all of them stored the Application
	 * is READY, or NEEDS_YOU when a required question needs the Candidate. An AI failure keeps
	 * what is done and tries again later; never an Intervention. Safe to repeat.
	 */
	runPrepare(userId: UserId, applicationId: string): Promise<void>;
	/** Registers the `prepare` consumer. */
	work(): Promise<void>;
};

export function createPreparationPipeline(deps: {
	db: Db;
	jobs: Jobs;
	llm: LlmClient;
	storage: Storage;
	adapters: Adapters;
	log: Logger;
}): PreparationPipeline {
	const { db, jobs, llm, storage, adapters, log } = deps;

	async function retryLater(userId: UserId, applicationId: string, delayMs: number) {
		await jobs.send(prepareQueue, { userId, applicationId }, { startAfter: new Date(Date.now() + delayMs) });
	}

	async function runPrepare(userId: UserId, applicationId: string) {
		const application = await getApplication(db, userId, applicationId);
		if (application?.status !== "PREPARING" || !application.preparationDispatchedAt) return;
		let pkg = await getPackage(db, userId, applicationId);
		// Suspended after repeated identical AI failures: wait until the User's AI setup changes.
		if (pkg?.suspendedAt) {
			const changed = await aiSetupChangedAt(db, userId);
			if (!changed || changed <= pkg.suspendedAt) return;
		}

		try {
			if (!pkg) {
				// Captured once, at the start of preparation, and never overwritten (§13).
				const snapshot = await readPostingSnapshot(db, adapters, userId, application.opportunityId);
				// No open Sighting: the sweeper expires the Application once the posting closes.
				if (!snapshot) return;
				pkg = await db.transaction((tx) => startPackage(tx, userId, applicationId, snapshot));
			}
			const hunt = await getHunt(db, userId, application.drivingHuntId);
			if (!hunt) throw new Error("the Driving Hunt is missing");
			const input = {
				context: await buildCandidateContext(db, userId, {
					drivingHuntId: hunt.id,
					opportunityId: application.opportunityId,
				}),
				snapshot: pkg.jobSnapshot,
				latitude: hunt.creativeLatitude,
				attribution: { userId, huntId: hunt.id, applicationId, opportunityId: application.opportunityId },
			};

			let strategy = pkg.strategy;
			if (!strategy) {
				const planned = await planStrategy(llm, input);
				await db.transaction((tx) => saveStrategy(tx, userId, applicationId, planned));
				strategy = planned.strategy;
			}
			const started = pkg;
			const writeResumeStep = async () => {
				if (started.resume) return;
				const written = await writeResume(llm, { ...input, strategy });
				// Template choice per Candidate arrives with Classic; Modern is the default (#30).
				const templateId = DEFAULT_TEMPLATE;
				const rendered = renderResume(templateId, written.document);
				await db.transaction(async (tx) => {
					const pdf = await storage.put(tx, rendered.pdf, {
						mediaType: "application/pdf",
						retentionClass: "permanent",
					});
					await saveResume(tx, userId, applicationId, {
						document: written.document,
						inputHash: written.inputHash,
						callId: written.callId,
						templateId,
						pdf,
						pages: rendered.pages,
						droppedClaims: written.droppedClaims,
						trimmedBullets: rendered.trimmedBullets,
					});
				});
				log.info({
					event: "resume_written",
					userId,
					applicationId,
					pages: rendered.pages,
					droppedClaims: written.droppedClaims,
					trimmedBullets: rendered.trimmedBullets,
				});
			};
			const answerStep = async () => {
				if (started.answers) return true;
				const questions = await readApplicationQuestions(adapters, started.jobSnapshot);
				// Gone: the sweeper expires the Application once discovery sees the posting close.
				if (!questions) return false;
				const answered = await answerQuestions(llm, {
					...input,
					strategy,
					hunt: { id: hunt.id, locations: hunt.criteria.locations, payFloor: hunt.criteria.payFloor },
					questions,
				});
				await db.transaction((tx) => saveAnswers(tx, userId, applicationId, answered));
				log.info({
					event: "answers_written",
					userId,
					applicationId,
					questions: answered.answers.length,
					droppedAnswers: answered.droppedAnswers,
					escalations: answered.answers.filter((a) => a.escalation).length,
				});
				return true;
			};
			// The resume and the answers both follow the Strategy and not each other (#16).
			const [resumed, answered] = await Promise.allSettled([writeResumeStep(), answerStep()]);
			if (resumed.status === "rejected") throw resumed.reason;
			if (answered.status === "rejected") throw answered.reason;
			if (!answered.value) return;
			await db.transaction(async (tx) => {
				await clearPreparationFailure(tx, userId, applicationId);
				const prepared = await getPackage(tx, userId, applicationId);
				if (!prepared?.resume || !prepared.answers) throw new Error("the Package is incomplete");
				// Narrow escalation (#16): only a required question the Candidate must answer pauses it.
				const to = prepared.answers.some((a) => a.escalation) ? "NEEDS_YOU" : "READY";
				if (await transition(tx, userId, applicationId, "PREPARING", to)) {
					log.info({ event: "application_prepared", userId, applicationId, status: to });
				}
			});
		} catch (error) {
			if (error instanceof PostingUnavailable || error instanceof BudgetExceeded) {
				log.warn({ event: "preparation_deferred", userId, applicationId, reason: error.name });
				await retryLater(userId, applicationId, PREPARE_DEFER_MS);
				return;
			}
			if (!(error instanceof LlmError) || !pkg) throw error;
			const { task, provider, model, errorClass, schemaHash } = error.fingerprint;
			const failed = await db.transaction((tx) =>
				recordPreparationFailure(tx, userId, applicationId, {
					fingerprint: [task, provider, model, errorClass, schemaHash].join(":"),
					errorClass,
					suspendAfter: PREPARE_SUSPEND_AFTER,
				}),
			);
			log.warn({ event: "preparation_failed", userId, applicationId, errorClass, count: failed.count });
			if (failed.suspended) log.warn({ event: "preparation_suspended", userId, applicationId, errorClass });
			const delay = PREPARE_BACKOFF_MS[failed.count - 1];
			if (delay !== undefined) await retryLater(userId, applicationId, delay);
		}
	}

	return {
		runPrepare,
		async work() {
			await jobs.work(prepareQueue, ({ userId, applicationId }) => runPrepare(userId, applicationId), {
				localConcurrency: 2,
			});
		},
	};
}
