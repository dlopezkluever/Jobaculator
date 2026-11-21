import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserId } from "../../db/ownership";
import { assertTwoUserIsolation, createTestDatabase, newUserId, type TestDatabase } from "../../db/testing";
import { listEvents } from "../../events/index";
import { createStorage, parseBlobHash } from "../../storage/index";
import {
	type Adapters,
	discover,
	dueBoards,
	ingest,
	listOpportunities,
	listWatchedBoards,
	OPPORTUNITY_SUBJECT,
	watchBoards,
} from "../index";
import { boardFixture, boardRoutes, greenhouseOver, type Route } from "./helpers";

let database: TestDatabase;
const storage = createStorage(mkdtempSync(join(tmpdir(), "blobs-")));
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(() => database.close());

async function newUser(owner: UserId = newUserId()): Promise<UserId> {
	await database.db.execute(
		sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
	);
	return owner;
}

async function watch(owner: UserId, token: string): Promise<string> {
	await watchBoards(database.db, owner, [{ source: "greenhouse", token, employer: token }], "SEED");
	const board = (await listWatchedBoards(database.db, owner)).find((b) => b.token === token);
	if (!board) throw new Error("not watched");
	return board.id;
}

const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-11-20T12:00:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

/** One poll as the pipeline runs it: `discover`, then `ingest` for each posting it hands over. */
async function poll(owner: UserId, boardId: string, adapters: Adapters, now: Date) {
	const outcome = await discover(database.db, adapters, owner, boardId, { now, random: () => 0.5 });
	if (outcome?.status !== "LISTED") return { outcome, results: [] };
	const results = [];
	for (const { posting, continuous } of outcome.toIngest) {
		results.push(await ingest(database.db, storage, owner, boardId, posting, { continuous, now }));
	}
	return { outcome, results };
}

const listingRoute = (token: string, edit: (jobs: Record<string, unknown>[]) => unknown[]) => {
	const fixture = boardFixture(token);
	const jobs = edit(fixture.body.jobs as Record<string, unknown>[]);
	return new Map<string, Route | Route[]>([
		[fixture.url, { status: 200, body: { jobs, meta: { total: jobs.length } } }],
	]);
};

const eventCodes = async (owner: UserId, id: string) =>
	(await listEvents(database.db, owner, { type: OPPORTUNITY_SUBJECT, id })).map((e) => e.code);

describe("discover and ingest", () => {
	it("re-polling the same listing creates no duplicates and ingests nothing new", async () => {
		const owner = await newUser();
		const boardId = await watch(owner, "figma");
		const adapters = { greenhouse: greenhouseOver(boardRoutes("figma")) };

		const first = await poll(owner, boardId, adapters, at(0));
		expect(first.results.map((r) => r?.outcome)).toEqual(["DISCOVERED", "DISCOVERED", "DISCOVERED"]);
		const before = await listOpportunities(database.db, owner);
		expect(before).toHaveLength(3);

		const second = await poll(owner, boardId, adapters, at(2));
		expect(second.outcome).toMatchObject({ status: "LISTED", listed: 3, toIngest: [] });
		// Ingesting the same posting again (a redelivered job) changes nothing either.
		const posting = first.outcome?.status === "LISTED" ? first.outcome.toIngest[0]?.posting : undefined;
		if (!posting) throw new Error("no posting");
		expect(await ingest(database.db, storage, owner, boardId, posting, { continuous: true, now: at(3) })).toMatchObject(
			{
				outcome: "UNCHANGED",
			},
		);
		expect(await listOpportunities(database.db, owner)).toEqual(before);
	});

	it("stores stated fields, sanitized Markdown and the raw payload as a blob", async () => {
		const owner = await newUser();
		const boardId = await watch(owner, "anthropic");
		await poll(owner, boardId, { greenhouse: greenhouseOver(boardRoutes("anthropic")) }, at(0));
		const [row] = (
			await database.db.execute<{
				description_markdown: string;
				raw_blob: string;
				posted_at: Date;
				posted_at_source: string;
			}>(
				sql`select description_markdown, raw_blob, posted_at, posted_at_source from opportunity where user_id = ${owner} and title = '3P Revenue Accounting & Reporting'`,
			)
		).rows;
		if (!row) throw new Error("not ingested");
		expect(row.description_markdown).not.toMatch(/(^|[^\\])</);
		expect(row.description_markdown.length).toBeGreaterThan(200);
		expect(JSON.parse((await storage.get(parseBlobHash(row.raw_blob))).toString())).toEqual(
			boardFixture("anthropic").body.jobs[0],
		);
		// Greenhouse's first_published is trustworthy, so it dates the posting.
		expect([new Date(row.posted_at).toISOString(), row.posted_at_source]).toEqual([
			"2026-10-19T15:17:24.000Z",
			"SOURCE",
		]);
		expect(await listOpportunities(database.db, owner)).toContainEqual(
			expect.objectContaining({
				title: "3P Revenue Accounting & Reporting",
				workplaceType: "ONSITE",
				employerName: "Anthropic",
			}),
		);
	});

	it("gives two Users separate Opportunities for the same postings", async () => {
		const adapters = { greenhouse: greenhouseOver(boardRoutes("figma")) };
		await assertTwoUserIsolation({
			seed: async (owner) => {
				await newUser(owner);
				await poll(owner, await watch(owner, "figma"), adapters, at(0));
			},
			read: (owner) => listOpportunities(database.db, owner),
		});
		const counts = await database.db.execute<{ users: number; rows: number }>(
			sql`select count(distinct user_id)::int as users, count(*)::int as rows from opportunity o
				where exists (select 1 from watched_board b where b.user_id = o.user_id and b.token = 'figma')
				and o.title = 'Account Executive, Enterprise'`,
		);
		expect(counts.rows[0]?.users).toBe(counts.rows[0]?.rows);
	});

	it("keeps Greenhouse posts that share an internal job id as distinct Opportunities", async () => {
		const owner = await newUser();
		const boardId = await watch(owner, "stripe");
		const { results } = await poll(owner, boardId, { greenhouse: greenhouseOver(boardRoutes("stripe")) }, at(0));
		expect(results.map((r) => r?.outcome)).toEqual(["DISCOVERED", "DISCOVERED", "DISCOVERED"]);
		expect((await listOpportunities(database.db, owner)).map((o) => o.title).sort()).toEqual([
			"Abuse Investigator",
			"Data Scientist",
			"Data Scientist, FX Quantitative Research",
		]);
	});

	it("merges posts a Source states are one requisition into one Opportunity with several Sightings", async () => {
		const owner = await newUser();
		const boardId = await watch(owner, "stripe");
		const listing = await greenhouseOver(boardRoutes("stripe")).listBoard({ source: "greenhouse", token: "stripe" });
		if ("failure" in listing) throw new Error("listing failed");
		const [a, b, c] = listing.postings.map((p) => ({ ...p, requisitionId: p.nativeId === "8172510" ? "R-2" : "R-1" }));
		if (!a || !b || !c) throw new Error("short listing");
		const results = [];
		for (const posting of [a, b, c]) {
			results.push(await ingest(database.db, storage, owner, boardId, posting, { continuous: false, now: at(0) }));
		}
		expect(results.map((r) => r?.outcome)).toEqual(["DISCOVERED", "DISCOVERED", "SIGHTED"]);
		const opportunities = await listOpportunities(database.db, owner);
		expect(opportunities.map((o) => o.sightings).sort()).toEqual([1, 2]);
		const merged = opportunities.find((o) => o.sightings === 2);
		if (!merged) throw new Error("no merge");
		// The Opportunity keeps the content of the post that created it.
		expect(merged.title).toBe("Data Scientist");
		expect(await eventCodes(owner, merged.id)).toEqual(["posting_discovered", "posting_sighted"]);
		const [aliases] = (
			await database.db.execute<{ keys: string[] }>(
				sql`select array_agg(key order by key) as keys from opportunity_alias where opportunity_id = ${merged.id}`,
			)
		).rows;
		expect(aliases?.keys).toEqual([
			"posting:greenhouse:stripe:5601879",
			"posting:greenhouse:stripe:8346831",
			"requisition:greenhouse:stripe:R-1",
			"url:https://stripe.com/jobs/search?gh_jid=5601879",
			"url:https://stripe.com/jobs/search?gh_jid=8346831",
		]);
	});

	it("detects a change of normalized text, and ignores markup and tracking-only edits", async () => {
		const owner = await newUser();
		const boardId = await watch(owner, "figma");
		const { results } = await poll(owner, boardId, { greenhouse: greenhouseOver(boardRoutes("figma")) }, at(0));
		const target = "5426468004";
		const edit = (change: (job: Record<string, unknown>) => Record<string, unknown>) =>
			listingRoute("figma", (jobs) => jobs.map((job) => (String(job.id) === target ? change(job) : job)));

		// Re-wrapped markup and a tracking parameter on the URL: the same normalized text.
		const cosmetic = await poll(
			owner,
			boardId,
			{
				greenhouse: greenhouseOver(
					edit((job) => ({
						...job,
						content: `&lt;div&gt;${job.content}&lt;/div&gt;`,
						absolute_url: `${job.absolute_url}&utm_source=x`,
					})),
				),
			},
			at(2),
		);
		expect(cosmetic.outcome).toMatchObject({ toIngest: [] });

		const retitled = await poll(
			owner,
			boardId,
			{ greenhouse: greenhouseOver(edit((job) => ({ ...job, title: "Account Executive, Strategic" }))) },
			at(4),
		);
		expect(retitled.results.map((r) => r?.outcome)).toEqual(["CHANGED"]);
		const id = retitled.results[0]?.opportunityId ?? "";
		expect(results.map((r) => r?.opportunityId)).toContain(id);
		const events = await listEvents(database.db, owner, { type: OPPORTUNITY_SUBJECT, id });
		expect(events.map((e) => [e.code, (e.payload as { changed?: string[] }).changed])).toEqual([
			["posting_discovered", undefined],
			["posting_changed", ["title"]],
		]);
		expect((await listOpportunities(database.db, owner)).find((o) => o.id === id)?.title).toBe(
			"Account Executive, Strategic",
		);
	});

	it("closes after two complete listings without the posting, and reopens when it returns", async () => {
		const owner = await newUser();
		const boardId = await watch(owner, "figma");
		await poll(owner, boardId, { greenhouse: greenhouseOver(boardRoutes("figma")) }, at(0));
		const gone = "6223155004";
		const without = () => ({
			greenhouse: greenhouseOver(listingRoute("figma", (jobs) => jobs.filter((j) => String(j.id) !== gone))),
		});
		const status = async () => (await listOpportunities(database.db, owner)).find((o) => o.url.endsWith(gone))?.status;

		await poll(owner, boardId, without(), at(2));
		expect(await status()).toBe("OPEN");
		// A failed poll in between neither counts as a missed listing nor resets the count.
		const failing = new Map([[boardFixture("figma").url, { status: 503 }]]);
		expect((await poll(owner, boardId, { greenhouse: greenhouseOver(failing) }, at(3))).outcome).toMatchObject({
			status: "FAILED",
			failure: "TRANSIENT",
		});
		expect(await status()).toBe("OPEN");
		expect((await poll(owner, boardId, without(), at(4))).outcome).toMatchObject({ closedSightings: 1 });
		expect(await status()).toBe("CLOSED");

		const back = await poll(owner, boardId, { greenhouse: greenhouseOver(boardRoutes("figma")) }, at(6));
		expect(back.results.map((r) => r?.outcome)).toEqual(["REOPENED"]);
		expect(await status()).toBe("OPEN");
		const id = back.results[0]?.opportunityId ?? "";
		expect(await eventCodes(owner, id)).toEqual(["posting_discovered", "posting_closed", "posting_reopened"]);
	});

	it("dates a new posting by first sight only under continuous polling", async () => {
		const owner = await newUser();
		const boardId = await watch(owner, "figma");
		const undated = (keep: number) =>
			listingRoute("figma", (jobs) => jobs.slice(0, keep).map((job) => ({ ...job, first_published: null })));
		await poll(owner, boardId, { greenhouse: greenhouseOver(undated(2)) }, at(0));
		await poll(owner, boardId, { greenhouse: greenhouseOver(undated(3)) }, at(2));
		const ages = (await listOpportunities(database.db, owner)).map((o) => o.postedAt?.toISOString() ?? null);
		// The first import is never "new"; the one that appeared under continuous polling is dated by first sight.
		expect(ages.sort()).toEqual([at(2).toISOString(), null, null]);
	});

	it("records a failing Board as Board health, and gone only after 3 NOT_FOUNDs over 24 h", async () => {
		const owner = await newUser();
		const boardId = await watch(owner, "figma");
		await poll(owner, boardId, { greenhouse: greenhouseOver(boardRoutes("figma")) }, at(0));
		const notFound = { greenhouse: greenhouseOver(new Map([[boardFixture("figma").url, { status: 404 }]])) };
		const outcomes = [];
		for (const hours of [2, 4, 6, 26]) outcomes.push((await poll(owner, boardId, notFound, at(hours))).outcome);
		expect(outcomes.map((o) => o?.status === "FAILED" && o.gone)).toEqual([false, false, false, true]);
		const [health] = await listWatchedBoards(database.db, owner);
		expect(health).toMatchObject({ lastFailure: "NOT_FOUND", consecutiveFailures: 4, goneAt: at(26) });
		// Its Opportunities stay as they were; a gone Board is no longer due or polled.
		expect((await listOpportunities(database.db, owner)).map((o) => o.status)).toEqual(["OPEN", "OPEN", "OPEN"]);
		expect(await dueBoards(database.db, owner, at(100))).toEqual([]);
		expect(await discover(database.db, notFound, owner, boardId)).toBeNull();
	});

	it("schedules the next poll about 2 h out, and never polls another User's Board", async () => {
		const owner = await newUser();
		const other = await newUser();
		const boardId = await watch(owner, "figma");
		expect(await dueBoards(database.db, owner, at(0))).toEqual([boardId]);
		await poll(owner, boardId, { greenhouse: greenhouseOver(boardRoutes("figma")) }, at(0));
		expect(await dueBoards(database.db, owner, at(1.9))).toEqual([]);
		expect(await dueBoards(database.db, owner, at(2))).toEqual([boardId]);
		expect(await discover(database.db, {}, other, boardId)).toBeNull();
		const posting = await greenhouseOver(boardRoutes("figma")).listBoard({ source: "greenhouse", token: "figma" });
		if ("failure" in posting) throw new Error("listing failed");
		const first = posting.postings[0];
		if (!first) throw new Error("empty listing");
		expect(await ingest(database.db, storage, other, boardId, first, { continuous: false })).toBeNull();
	});
});
