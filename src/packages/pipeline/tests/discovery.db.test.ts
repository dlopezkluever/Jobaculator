import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_BOARDS } from "../../config/index";
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
import { createHunt, setHuntStatus } from "../../hunts/index";
import { createJobs, type Jobs } from "../../jobs/index";
import { createLogger } from "../../log/index";
import { createStorage } from "../../storage/index";
import { createDiscoveryPipeline, DISCOVERY_QUEUES, type DiscoveryPipeline } from "../index";

// The seed Boards' recorded listings, served by URL; anything else is refused.
const fixtures = new Map(
	SEED_BOARDS.map(({ token }) => {
		const path = join(import.meta.dirname, "../../discovery/tests/fixtures", `greenhouse-${token}.json`);
		const fixture = JSON.parse(readFileSync(path, "utf8"));
		return [fixture.url as string, JSON.stringify(fixture.body)];
	}),
);
let requests = 0;
const fetch: FetchLike = async (input) => {
	requests++;
	const body = fixtures.get(new Request(input).url);
	if (body === undefined) throw new Error(`unexpected request ${new Request(input).url}`);
	return new Response(body, { status: 200 });
};

let database: TestDatabase;
let jobs: Jobs;
let pipeline: DiscoveryPipeline;
beforeAll(async () => {
	database = await createTestDatabase();
	jobs = createJobs({ databaseUrl: database.url, queues: DISCOVERY_QUEUES });
	await jobs.start();
	pipeline = createDiscoveryPipeline({
		db: database.db,
		jobs,
		storage: createStorage(mkdtempSync(join(tmpdir(), "blobs-"))),
		adapters: { greenhouse: createGreenhouseAdapter(createSourceHttp({ fetch, minIntervalMs: 0 })) },
		log: createLogger({ level: "fatal" }),
	});
});
afterAll(async () => {
	await jobs.stop({ timeoutMs: 1000 });
	await database.close();
});

async function newUser(): Promise<UserId> {
	const owner = newUserId();
	await database.db.execute(
		sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
	);
	return owner;
}

const huntInput = {
	name: "Engineering",
	criteria: {
		roles: { ideal: ["Engineer"], good: [], acceptable: [], unacceptable: [], anythingElseUnacceptable: false },
		locations: { ideal: [], good: [], acceptable: [], unacceptable: [], anythingElseUnacceptable: false },
		payFloor: null,
		experienceStretch: null,
	},
};

const queued = async (name: string) =>
	(
		await database.db.execute<{ n: number }>(
			sql`select count(*)::int as n from pgboss.job where name = ${name} and state in ('created', 'retry', 'active')`,
		)
	).rows[0]?.n ?? 0;

async function until(check: () => Promise<boolean>, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe("discovery pipeline", () => {
	it("polls the seed Boards only while a Hunt is active, never twice at once, and ingests every posting", async () => {
		const idle = await newUser();
		const hunting = await newUser();
		const paused = await newUser();
		await createHunt(database.db, hunting, huntInput);
		const { id: pausedHunt } = await createHunt(database.db, paused, huntInput);
		await setHuntStatus(database.db, paused, pausedHunt, "PAUSED");

		// Only the User with an ACTIVE Hunt gets the seed Boards and a poll of each.
		expect(await pipeline.tick()).toBe(3);
		expect((await listWatchedBoards(database.db, hunting)).map((b) => b.token)).toEqual([
			"anthropic",
			"figma",
			"stripe",
		]);
		expect(await listWatchedBoards(database.db, idle)).toEqual([]);
		expect(await listWatchedBoards(database.db, paused)).toEqual([]);
		// A poll already queued for a (User, Board) is skipped, not queued again.
		expect(await pipeline.tick()).toBe(0);
		expect(await queued("discover")).toBe(3);

		await pipeline.work();
		// 2 + 3 + 3 recorded postings.
		await until(
			async () => (await listOpportunities(database.db, hunting)).length === 8 && (await queued("ingest")) === 0,
		);
		const opportunities = await listOpportunities(database.db, hunting);
		expect(new Set(opportunities.map((o) => o.employerName))).toEqual(new Set(["Anthropic", "Figma", "Stripe"]));

		// Polled just now, so nothing is due until the next interval.
		await until(async () => (await queued("discover")) === 0);
		expect(await pipeline.tick()).toBe(0);
	});

	it("drops a queued poll once none of the User's Hunts is active", async () => {
		const owner = await newUser();
		const { id } = await createHunt(database.db, owner, huntInput);
		await watchBoards(database.db, owner, SEED_BOARDS, "SEED");
		const [watched] = await listWatchedBoards(database.db, owner);
		if (!watched) throw new Error("no Board");
		await setHuntStatus(database.db, owner, id, "PAUSED");
		const before = requests;
		await pipeline.runDiscover(owner, watched.id);
		expect(requests).toBe(before);
		expect((await listWatchedBoards(database.db, owner)).every((b) => b.lastListedAt === null)).toBe(true);
	});
});
