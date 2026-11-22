import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScriptedLlm, type ScriptStep } from "../../ai/testing";
import type { UserId } from "../../db/ownership";
import { assertTwoUserIsolation, createTestDatabase, newUserId, type TestDatabase } from "../../db/testing";
import {
	createGreenhouseAdapter,
	createSourceHttp,
	getOpportunity,
	ingest,
	listWatchedBoards,
	type SourcePosting,
	watchBoards,
} from "../../discovery/index";
import { listEvents } from "../../events/index";
import type { HuntCriteria } from "../../hunts/criteria";
import { createHunt } from "../../hunts/index";
import { createStorage, type Storage } from "../../storage/index";
import { evaluate, getMatch, listMatches, MATCH_SUBJECT, type Match, requestEvaluations } from "../index";

// Real postings from the recorded Figma Board. "AI Engineer, Internal Tools" requires
// "5+ years of software engineering experience" and states no pay; its places are
// "San Francisco, CA • New York, NY • United States".
let database: TestDatabase;
let storage: Storage;
let figma: SourcePosting[];
beforeAll(async () => {
	database = await createTestDatabase();
	storage = createStorage(mkdtempSync(join(tmpdir(), "blobs-")));
	const path = join(import.meta.dirname, "../../discovery/tests/fixtures/greenhouse-figma.json");
	const fixture = JSON.parse(readFileSync(path, "utf8"));
	const adapter = createGreenhouseAdapter(
		createSourceHttp({ fetch: async () => new Response(JSON.stringify(fixture.body)), minIntervalMs: 0 }),
	);
	const listing = await adapter.listBoard({ source: "greenhouse", token: "figma" });
	if (!("postings" in listing)) throw new Error("the fixture did not list");
	figma = listing.postings;
});
afterAll(() => database.close());

const posting = (title: string) => {
	const found = figma.find((p) => p.title.startsWith(title));
	if (!found) throw new Error(`no fixture posting ${title}`);
	return found;
};

const anyRole = { ideal: [], good: [], acceptable: [], unacceptable: [], anythingElseUnacceptable: false };
function criteria(change: Partial<HuntCriteria> = {}): HuntCriteria {
	return {
		roles: { ...anyRole, ideal: ["AI Engineer"], anythingElseUnacceptable: true },
		locations: { ...anyRole },
		payFloor: null,
		experienceStretch: null,
		...change,
	};
}

type Extraction = {
	pay?: {
		min: number | null;
		max: number | null;
		currency: string | null;
		period: string | null;
		quote: string | null;
	};
	seniority?: { value: string | null; quote: string | null };
	workplace?: { value: string | null; quote: string | null };
	requiredYears?: { value: number | null; quote: string | null };
};
const FIVE_YEARS = { value: 5, quote: "5+ years of software engineering experience" };
function extracted(change: Extraction = {}): ScriptStep {
	return {
		task: "extract",
		output: {
			pay: { min: null, max: null, currency: null, period: null, quote: null },
			seniority: { value: null, quote: null },
			workplace: { value: null, quote: null },
			requiredYears: FIVE_YEARS,
			...change,
		},
	};
}

async function newUser(): Promise<UserId> {
	const owner = newUserId();
	await database.db.execute(
		sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
	);
	await watchBoards(database.db, owner, [{ source: "greenhouse", token: "figma", employer: "Figma" }], "SEED");
	return owner;
}

async function ingested(owner: UserId, source: SourcePosting): Promise<string> {
	const [board] = await listWatchedBoards(database.db, owner);
	if (!board) throw new Error("no Board");
	const result = await ingest(database.db, storage, owner, board.id, source, { continuous: false });
	if (!result) throw new Error("not ingested");
	return result.opportunityId;
}

async function pendingMatch(owner: UserId, huntCriteria: HuntCriteria, opportunityId: string) {
	const hunt = await createHunt(database.db, owner, { name: "Hunt", criteria: huntCriteria });
	const [id] = await database.db.transaction((tx) => requestEvaluations(tx, owner, opportunityId, [hunt.id]));
	const pending = id ? await getMatch(database.db, owner, id) : null;
	if (!pending) throw new Error("no Match");
	return pending;
}

/** Evaluates one Hunt's Match of one fixture posting, with the given extraction script. */
async function evaluateOne(options: {
	criteria: HuntCriteria;
	posting: SourcePosting;
	years: number | null;
	script?: ScriptStep[];
}) {
	const owner = await newUser();
	const opportunityId = await ingested(owner, options.posting);
	const pending = await pendingMatch(owner, options.criteria, opportunityId);
	const opportunity = await getOpportunity(database.db, owner, opportunityId);
	if (!opportunity) throw new Error("no Opportunity");
	const llm = createScriptedLlm(options.script ?? []);
	const match = await evaluate({ db: database.db, llm }, owner, pending, {
		criteria: options.criteria,
		opportunity,
		experienceYears: options.years,
	});
	if (!match) throw new Error("not evaluated");
	expect(llm.remaining()).toBe(0);
	const events = await listEvents(database.db, owner, { type: MATCH_SUBJECT, id: match.id });
	return { owner, match, llm, events };
}

const dimension = (match: Match, name: string) => match.dimensions?.find((d) => d.dimension === name);

describe("evaluate", () => {
	it("applies automatically to a qualified, acceptable Match, with unknown pay a neutral Acceptable", async () => {
		const { match, llm, events } = await evaluateOne({
			criteria: criteria({ locations: { ...anyRole, good: ["New York"] }, payFloor: 150_000 }),
			posting: posting("AI Engineer"),
			years: 3,
			script: [extracted()],
		});
		// Role Ideal (100 × 3), best place New York Good (80 × 2), pay unknown Acceptable (60 × 2): 580 / 7.
		expect(match).toMatchObject({ status: "QUALIFIED", qualified: true, fit: 83, decision: "AUTO_APPLY" });
		expect(match.reason).toBe("auto_policy");
		expect(dimension(match, "pay")).toMatchObject({ tier: null, provenance: "unknown", score: 60, excludes: false });
		// 5 required years are within 2 × 3.
		expect(dimension(match, "experience")).toMatchObject({ provenance: "stated", excludes: false });
		expect(llm.calls[0]?.request).toMatchObject({
			task: "extract",
			attribution: { opportunityId: match.opportunityId },
		});

		expect(events.map((e) => e.code)).toEqual(["match_evaluated"]);
		expect(events[0]?.payload).toMatchObject({
			huntId: match.huntId,
			opportunityId: match.opportunityId,
			stage: "full",
			extractionCallId: expect.any(String),
			qualified: true,
			fit: 83,
			decision: "AUTO_APPLY",
			reason: "auto_policy",
		});
	});

	it("skips a role the Hunt excludes on the prefilter, without calling the model", async () => {
		const { match, llm, events } = await evaluateOne({
			criteria: criteria(),
			posting: posting("Compliance Engineer"),
			years: 3,
		});
		expect(match).toMatchObject({ decision: "SKIP", reason: "role_unacceptable", fit: 0 });
		expect(llm.calls).toHaveLength(0);
		expect(events[0]?.payload).toMatchObject({ stage: "prefilter", extractionCallId: null });
	});

	it("skips only when none of the posting's places is acceptable", async () => {
		const elsewhere = await evaluateOne({
			criteria: criteria({ locations: { ...anyRole, ideal: ["London"], anythingElseUnacceptable: true } }),
			posting: posting("AI Engineer"),
			years: 3,
		});
		expect(elsewhere.match).toMatchObject({ decision: "SKIP", reason: "location_unacceptable" });
		expect(elsewhere.llm.calls).toHaveLength(0);

		// New York is excluded, but the job can be taken in San Francisco too.
		const another = await evaluateOne({
			criteria: criteria({ locations: { ...anyRole, unacceptable: ["New York"] } }),
			posting: posting("AI Engineer"),
			years: 3,
			script: [extracted()],
		});
		expect(another.match).toMatchObject({ decision: "AUTO_APPLY", reason: "auto_policy" });
	});

	it("rejects stated pay only when the top of its range is below the floor", async () => {
		const paid = (min: number, max: number) => ({
			...posting("AI Engineer"),
			salary: { min, max, currency: "USD" },
		});
		const below = await evaluateOne({
			criteria: criteria({ payFloor: 150_000 }),
			posting: paid(90_000, 149_000),
			years: 3,
		});
		expect(below.match).toMatchObject({ decision: "SKIP", reason: "pay_below_floor" });
		expect(below.llm.calls).toHaveLength(0);

		const reaching = await evaluateOne({
			criteria: criteria({ payFloor: 150_000 }),
			posting: paid(120_000, 150_000),
			years: 3,
			script: [extracted()],
		});
		expect(reaching.match).toMatchObject({ decision: "AUTO_APPLY", reason: "auto_policy" });
		expect(dimension(reaching.match, "pay")).toMatchObject({ tier: "acceptable", provenance: "stated" });
	});

	it("never excludes on inferred pay alone, but does on pay quoted from the posting", async () => {
		const lowPay = { min: 90_000, max: 120_000, currency: "USD", period: "YEAR" };
		// The model's figures with no quote, or a quote the posting does not contain, are inferences.
		for (const quote of [null, "$90,000 - $120,000 per year"]) {
			const inferred = await evaluateOne({
				criteria: criteria({ payFloor: 150_000 }),
				posting: posting("AI Engineer"),
				years: 3,
				script: [extracted({ pay: { ...lowPay, quote } })],
			});
			expect(inferred.match).toMatchObject({ decision: "AUTO_APPLY", reason: "auto_policy" });
			expect(dimension(inferred.match, "pay")).toMatchObject({
				tier: "unacceptable",
				provenance: "inferred",
				score: 0,
				excludes: false,
			});
		}

		const withPay = posting("AI Engineer");
		const stated = await evaluateOne({
			criteria: criteria({ payFloor: 150_000 }),
			posting: {
				...withPay,
				descriptionHtml: `${withPay.descriptionHtml}<p>The base salary range is $90,000 - $120,000 per year.</p>`,
			},
			// Also beyond the stretch: the Hunt's own exclusion is the one decisive reason.
			years: 1,
			script: [extracted({ pay: { ...lowPay, quote: "$90,000 - $120,000 per year" } })],
		});
		expect(stated.match).toMatchObject({
			status: "DISQUALIFIED",
			decision: "SKIP",
			reason: "pay_below_floor",
		});
		expect(stated.events[0]?.payload).toMatchObject({ stage: "full", reason: "pay_below_floor", qualified: false });
	});

	it("disqualifies required years beyond the stretch, with the Hunt's override, but not inferred years", async () => {
		const run = (years: number | null, experienceStretch: number | null, requiredYears = FIVE_YEARS) =>
			evaluateOne({
				criteria: criteria({ experienceStretch }),
				posting: posting("AI Engineer"),
				years,
				script: [extracted({ requiredYears })],
			});

		// 5 > 2 × 2.
		expect((await run(2, null)).match).toMatchObject({
			status: "DISQUALIFIED",
			qualified: false,
			decision: "SKIP",
			reason: "experience_beyond_stretch",
		});
		// 5 ≤ 2.5 × 2, and nothing is held against a Candidate whose years are unknown.
		expect((await run(2, 2.5)).match).toMatchObject({ qualified: true, reason: "auto_policy" });
		expect((await run(null, null)).match).toMatchObject({ qualified: true, reason: "auto_policy" });
		// "5 years" read from prose the posting does not contain is an inference.
		expect((await run(1, null, { value: 5, quote: "five years minimum" })).match).toMatchObject({
			qualified: true,
			reason: "auto_policy",
		});
	});

	it("extracts once per posting text and reuses it across Hunts, again after the posting changes", async () => {
		const owner = await newUser();
		const source = posting("AI Engineer");
		const opportunityId = await ingested(owner, source);
		const llm = createScriptedLlm([extracted(), extracted({ requiredYears: { value: 3, quote: null } })]);
		const run = async () => {
			const pending = await pendingMatch(owner, criteria(), opportunityId);
			const opportunity = await getOpportunity(database.db, owner, opportunityId);
			if (!opportunity) throw new Error("no Opportunity");
			return evaluate({ db: database.db, llm }, owner, pending, {
				criteria: criteria(),
				opportunity,
				experienceYears: 3,
			});
		};
		await run();
		await run();
		expect(llm.calls).toHaveLength(1);

		await ingested(owner, { ...source, descriptionHtml: `${source.descriptionHtml}<p>Now hybrid.</p>` });
		const changed = await run();
		expect(llm.remaining()).toBe(0);
		expect(dimension(changed as Match, "experience")).toMatchObject({ provenance: "inferred" });
	});

	it("writes nothing when the Match was asked to evaluate again meanwhile", async () => {
		const owner = await newUser();
		const opportunityId = await ingested(owner, posting("AI Engineer"));
		const stale = await pendingMatch(owner, criteria(), opportunityId);
		await database.db.transaction((tx) => requestEvaluations(tx, owner, opportunityId, [stale.huntId]));
		const opportunity = await getOpportunity(database.db, owner, opportunityId);
		if (!opportunity) throw new Error("no Opportunity");
		const llm = createScriptedLlm([extracted()]);
		const inputs = { criteria: criteria(), opportunity, experienceYears: 3 };
		expect(await evaluate({ db: database.db, llm }, owner, stale, inputs)).toBeNull();
		expect(await listEvents(database.db, owner, { type: MATCH_SUBJECT, id: stale.id })).toEqual([]);
		expect(await getMatch(database.db, owner, stale.id)).toMatchObject({ status: "PENDING", revision: 1 });
	});

	it("keeps each User's Matches to that User", async () => {
		await assertTwoUserIsolation({
			seed: async (owner) => {
				await database.db.execute(
					sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
				);
				await watchBoards(database.db, owner, [{ source: "greenhouse", token: "figma", employer: "Figma" }], "SEED");
				await pendingMatch(owner, criteria(), await ingested(owner, posting("AI Engineer")));
			},
			read: async (owner) => {
				const all = await database.db.execute<{ opportunity_id: string }>(sql`select opportunity_id from match`);
				return listMatches(
					database.db,
					owner,
					all.rows.map((row) => row.opportunity_id),
				);
			},
		});
	});
});
