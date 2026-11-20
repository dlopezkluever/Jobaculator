import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isSessionLockHeld } from "../packages/db/index";
import { listEvents } from "../packages/events/index";
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

export type SubmissionMode = "LIVE" | "DRY_RUN";

export const appRouter = router({
	system: router({
		/** Sidebar footer: the global submission mode and whether the worker is running. */
		status: authedProcedure.query(async ({ ctx }) => ({
			// Dry Run is the default, and `live` stays refused until the launch gate (§17) records a
			// passed restore drill and journal activation, so nothing can switch it yet.
			mode: "DRY_RUN" as SubmissionMode,
			workerRunning: await isSessionLockHeld(ctx.db, WORKER_LOCK_KEY),
		})),
	}),
	dashboard: router({
		/**
		 * The Dashboard's counts (§16). No Applications, Interventions or Holds exist yet,
		 * so every count is zero; the tickets that add those tables count them here, owner-scoped.
		 */
		summary: authedProcedure.query(() => ({
			submitted: { today: 0, week: 0, allTime: 0 },
			inFlight: { queued: 0, preparing: 0, inBrowser: 0 },
			dryRuns: 0,
			attention: { needsYou: 0, review: 0, uncertain: 0 },
			holds: 0,
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
	candidate: candidateRouter,
});

export type AppRouter = typeof appRouter;
