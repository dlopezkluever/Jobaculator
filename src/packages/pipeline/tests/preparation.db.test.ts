import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateAiSettings } from "../../ai/index";
import { createScriptedLlm, llmFailure, type ScriptStep } from "../../ai/testing";
import { APPLICATION_SUBJECT, getApplication, getPackage } from "../../applications/index";
import { createCandidate, type Fact, getKnowledgeBase, proposeFacts } from "../../candidate/index";
import type { UserId } from "../../db/ownership";
import { createTestDatabase, newUserId, type TestDatabase } from "../../db/testing";
import {
	type Adapters,
	getOpportunity,
	ingest,
	listWatchedBoards,
	type SourceAdapter,
	type SourcePosting,
	watchBoards,
} from "../../discovery/index";
import { listEvents } from "../../events/index";
import { createHunt } from "../../hunts/index";
import { createJobs, type Jobs } from "../../jobs/index";
import { createLogger } from "../../log/index";
import { listMatches, requestEvaluations } from "../../matching/index";
import { createStorage, type Storage } from "../../storage/index";
import {
	createApplicationPipeline,
	createMatchingPipeline,
	createPreparationPipeline,
	PIPELINE_QUEUES,
	PREPARE_SUSPEND_AFTER,
} from "../index";

const log = createLogger({ level: "fatal" });

let database: TestDatabase;
let jobs: Jobs;
let storage: Storage;
beforeAll(async () => {
	database = await createTestDatabase();
	jobs = createJobs({ databaseUrl: database.url, queues: PIPELINE_QUEUES });
	await jobs.start();
	storage = createStorage(mkdtempSync(join(tmpdir(), "blobs-")));
});
afterAll(async () => {
	await jobs.stop({ timeoutMs: 1000 });
	await database.close();
});

/** Lazy enrichment's detail fetch: the listing had no description, the posting's detail does. */
const detailFetches: string[] = [];
const greenhouse: SourceAdapter = {
	source: "greenhouse",
	resolveBoard: () => null,
	listBoard: async () => ({ failure: "TRANSIENT", detail: "not used" }),
	fetchPosting: async (ref) => {
		detailFetches.push(ref.nativeId);
		return { ...posting(ref.nativeId, "Platform Engineer"), descriptionHtml: "<p>Build <b>platforms</b>.</p>" };
	},
};
const adapters: Adapters = { greenhouse };

function posting(nativeId: string, title: string, descriptionHtml: string | null = null): SourcePosting {
	return {
		source: "greenhouse",
		boardToken: "acme",
		nativeId,
		requisitionId: null,
		url: `https://job-boards.greenhouse.io/acme/jobs/${nativeId}`,
		applyUrl: `https://job-boards.greenhouse.io/acme/jobs/${nativeId}`,
		title,
		employerName: null,
		locationText: "Remote",
		workplaceType: null,
		employmentType: null,
		salary: null,
		firstPublishedAt: null,
		descriptionHtml,
		listed: true,
		raw: {},
	};
}

/** A fixture Candidate (§18): contact identity, one role, one education, one skill. */
async function newCandidate() {
	const owner = newUserId() as UserId;
	await database.db.execute(
		sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
	);
	await createCandidate(database.db, owner);
	const role = { ref: "acme", kind: "role" as const };
	const school = { ref: "ut", kind: "education" as const };
	await proposeFacts(database.db, owner, { kind: "candidate", via: "profile_editor" }, [
		{ kind: "name", value: "Ada Lovelace" },
		{ kind: "email", value: "ada@example.com" },
		{ kind: "skill", value: "TypeScript" },
		{ kind: "employer", value: "Analytical Engines Ltd", entry: role },
		{ kind: "title", value: "Staff Engineer", entry: role },
		{ kind: "start_date", value: "2021-03", entry: role },
		{ kind: "end_date", value: "present", entry: role },
		{ kind: "accomplishment", value: "Cut model spend 38% with an LLM gateway", entry: role },
		{ kind: "institution", value: "University of London", entry: school },
		{ kind: "degree", value: "B.Sc. Mathematics", entry: school },
	]);
	await watchBoards(database.db, owner, [{ source: "greenhouse", token: "acme", employer: "Acme" }], "SEED");
	const [board] = await listWatchedBoards(database.db, owner);
	if (!board) throw new Error("no Board");
	const kb = await getKnowledgeBase(database.db, owner);
	const all = [...kb.facts, ...kb.entries.flatMap((e) => e.facts)];
	const factOf = (kind: string): Fact => {
		const found = all.find((f) => f.kind === kind);
		if (!found) throw new Error(`no ${kind} Fact`);
		return found;
	};
	return { owner, boardId: board.id, factOf };
}

let nativeId = 5000;
/** A posting a Hunt wants, decided and dispatched to `prepare`, as the pipeline would. */
async function queuedApplication(user: { owner: UserId; boardId: string }, descriptionHtml: string | null) {
	const id = String(nativeId++);
	// Discovered without a description, so evaluating it needs no extraction call.
	const ingested = await ingest(database.db, storage, user.owner, user.boardId, posting(id, "Platform Engineer"), {
		continuous: false,
	});
	if (!ingested) throw new Error("not ingested");
	const hunt = await createHunt(database.db, user.owner, {
		name: "Platform",
		criteria: {
			roles: { ideal: ["Platform"], good: [], acceptable: [], unacceptable: [], anythingElseUnacceptable: false },
			locations: { ideal: [], good: [], acceptable: [], unacceptable: [], anythingElseUnacceptable: false },
			payFloor: null,
			experienceStretch: null,
		},
	});
	await database.db.transaction((tx) => requestEvaluations(tx, user.owner, ingested.opportunityId, [hunt.id]));
	const matching = createMatchingPipeline({ db: database.db, jobs, llm: createScriptedLlm([]), log });
	for (const m of await listMatches(database.db, user.owner, [ingested.opportunityId])) {
		await matching.runEvaluate(user.owner, m.id);
	}
	const applications = createApplicationPipeline({ db: database.db, jobs, log, readyBacklog: 100 });
	const applicationId = await applications.runDecide(user.owner, ingested.opportunityId, false);
	if (!applicationId) throw new Error("no Application");
	if (descriptionHtml) {
		// The listing now states the description (a changed posting), before preparation starts.
		await ingest(database.db, storage, user.owner, user.boardId, posting(id, "Platform Engineer", descriptionHtml), {
			continuous: false,
		});
	}
	expect((await getApplication(database.db, user.owner, applicationId))?.preparationDispatchedAt).not.toBeNull();
	return { applicationId, opportunityId: ingested.opportunityId, nativeId: id };
}

const prepare = (script: ScriptStep[]) => {
	const llm = createScriptedLlm(script);
	return { llm, pipeline: createPreparationPipeline({ db: database.db, jobs, llm, storage, adapters, log }) };
};

const strategyStep = (factIds: string[]): ScriptStep => ({
	task: "strategy",
	output: {
		themes: [{ theme: "Cost-aware LLM platforms", why: "The posting leads with it" }],
		selectedFactIds: { summary: factIds, experience: factIds, projects: [], skills: [], coverLetter: [] },
		keywords: [
			{ keyword: "LLM gateway", factIds, transferable: false, rationale: null },
			{ keyword: "Kubernetes", factIds: ["not-a-fact"], transferable: false, rationale: null },
		],
		framings: [],
		leadAngle: "Platform engineer who cut model spend",
		coverLetterAngle: "Cost discipline at scale",
	},
});

const codes = async (owner: UserId, applicationId: string) =>
	(await listEvents(database.db, owner, { type: APPLICATION_SUBJECT, id: applicationId })).map((e) => e.code);

describe("prepare", () => {
	it("captures the Job Snapshot, then the Strategy, then a resume whose authoritative fields come from the Facts", async () => {
		const user = await newCandidate();
		const {
			applicationId,
			opportunityId,
			nativeId: id,
		} = await queuedApplication(user, "<p>Run our LLM platform.</p>");
		const other = await newCandidate();
		const accomplishment = user.factOf("accomplishment").id;
		const roleEntry = user.factOf("employer").entryId;
		const { llm, pipeline } = prepare([
			strategyStep([accomplishment]),
			{
				task: "write",
				output: {
					summary: { text: "Staff engineer who cut LLM spend by 38%.", cites: [accomplishment] },
					skills: [{ group: "Languages", items: [{ text: "TypeScript", cites: [user.factOf("skill").id] }] }],
					entries: [
						{
							entryId: roleEntry,
							// Not part of the schema: the model cannot write an employer, so this is ignored.
							employer: "Google",
							bullets: [
								{ text: "Cut model spend 38% with a TypeScript LLM gateway.", cites: [accomplishment], priority: 1 },
								// Citation integrity: another Candidate's Fact is not this Candidate's evidence.
								{ text: "Led a team of 40.", cites: [other.factOf("accomplishment").id], priority: 2 },
							],
						},
					],
				},
			},
		]);

		await pipeline.runPrepare(user.owner, applicationId);
		expect(llm.remaining()).toBe(0);
		// The prompts carry the posting and this Candidate's Facts, and every call names the Application.
		expect(llm.calls.map((c) => c.method === "generate" && c.request.attribution.applicationId)).toEqual([
			applicationId,
			applicationId,
		]);

		const pkg = await getPackage(database.db, user.owner, applicationId);
		expect(pkg?.jobSnapshot).toMatchObject({
			opportunityId,
			nativeId: id,
			title: "Platform Engineer",
			employerName: "Acme",
			descriptionMarkdown: "Run our LLM platform.",
			enriched: false,
		});
		// A writing plan, with ids that are not the Candidate's removed.
		expect(pkg?.strategy?.keywords.map((k) => k.keyword)).toEqual(["LLM gateway"]);
		expect(pkg?.strategy?.latitude).toBe("AGGRESSIVE");
		expect(pkg?.resume?.identity).toMatchObject({ name: "Ada Lovelace", email: "ada@example.com" });
		expect(pkg?.resume?.experience).toEqual([
			{
				entryId: roleEntry,
				employer: "Analytical Engines Ltd",
				title: "Staff Engineer",
				location: null,
				start: "Mar 2021",
				end: "Present",
				bullets: [{ text: "Cut model spend 38% with a TypeScript LLM gateway.", cites: [accomplishment], priority: 1 }],
			},
		]);
		expect(pkg?.resume?.education).toMatchObject([{ school: "University of London", degree: "B.Sc. Mathematics" }]);
		expect(pkg?.resumeTemplate).toBe("modern");
		expect(pkg?.resumePages).toBe(1);
		const pdf = await storage.get(pkg?.resumePdf ?? ("" as never));
		expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
		expect(await codes(user.owner, applicationId)).toEqual([
			"application_created",
			"job_snapshot_captured",
			"strategy_written",
			"resume_written",
		]);
		const events = await listEvents(database.db, user.owner, { type: APPLICATION_SUBJECT, id: applicationId });
		expect(events.at(-1)?.payload).toMatchObject({ droppedClaims: 1, trimmedBullets: 0, pages: 1 });

		// A repeated job skips every checkpoint: no model call, nothing rewritten.
		const again = prepare([]);
		await again.pipeline.runPrepare(user.owner, applicationId);
		expect(again.llm.calls).toHaveLength(0);
		expect(await getPackage(database.db, user.owner, applicationId)).toEqual(pkg);

		// The posting changes later: the Job Snapshot keeps what it read.
		await ingest(database.db, storage, user.owner, user.boardId, posting(id, "Principal Engineer", "<p>Other.</p>"), {
			continuous: false,
		});
		expect((await getOpportunity(database.db, user.owner, opportunityId))?.title).toBe("Principal Engineer");
		expect((await getPackage(database.db, user.owner, applicationId))?.jobSnapshot).toEqual(pkg?.jobSnapshot);
		// The Application stays PREPARING: answers (TB1-12) take it to READY.
		expect((await getApplication(database.db, user.owner, applicationId))?.status).toBe("PREPARING");
	});

	it("keeps progress through repeated AI failures, suspends paid retries, and resumes when the AI setup changes", async () => {
		const user = await newCandidate();
		const { applicationId, opportunityId, nativeId: id } = await queuedApplication(user, null);
		const failure = () => ({ error: llmFailure("strategy", "deterministic", "none", "schema_violation") });

		for (let attempt = 1; attempt <= PREPARE_SUSPEND_AFTER; attempt++) {
			const { pipeline } = prepare([failure()]);
			await pipeline.runPrepare(user.owner, applicationId);
		}
		// The Job Snapshot was taken before the first failure, through a detail fetch, and kept.
		expect(detailFetches).toEqual([id]);
		const pkg = await getPackage(database.db, user.owner, applicationId);
		expect(pkg?.jobSnapshot).toMatchObject({ descriptionMarkdown: "Build **platforms**.", enriched: true });
		expect((await getOpportunity(database.db, user.owner, opportunityId))?.descriptionMarkdown).toBeNull();
		expect(pkg?.strategy).toBeNull();
		expect(pkg?.suspendedAt).not.toBeNull();
		expect(pkg?.failure).toMatchObject({ errorClass: "schema_violation", count: PREPARE_SUSPEND_AFTER });
		// Still PREPARING: an AI failure never becomes an Intervention.
		expect((await getApplication(database.db, user.owner, applicationId))?.status).toBe("PREPARING");
		expect((await codes(user.owner, applicationId)).filter((c) => c === "preparation_suspended")).toHaveLength(1);
		// The first two failures each scheduled a retry; the third did not.
		const retries = await database.db.execute<{ n: number }>(
			sql`select count(*)::int as n from pgboss.job where name = 'prepare' and data->>'applicationId' = ${applicationId} and start_after > created_on`,
		);
		expect(retries.rows[0]?.n).toBe(2);

		// Suspended: a nudge spends nothing.
		const idle = prepare([]);
		await idle.pipeline.runPrepare(user.owner, applicationId);
		expect(idle.llm.calls).toHaveLength(0);

		// The Candidate changes their AI settings: the next nudge goes on from the Strategy.
		await updateAiSettings(database.db, user.owner, { preset: "best" });
		const { llm, pipeline } = prepare([
			strategyStep([user.factOf("accomplishment").id]),
			{ task: "write", output: { summary: null, skills: [], entries: [] } },
		]);
		await pipeline.runPrepare(user.owner, applicationId);
		expect(llm.remaining()).toBe(0);
		const done = await getPackage(database.db, user.owner, applicationId);
		expect(done).toMatchObject({ suspendedAt: null, failure: null, jobSnapshot: pkg?.jobSnapshot });
		expect(done?.resume?.experience.map((e) => e.employer)).toEqual(["Analytical Engines Ltd"]);
		expect(await codes(user.owner, applicationId)).toContain("preparation_resumed");
		expect(detailFetches).toEqual([id]);
	});
});
