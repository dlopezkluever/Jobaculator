import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScriptedLlm } from "../../ai/testing";
import { createCandidate, proposeFacts } from "../../candidate/index";
import type { UserId } from "../../db/ownership";
import { createTestDatabase, newUserId, type TestDatabase } from "../../db/testing";
import {
	createGreenhouseAdapter,
	createSourceHttp,
	type FetchLike,
	listOpportunities,
	listWatchedBoards,
	watchBoards,
} from "../../discovery/index";
import { listEvents } from "../../events/index";
import { createHunt, setHuntStatus } from "../../hunts/index";
import { createJobs, type Jobs } from "../../jobs/index";
import { createLogger } from "../../log/index";
import { getMatch, listMatches, MATCH_SUBJECT, requestEvaluations } from "../../matching/index";
import { createStorage } from "../../storage/index";
import { createDiscoveryPipeline, createMatchingPipeline, type DiscoveryPipeline, PIPELINE_QUEUES } from "../index";

// The recorded Figma Board, served from a body the test can change between polls.
const fixture = JSON.parse(
	readFileSync(join(import.meta.dirname, "../../discovery/tests/fixtures/greenhouse-figma.json"), "utf8"),
);
let body: { jobs: { title: string; content: string }[]; meta: { total: number } } = structuredClone(fixture.body);
const fetch: FetchLike = async () => new Response(JSON.stringify(body), { status: 200 });

const extraction = (requiredYears: { value: number; quote: string | null }) => ({
	task: "extract" as const,
	output: {
		pay: { min: null, max: null, currency: null, period: null, quote: null },
		seniority: { value: null, quote: null },
		workplace: { value: null, quote: null },
		requiredYears,
	},
});
const llm = createScriptedLlm([
	extraction({ value: 5, quote: "5+ years of software engineering experience" }),
	extraction({ value: 3, quote: null }),
]);

let database: TestDatabase;
let jobs: Jobs;
let discovery: DiscoveryPipeline;
let matching: ReturnType<typeof createMatchingPipeline>;
beforeAll(async () => {
	database = await createTestDatabase();
	jobs = createJobs({ databaseUrl: database.url, queues: PIPELINE_QUEUES });
	await jobs.start();
	const log = createLogger({ level: "fatal" });
	discovery = createDiscoveryPipeline({
		db: database.db,
		jobs,
		storage: createStorage(mkdtempSync(join(tmpdir(), "blobs-"))),
		adapters: { greenhouse: createGreenhouseAdapter(createSourceHttp({ fetch, minIntervalMs: 0 })) },
		log,
	});
	matching = createMatchingPipeline({ db: database.db, jobs, llm, log });
	await discovery.work();
	await matching.work();
});
afterAll(async () => {
	await jobs.stop({ timeoutMs: 1000 });
	await database.close();
});

async function until(check: () => Promise<boolean>, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

const targeting = { ideal: [], good: [], acceptable: [], unacceptable: [], anythingElseUnacceptable: false };
const huntInput = (name: string) => ({
	name,
	criteria: {
		roles: { ...targeting, ideal: ["AI Engineer"], anythingElseUnacceptable: true },
		locations: targeting,
		payFloor: null,
		experienceStretch: null,
	},
});

describe("matching pipeline", () => {
	it("evaluates each new or changed Opportunity for every active Hunt, never for a paused one", async () => {
		const owner = newUserId() as UserId;
		await database.db.execute(
			sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
		);
		await createCandidate(database.db, owner);
		// Overlapping roles count once: Jan 2021 – May 2023 is 2.4 years, so the stretch allows 4.8.
		const role = (ref: string) => ({ ref, kind: "role" as const });
		await proposeFacts(database.db, owner, { kind: "candidate", via: "profile_editor" }, [
			{ kind: "employer", value: "Acme", entry: role("a") },
			{ kind: "start_date", value: "2021-01", entry: role("a") },
			{ kind: "end_date", value: "2022-12", entry: role("a") },
			{ kind: "employer", value: "Initech", entry: role("b") },
			{ kind: "start_date", value: "2022-06", entry: role("b") },
			{ kind: "end_date", value: "2023-05", entry: role("b") },
		]);
		const active = await createHunt(database.db, owner, huntInput("Active"));
		const paused = await createHunt(database.db, owner, huntInput("Paused"));
		await setHuntStatus(database.db, owner, paused.id, "PAUSED");
		await watchBoards(database.db, owner, [{ source: "greenhouse", token: "figma", employer: "Figma" }], "SEED");
		const [board] = await listWatchedBoards(database.db, owner);
		if (!board) throw new Error("no Board");

		await discovery.runDiscover(owner, board.id);
		await until(async () => (await listOpportunities(database.db, owner)).length === 3);
		const opportunities = await listOpportunities(database.db, owner);
		const ids = opportunities.map((o) => o.id);
		const settled = async (n: number) =>
			(await listMatches(database.db, owner, ids)).filter((m) => m.status !== "PENDING").length === n;
		await until(() => settled(3));

		const matches = await listMatches(database.db, owner, ids);
		expect(new Set(matches.map((m) => m.huntId))).toEqual(new Set([active.id]));
		const aiEngineer = opportunities.find((o) => o.title.startsWith("AI Engineer"));
		const byOpportunity = (id: string | undefined) => matches.find((m) => m.opportunityId === id);
		expect(byOpportunity(aiEngineer?.id)).toMatchObject({
			status: "DISQUALIFIED",
			decision: "SKIP",
			reason: "experience_beyond_stretch",
		});
		expect(matches.filter((m) => m.reason === "role_unacceptable")).toHaveLength(2);
		// Only the posting that passed the prefilter was extracted.
		expect(llm.calls).toHaveLength(1);

		// A changed posting is evaluated again, by a fresh extraction.
		body = structuredClone(fixture.body);
		const job = body.jobs.find((j) => j.title.startsWith("AI Engineer"));
		if (!job) throw new Error("no fixture job");
		job.content += "&lt;p&gt;Three years of experience is enough.&lt;/p&gt;";
		await discovery.runDiscover(owner, board.id);
		await until(
			async () =>
				(await getMatch(database.db, owner, byOpportunity(aiEngineer?.id)?.id ?? ""))?.reason === "auto_policy",
		);
		expect(llm.remaining()).toBe(0);
		const matchId = byOpportunity(aiEngineer?.id)?.id ?? "";
		expect((await listEvents(database.db, owner, { type: MATCH_SUBJECT, id: matchId })).map((e) => e.payload)).toEqual([
			expect.objectContaining({ reason: "experience_beyond_stretch" }),
			expect.objectContaining({ reason: "auto_policy", qualified: true }),
		]);

		// A Match asked to evaluate while its Hunt is paused waits, PENDING.
		await setHuntStatus(database.db, owner, active.id, "PAUSED");
		const [pending] = await database.db.transaction((tx) =>
			requestEvaluations(tx, owner, aiEngineer?.id ?? "", [active.id]),
		);
		await matching.runEvaluate(owner, pending ?? "");
		expect(await getMatch(database.db, owner, pending ?? "")).toMatchObject({ status: "PENDING" });
	});
});
