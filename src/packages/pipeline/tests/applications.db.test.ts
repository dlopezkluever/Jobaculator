import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScriptedLlm } from "../../ai/testing";
import {
	APPLICATION_SUBJECT,
	getApplication,
	getApplicationForOpportunity,
	listApplications,
	transition,
} from "../../applications/index";
import { createCandidate, proposeFacts } from "../../candidate/index";
import type { UserId } from "../../db/ownership";
import { createTestDatabase, newUserId, type TestDatabase } from "../../db/testing";
import { ingest, listWatchedBoards, type SourcePosting, watchBoards } from "../../discovery/index";
import { listEvents } from "../../events/index";
import { listActiveHolds } from "../../holds/index";
import { createHunt, setHuntStatus } from "../../hunts/index";
import { createJobs, type Jobs } from "../../jobs/index";
import { createLogger } from "../../log/index";
import { listMatches, requestEvaluations } from "../../matching/index";
import { createStorage, type Storage } from "../../storage/index";
import {
	type ApplicationPipeline,
	createApplicationPipeline,
	createMatchingPipeline,
	decideQueue,
	PIPELINE_QUEUES,
	prepareQueue,
} from "../index";

// Postings without a description are never extracted, so no step needs the model.
const llm = createScriptedLlm([]);
const log = createLogger({ level: "fatal" });
const DAY = 24 * 60 * 60 * 1000;

let database: TestDatabase;
let jobs: Jobs;
let storage: Storage;
let matching: ReturnType<typeof createMatchingPipeline>;
beforeAll(async () => {
	database = await createTestDatabase();
	jobs = createJobs({ databaseUrl: database.url, queues: PIPELINE_QUEUES });
	await jobs.start();
	storage = createStorage(mkdtempSync(join(tmpdir(), "blobs-")));
	matching = createMatchingPipeline({ db: database.db, jobs, llm, log });
});
afterAll(async () => {
	await jobs.stop({ timeoutMs: 1000 });
	await database.close();
});

const pipeline = (readyBacklog = 8) => createApplicationPipeline({ db: database.db, jobs, log, readyBacklog });

async function until(check: () => Promise<boolean>, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

const targeting = { ideal: [], good: [], acceptable: [], unacceptable: [], anythingElseUnacceptable: false };
/** Fit is the role's tier score alone: Ideal 100, Good 80, anything unlisted Acceptable 60. */
const hunt = (name: string, roles: { ideal?: string[]; good?: string[]; unacceptable?: string[] }) => ({
	name,
	criteria: {
		roles: { ...targeting, ideal: [], good: [], unacceptable: [], ...roles },
		locations: targeting,
		payFloor: null,
		experienceStretch: null,
	},
});

/** A User with a Candidate, contact identity unless `contact` is false, and one watched Board. */
async function newUser(options: { contact?: boolean } = {}) {
	const owner = newUserId() as UserId;
	await database.db.execute(
		sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
	);
	await createCandidate(database.db, owner);
	if (options.contact !== false) await addContact(owner);
	await watchBoards(database.db, owner, [{ source: "greenhouse", token: "acme", employer: "Acme" }], "SEED");
	const [board] = await listWatchedBoards(database.db, owner);
	if (!board) throw new Error("no Board");
	return { owner, boardId: board.id };
}

async function addContact(owner: UserId) {
	await proposeFacts(database.db, owner, { kind: "candidate", via: "profile_editor" }, [
		{ kind: "name", value: "Ada Lovelace" },
		{ kind: "email", value: "ada@example.com" },
	]);
}

let nativeId = 1000;
function posting(title: string, postedDaysAgo: number | null): SourcePosting {
	const id = String(nativeId++);
	return {
		source: "greenhouse",
		boardToken: "acme",
		nativeId: id,
		requisitionId: null,
		url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
		applyUrl: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
		title,
		employerName: null,
		locationText: null,
		workplaceType: null,
		employmentType: null,
		salary: null,
		firstPublishedAt: postedDaysAgo === null ? null : new Date(Date.now() - postedDaysAgo * DAY).toISOString(),
		descriptionHtml: null,
		listed: true,
		raw: {},
	};
}

/** Ingests a posting and evaluates it for the given Hunts, as ingest and `evaluate` would. Returns the Opportunity id. */
async function judged(
	user: { owner: UserId; boardId: string },
	huntIds: string[],
	p: SourcePosting,
	evaluated: string[] = huntIds,
	by = matching,
) {
	const ingested = await ingest(database.db, storage, user.owner, user.boardId, p, { continuous: false });
	if (!ingested) throw new Error("not ingested");
	await database.db.transaction((tx) => requestEvaluations(tx, user.owner, ingested.opportunityId, huntIds));
	const matches = await listMatches(database.db, user.owner, [ingested.opportunityId]);
	for (const m of matches) if (evaluated.includes(m.huntId)) await by.runEvaluate(user.owner, m.id);
	return ingested.opportunityId;
}

const decideJobs = async (opportunityId: string) =>
	(
		await database.db.execute<{ n: number }>(
			sql`select count(*)::int as n from pgboss.job where name = 'decide' and data->>'opportunityId' = ${opportunityId}`,
		)
	).rows[0]?.n;

describe("decide", () => {
	it("creates one Application per Opportunity, driven by the highest-fit Hunt, however often it runs", async () => {
		const user = await newUser();
		const good = await createHunt(database.db, user.owner, hunt("Backend", { good: ["Engineer"] }));
		const ideal = await createHunt(database.db, user.owner, hunt("Platform", { ideal: ["Platform"] }));
		const skips = await createHunt(
			database.db,
			user.owner,
			hunt("Design", { ideal: ["Designer"], unacceptable: ["Engineer"] }),
		);
		const opportunityId = await judged(user, [good.id, ideal.id, skips.id], posting("Platform Engineer", 1));

		// The last evaluation to settle sends `decide` in its own transaction.
		expect(await decideJobs(opportunityId)).toBe(1);

		const apps = pipeline();
		const runs = await Promise.all(
			Array.from({ length: 6 }, (_, i) => apps.runDecide(user.owner, opportunityId, i % 2 === 0)),
		);
		expect(runs.filter((id) => id !== null)).toHaveLength(1);

		const all = await listApplications(database.db, user.owner);
		expect(all).toHaveLength(1);
		const application = await getApplicationForOpportunity(database.db, user.owner, opportunityId);
		const matches = await listMatches(database.db, user.owner, [opportunityId]);
		const idealMatch = matches.find((m) => m.huntId === ideal.id);
		// The Skip of the Design Hunt never vetoes; the Ideal Hunt (100) outranks the Good one (80).
		expect(application).toMatchObject({
			status: "PREPARING",
			drivingHuntId: ideal.id,
			drivingMatchId: idealMatch?.id,
			fit: 100,
			review: false,
			evaluation: { huntId: ideal.id, fit: 100, decision: "AUTO_APPLY", submissionPolicy: "AUTO" },
		});
		const events = await listEvents(database.db, user.owner, { type: APPLICATION_SUBJECT, id: application?.id ?? "" });
		expect(events.map((e) => e.code)).toEqual(["application_created"]);
		expect(events[0]?.payload).toMatchObject({ drivingHuntId: ideal.id, fit: 100 });
		expect((events[0]?.payload as { matchIds?: string[] } | undefined)?.matchIds).toHaveLength(2);

		// A changed posting re-evaluates for future decisions only: the Application and its frozen copy stay.
		await database.db.transaction((tx) => requestEvaluations(tx, user.owner, opportunityId, [good.id]));
		expect(await apps.runDecide(user.owner, opportunityId, true)).toBeNull();
		expect(await getApplicationForOpportunity(database.db, user.owner, opportunityId)).toEqual(application);
	});

	it("waits for every active Hunt's Match unless it is the fallback, and never applies for a paused Hunt", async () => {
		const user = await newUser();
		const first = await createHunt(database.db, user.owner, hunt("First", { good: ["Engineer"] }));
		const slow = await createHunt(database.db, user.owner, hunt("Slow", { ideal: ["Engineer"] }));
		// Both are asked; only the first evaluates, so it does not send `decide`.
		const opportunityId = await judged(user, [first.id, slow.id], posting("Engineer", null), [first.id]);
		expect(await decideJobs(opportunityId)).toBe(0);
		const apps = pipeline();
		expect(await apps.runDecide(user.owner, opportunityId, false)).toBeNull();
		// The fallback decides on what has settled: the slow Hunt cannot drive it any more.
		const id = await apps.runDecide(user.owner, opportunityId, true);
		expect(await getApplication(database.db, user.owner, id ?? "")).toMatchObject({ drivingHuntId: first.id, fit: 80 });

		const paused = await createHunt(database.db, user.owner, hunt("Paused", { ideal: ["Designer"] }));
		const other = await judged(user, [paused.id], posting("Designer", 1));
		await setHuntStatus(database.db, user.owner, paused.id, "PAUSED");
		expect(await apps.runDecide(user.owner, other, true)).toBeNull();
	});
});

const dispatched = async (owner: UserId) =>
	(await listApplications(database.db, owner)).filter((a) => a.preparing).map((a) => a.title);

describe("prepare dispatcher", () => {
	it("pulls in Opportunity Value order up to a small READY backlog, once each", async () => {
		await clearApplications();
		const user = await newUser();
		const h = await createHunt(database.db, user.owner, hunt("Eng", { ideal: ["Platform"], good: ["Backend"] }));
		const apps = pipeline(3);
		// Created out of order. Fit 80 posted 2 days ago (tier 1) beats Fit 100 posted 4 days ago (tier 2):
		// \"fit, then recency\" would not.
		const titles: [string, number | null][] = [
			["Designer recent", 0], // 60, tier 3
			["Platform old", 4], // 100, tier 2
			["Backend unknown age", null], // 80, tier 2
			["Backend recent", 2], // 80, tier 1
			["Platform older", 30], // 100, tier 2, created after "Platform old"
			["Designer old", 10], // 60, tier 4
		];
		for (const [title, age] of titles)
			await apps.runDecide(user.owner, await judged(user, [h.id], posting(title, age)), false);
		// runDecide nudged the dispatcher each time; with backlog 3 the first three created were taken.
		await clearDispatch();

		// Concurrent ticks share the capacity: three dispatched, none twice.
		const counts = await Promise.all([apps.dispatch(), apps.dispatch(), apps.dispatch()]);
		expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
		expect(await dispatched(user.owner)).toEqual(
			expect.arrayContaining(["Backend recent", "Platform old", "Platform older"]),
		);
		expect(await dispatched(user.owner)).toHaveLength(3);
		const prepares = await database.db.execute<{ id: string }>(
			sql`select data->>'applicationId' as id from pgboss.job where name = 'prepare' order by created_on`,
		);
		expect(prepares.rows).toHaveLength(3);

		// Full: a READY Application still counts against the backlog; one in the browser does not.
		const backendRecent = (await listApplications(database.db, user.owner)).find((a) => a.title === "Backend recent");
		await database.db.transaction((tx) => transition(tx, user.owner, backendRecent?.id ?? "", "PREPARING", "READY"));
		expect(await apps.dispatch()).toBe(0);
		await database.db.transaction((tx) => transition(tx, user.owner, backendRecent?.id ?? "", "READY", "APPLYING"));
		expect(await apps.dispatch()).toBe(1);
		expect(await dispatched(user.owner)).toContain("Backend unknown age");
		const all = await listApplications(database.db, user.owner);
		await database.db.transaction(async (tx) => {
			for (const a of all.filter((x) => x.preparing)) await transition(tx, user.owner, a.id, "PREPARING", "ABANDONED");
		});
		expect(await apps.dispatch()).toBe(2);
		expect(await dispatched(user.owner)).toEqual(expect.arrayContaining(["Designer recent", "Designer old"]));
		await expect(
			database.db.transaction((tx) => transition(tx, user.owner, backendRecent?.id ?? "", "APPLYING", "PREPARING")),
		).rejects.toThrow("cannot go from APPLYING to PREPARING");
	});

	it("holds a Candidate without a name and email out of preparation until both are added", async () => {
		await clearApplications();
		const user = await newUser({ contact: false });
		const h = await createHunt(database.db, user.owner, hunt("Eng", { ideal: ["Engineer"] }));
		const apps = pipeline(5);
		await apps.runDecide(user.owner, await judged(user, [h.id], posting("Engineer", 1)), false);
		expect(await apps.dispatch()).toBe(0);
		expect(await listActiveHolds(database.db, user.owner)).toMatchObject([
			{ scope: "contact_identity", reason: "name,email" },
		]);
		await apps.dispatch();
		expect(await listActiveHolds(database.db, user.owner)).toHaveLength(1);

		await addContact(user.owner);
		expect(await apps.dispatch()).toBe(1);
		expect(await listActiveHolds(database.db, user.owner)).toEqual([]);
		const holdEvents = await database.db.execute<{ code: string }>(
			sql`select code from event where user_id = ${user.owner} and subject_type = 'hold' order by id`,
		);
		expect(holdEvents.rows.map((r) => r.code)).toEqual(["hold_raised", "hold_lifted"]);
	});
});

describe("sweeper", () => {
	it("re-nudges stuck Matches, decisions and preparations, and expires Applications of closed postings", async () => {
		// The sweeper looks across Users: earlier tests' records are left out of it.
		await clearApplications();
		await database.db.execute(sql`update hunt set status = 'PAUSED'`);
		const user = await newUser();
		const h = await createHunt(database.db, user.owner, hunt("Eng", { ideal: ["Engineer"] }));
		const apps: ApplicationPipeline = pipeline(1);
		await matching.work();
		await apps.work();

		// A Match whose evaluation was lost (asked for while the Hunt was paused, say) has no job.
		const ingested = await ingest(database.db, storage, user.owner, user.boardId, posting("Engineer", 1), {
			continuous: false,
		});
		const opportunityId = ingested?.opportunityId ?? "";
		await database.db.transaction((tx) => requestEvaluations(tx, user.owner, opportunityId, [h.id]));
		expect((await apps.sweep()).evaluate).toBe(1);
		// evaluate → decide → dispatched to prepare, with nothing consuming `prepare` yet.
		await until(async () => (await dispatched(user.owner)).length === 1);
		expect(await apps.sweep()).toEqual({ evaluate: 0, decide: 0, prepare: 0, expired: 0 });

		// Its `prepare` job is lost: the sweeper sends it again, once.
		await database.db.execute(sql`delete from pgboss.job where name = 'prepare'`);
		expect((await apps.sweep()).prepare).toBe(1);
		expect((await apps.sweep()).prepare).toBe(0);
		expect((await jobs.live(prepareQueue)).map((j) => j.userId)).toEqual([user.owner]);

		// Duplicate `decide` jobs through the queue still make one Application.
		const other = await judged(user, [h.id], posting("Staff Engineer", 1));
		for (let i = 0; i < 3; i++) {
			await jobs.send(decideQueue, { userId: user.owner, opportunityId: other, fallback: i > 0 });
		}
		await until(async () => (await jobs.live(decideQueue)).length === 0);
		expect((await listApplications(database.db, user.owner)).filter((a) => a.title === "Staff Engineer")).toHaveLength(
			1,
		);

		// A Match that wants to apply, but its `decide` nudge was lost.
		const dropping = createMatchingPipeline({
			db: database.db,
			jobs: { ...jobs, send: async (q, p, o) => (q.name === decideQueue.name ? null : jobs.send(q, p, o)) },
			llm,
			log,
		});
		const lost = await judged(user, [h.id], posting("Engineer II", 1), [h.id], dropping);
		expect(await getApplicationForOpportunity(database.db, user.owner, lost)).toBeNull();
		expect((await apps.sweep()).decide).toBe(1);
		await until(async () => (await getApplicationForOpportunity(database.db, user.owner, lost)) !== null);

		// The posting closes: its waiting Application expires, with its event.
		await database.db.execute(sql`update opportunity set status = 'CLOSED' where id = ${other}`);
		expect((await apps.sweep()).expired).toBe(1);
		const expired = await getApplicationForOpportunity(database.db, user.owner, other);
		expect(expired?.status).toBe("EXPIRED");
		const events = await listEvents(database.db, user.owner, { type: APPLICATION_SUBJECT, id: expired?.id ?? "" });
		expect(events.at(-1)?.payload).toEqual({ from: "PREPARING", to: "EXPIRED" });
	});
});

/** Each test reasons about the global READY backlog, so it starts with no Application of any User preparing. */
async function clearApplications() {
	await database.db.execute(sql`update application set status = 'ABANDONED' where status in ('PREPARING', 'READY')`);
	await clearDispatch();
}
async function clearDispatch() {
	await database.db.execute(sql`update application set preparation_dispatched_at = null where status = 'PREPARING'`);
	await database.db.execute(sql`delete from pgboss.job where name = 'prepare'`);
}
