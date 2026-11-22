import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	getAiSettings,
	KeyValidationError,
	listProviderKeys,
	PRESETS,
	PROVIDERS,
	removeProviderKey,
	SettingsError,
	saveProviderKey,
	updateAiSettings,
} from "../packages/ai/index";
import { countInFlight, listApplications } from "../packages/applications/index";
import { isSessionLockHeld } from "../packages/db/index";
import { listOpportunities, listWatchedBoards } from "../packages/discovery/index";
import { listEvents } from "../packages/events/index";
import { countActiveHolds, listActiveHolds } from "../packages/holds/index";
import { HUNT_STATUSES, huntInputSchema } from "../packages/hunts/criteria";
import {
	createHunt,
	getHunt,
	HUNT_SUBJECT,
	type Hunt,
	listHunts,
	setHuntStatus,
	updateHunt,
} from "../packages/hunts/index";
import { WORKER_LOCK_KEY } from "../packages/jobs/index";
import { candidateRouter } from "./candidate";
import { authedProcedure, router } from "./trpc";

const huntId = z.object({ id: z.uuid() });

function found(hunt: Hunt | null): Hunt {
	if (!hunt) throw new TRPCError({ code: "NOT_FOUND", message: "No such Hunt" });
	return hunt;
}

/** Domain validation errors become a 400 with their message (which names the rule, never a value). */
async function asBadRequest<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof KeyValidationError || error instanceof SettingsError) {
			throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
		}
		throw error;
	}
}

export type SubmissionMode = "LIVE" | "DRY_RUN";

export const appRouter = router({
	system: router({
		/** Sidebar footer: the global submission mode and whether the worker is running. */
		status: authedProcedure.query(async ({ ctx }) => ({
			// Dry Run is the default, and `live` stays refused until the launch gate (§17) records a
			// passed restore drill and journal activation, so nothing can switch it yet.
			mode: "DRY_RUN" as SubmissionMode,
			workerRunning: await isSessionLockHeld(ctx.db, WORKER_LOCK_KEY),
			/** One banner per active Hold (§16). */
			holds: (await listActiveHolds(ctx.db, ctx.userId)).map((hold) => ({
				scope: hold.scope,
				reason: hold.reason,
				raisedAt: hold.raisedAt.toISOString(),
			})),
		})),
	}),
	/** Settings → AI keys and spend (§12). Keys are write-only: reads return only their last 4 characters. */
	ai: router({
		settings: authedProcedure.query(async ({ ctx }) => ({
			keys: await listProviderKeys(ctx.db, ctx.userId),
			...(await getAiSettings(ctx.db, ctx.userId)),
		})),
		saveKey: authedProcedure
			.input(z.object({ provider: z.enum(PROVIDERS), key: z.string().max(500) }))
			.mutation(({ ctx, input }) =>
				asBadRequest(() => saveProviderKey(ctx.db, ctx.secrets, ctx.userId, input.provider, input.key)),
			),
		removeKey: authedProcedure
			.input(z.object({ provider: z.enum(PROVIDERS) }))
			.mutation(({ ctx, input }) => removeProviderKey(ctx.db, ctx.userId, input.provider)),
		updateSettings: authedProcedure
			.input(
				z.object({
					preset: z.enum(PRESETS).optional(),
					dailyCapUsd: z.number().min(0).max(10_000).nullable().optional(),
					timeZone: z.string().max(100).optional(),
				}),
			)
			.mutation(({ ctx, input }) => asBadRequest(() => updateAiSettings(ctx.db, ctx.userId, input))),
	}),
	dashboard: router({
		/**
		 * The Dashboard's counts (§16), owner-scoped. Nothing is submitted, Dry Run or waiting on
		 * the Candidate yet; the tickets that add Browser Runs and Interventions count those here.
		 */
		summary: authedProcedure.query(async ({ ctx }) => ({
			submitted: { today: 0, week: 0, allTime: 0 },
			inFlight: await countInFlight(ctx.db, ctx.userId),
			dryRuns: 0,
			attention: { needsYou: 0, review: 0, uncertain: 0 },
			holds: await countActiveHolds(ctx.db, ctx.userId),
		})),
	}),
	hunts: router({
		/** The sidebar's Hunt entries and the Hunts list. */
		list: authedProcedure.query(({ ctx }) => listHunts(ctx.db, ctx.userId)),
		/** One Hunt with its event feed, newest first. */
		get: authedProcedure.input(huntId).query(async ({ ctx, input }) => {
			const hunt = found(await getHunt(ctx.db, ctx.userId, input.id));
			const events = await listEvents(ctx.db, ctx.userId, { type: HUNT_SUBJECT, id: hunt.id });
			return {
				...hunt,
				activity: events
					.map((e) => ({ id: e.id, code: e.code, payload: e.payload, occurredAt: e.occurredAt.toISOString() }))
					.reverse(),
			};
		}),
		create: authedProcedure.input(huntInputSchema).mutation(({ ctx, input }) => createHunt(ctx.db, ctx.userId, input)),
		update: authedProcedure
			.input(huntId.extend({ hunt: huntInputSchema }))
			.mutation(async ({ ctx, input }) => found(await updateHunt(ctx.db, ctx.userId, input.id, input.hunt))),
		setStatus: authedProcedure
			.input(huntId.extend({ status: z.enum(HUNT_STATUSES) }))
			.mutation(async ({ ctx, input }) => found(await setHuntStatus(ctx.db, ctx.userId, input.id, input.status))),
	}),
	/** Every Opportunity discovered on the User's watched Boards, with the Boards' health (§6). */
	opportunities: router({
		list: authedProcedure.query(async ({ ctx }) => {
			const [opportunities, boards] = await Promise.all([
				listOpportunities(ctx.db, ctx.userId),
				listWatchedBoards(ctx.db, ctx.userId),
			]);
			const iso = (date: Date | null) => date?.toISOString() ?? null;
			return {
				opportunities: opportunities.map((o) => ({
					...o,
					postedAt: iso(o.postedAt),
					firstSeenAt: o.firstSeenAt.toISOString(),
				})),
				boards: boards.map((b) => ({
					...b,
					lastListedAt: iso(b.lastListedAt),
					goneAt: iso(b.goneAt),
					nextPollAt: iso(b.nextPollAt),
				})),
			};
		}),
	}),
	/** The Applications table (§16), newest first. */
	applications: router({
		list: authedProcedure.query(async ({ ctx }) =>
			(await listApplications(ctx.db, ctx.userId)).map((a) => ({
				...a,
				postedAt: a.postedAt?.toISOString() ?? null,
				createdAt: a.createdAt.toISOString(),
				updatedAt: a.updatedAt.toISOString(),
			})),
		),
	}),
	candidate: candidateRouter,
});

export type AppRouter = typeof appRouter;
