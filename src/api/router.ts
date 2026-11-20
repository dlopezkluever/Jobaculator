import { isSessionLockHeld } from "../packages/db/index";
import { WORKER_LOCK_KEY } from "../packages/jobs/index";
import { authedProcedure, router } from "./trpc";

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
});

export type AppRouter = typeof appRouter;
