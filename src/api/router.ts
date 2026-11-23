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
import {
	countDryRuns,
	countInFlight,
	getApplication,
	getPackage,
	getSubmissionMode,
	listApplications,
	listBrowserRuns,
	RunRefused,
	requestDryRun,
} from "../packages/applications/index";
import { getKnowledgeBase } from "../packages/candidate/index";
import { factKind, isFactKindName } from "../packages/candidate/kinds";
import { isSessionLockHeld } from "../packages/db/index";
import { getOpportunity, listOpportunities, listWatchedBoards } from "../packages/discovery/index";
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
		if (error instanceof KeyValidationError || error instanceof SettingsError || error instanceof RunRefused) {
			throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
		}
		throw error;
	}
}

export const appRouter = router({
	system: router({
		/** Sidebar footer: the global submission mode and whether the worker is running. */
		status: authedProcedure.query(async ({ ctx }) => ({
			mode: await getSubmissionMode(ctx.db, ctx.userId),
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
		 * The Dashboard's counts (§16), owner-scoped. Nothing is submitted or waiting on the
		 * Candidate yet; the tickets that add SubmitGate and Interventions count those here.
		 */
		summary: authedProcedure.query(async ({ ctx }) => ({
			submitted: { today: 0, week: 0, allTime: 0 },
			inFlight: await countInFlight(ctx.db, ctx.userId),
			dryRuns: await countDryRuns(ctx.db, ctx.userId),
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
		/** Application detail (§16): the authorizing evaluation, and the Package as far as it is prepared. */
		get: authedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
			const application = await getApplication(ctx.db, ctx.userId, input.id);
			if (!application) throw new TRPCError({ code: "NOT_FOUND", message: "No such Application" });
			const [pkg, opportunity, hunt, knowledge, runs] = await Promise.all([
				getPackage(ctx.db, ctx.userId, application.id),
				getOpportunity(ctx.db, ctx.userId, application.opportunityId),
				getHunt(ctx.db, ctx.userId, application.drivingHuntId),
				getKnowledgeBase(ctx.db, ctx.userId),
				listBrowserRuns(ctx.db, ctx.userId, application.id),
			]);
			// What each answer rests on, as the Candidate reads it. Standing answers are not stored yet (§8).
			const facts = new Map(
				[...knowledge.facts, ...knowledge.entries.flatMap((e) => e.facts)].map((f) => [
					f.id,
					`${isFactKindName(f.kind) ? factKind(f.kind).label : f.kind}: ${f.value}`,
				]),
			);
			const sourceLabel = (id: string) =>
				id.startsWith("hunt:")
					? `Hunt targeting: ${hunt?.name ?? "the Driving Hunt"}`
					: (facts.get(id) ?? "Since removed from your profile");
			return {
				id: application.id,
				status: application.status,
				preparing: application.status === "PREPARING" && application.preparationDispatchedAt !== null,
				fit: application.fit,
				evaluation: application.evaluation,
				title: opportunity?.title ?? pkg?.jobSnapshot.title ?? "",
				employerName: opportunity?.employerName ?? pkg?.jobSnapshot.employerName ?? "",
				drivingHunt: hunt ? { id: hunt.id, name: hunt.name } : null,
				createdAt: application.createdAt.toISOString(),
				package: pkg && {
					jobSnapshot: pkg.jobSnapshot,
					strategy: pkg.strategy,
					resume: pkg.resume,
					resumePages: pkg.resumePages,
					answers: pkg.answers?.map((a) => ({ ...a, sourceLabels: a.sources.map(sourceLabel) })) ?? null,
					hasResumePdf: pkg.resumePdf !== null,
					suspended: pkg.suspendedAt !== null,
				},
				/** The Execution tab (§16): each Browser Run's steps, screenshots and filled values, newest first. */
				runs: runs.map((run) => {
					let shot = 0;
					return {
						id: run.id,
						mode: run.mode,
						status: run.status,
						failure: run.failure,
						url: run.checkpoint?.url ?? null,
						fields: run.checkpoint?.fields ?? [],
						createdAt: run.createdAt.toISOString(),
						startedAt: run.startedAt?.toISOString() ?? null,
						finishedAt: run.finishedAt?.toISOString() ?? null,
						// Screenshots are served by index through the Application, never by blob hash (§13).
						events: run.events.map((e) =>
							e.type === "screenshot" ? { type: e.type, at: e.at, label: e.label, index: shot++ } : e,
						),
					};
				}),
			};
		}),
		/** The Candidate asks for another Dry Run of a READY Application (§5: an explicit per-run choice). */
		dryRun: authedProcedure
			.input(z.object({ id: z.uuid() }))
			.mutation(({ ctx, input }) => asBadRequest(() => requestDryRun(ctx.db, ctx.userId, input.id))),
	}),
	candidate: candidateRouter,
});

export type AppRouter = typeof appRouter;
