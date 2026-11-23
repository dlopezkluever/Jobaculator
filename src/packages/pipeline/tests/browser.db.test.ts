import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScriptedLlm } from "../../ai/testing";
import {
	APPLICATION_SUBJECT,
	beginSubmission,
	countDryRuns,
	countSubmitted,
	countUncertain,
	getApplication,
	getPackage,
	listBrowserRuns,
	listSubmitIntents,
	prepareSubmitIntent,
	requestDryRun,
	setSubmissionMode,
	startBrowserRun,
} from "../../applications/index";
import type { BrowserRunner, RunOutcome, RunRequest } from "../../browser/index";
import { createCandidate, proposeFacts } from "../../candidate/index";
import type { UserId } from "../../db/ownership";
import { createTestDatabase, newUserId, type TestDatabase } from "../../db/testing";
import {
	type Adapters,
	type ApplicationQuestion,
	ingest,
	listWatchedBoards,
	type SourcePosting,
	watchBoards,
} from "../../discovery/index";
import { listEvents } from "../../events/index";
import { listActiveHolds } from "../../holds/index";
import { createHunt } from "../../hunts/index";
import { createJobs, type Jobs } from "../../jobs/index";
import { createMemoryJournal } from "../../journal/testing";
import { LiveRefused, type RecoveryMarker, recordLaunchStep } from "../../launch/index";
import { createLogger } from "../../log/index";
import { createStorage, type Storage } from "../../storage/index";
import { browserRunQueue, createBrowserPipeline } from "../browser";
import { createApplicationPipeline, createPreparationPipeline, PIPELINE_QUEUES } from "../index";

// `browser_run` (§5, §10) through the pipeline, with a stand-in for the browser: the real
// Greenhouse adapter is tested against recorded forms in `browser/tests`.

const log = createLogger({ level: "fatal" });
let database: TestDatabase;
let jobs: Jobs;
let storage: Storage;
beforeAll(async () => {
	database = await createTestDatabase();
	jobs = createJobs({ databaseUrl: database.url, queues: [...PIPELINE_QUEUES, browserRunQueue] });
	await jobs.start();
	storage = createStorage(mkdtempSync(join(tmpdir(), "blobs-")));
});
afterAll(async () => {
	await jobs.stop({ timeoutMs: 1000 });
	await database.close();
});

const EMAIL: ApplicationQuestion = {
	id: "email",
	label: "Email",
	description: null,
	required: true,
	type: "text",
	options: [],
	section: "application",
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** A question the public schema lacks and the browser finds on the page. */
const HEARD: ApplicationQuestion = { ...EMAIL, id: "question_9", label: "How did you hear about us?", required: false };

const adapters: Adapters = {
	greenhouse: {
		source: "greenhouse",
		resolveBoard: () => null,
		listBoard: async () => ({ failure: "TRANSIENT", detail: "not used" }),
		fetchPosting: async () => ({ gone: true }),
		fetchQuestions: async () => [EMAIL],
	},
};

let nativeId = 7000;
function posting(id: string): SourcePosting {
	return {
		source: "greenhouse",
		boardToken: "acme",
		nativeId: id,
		requisitionId: null,
		url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
		applyUrl: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
		title: "Platform Engineer",
		employerName: null,
		locationText: "Remote",
		workplaceType: null,
		employmentType: null,
		salary: null,
		firstPublishedAt: null,
		descriptionHtml: "<p>Run our platform.</p>",
		listed: true,
		raw: {},
	};
}

/** A Candidate with one READY Application, prepared as the pipeline would. */
async function readyApplication() {
	const owner = newUserId() as UserId;
	await database.db.execute(
		sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
	);
	await createCandidate(database.db, owner);
	await proposeFacts(database.db, owner, { kind: "candidate", via: "profile_editor" }, [
		{ kind: "name", value: "Ada Lovelace" },
		{ kind: "email", value: "ada@example.com" },
	]);
	await watchBoards(database.db, owner, [{ source: "greenhouse", token: "acme", employer: "Acme" }], "SEED");
	const [board] = await listWatchedBoards(database.db, owner);
	if (!board) throw new Error("no Board");
	const id = String(nativeId++);
	const ingested = await ingest(database.db, storage, owner, board.id, posting(id), { continuous: false });
	if (!ingested) throw new Error("not ingested");
	const hunt = await createHunt(database.db, owner, {
		name: "Platform",
		criteria: {
			roles: { ideal: ["Platform"], good: [], acceptable: [], unacceptable: [], anythingElseUnacceptable: false },
			locations: { ideal: [], good: [], acceptable: [], unacceptable: [], anythingElseUnacceptable: false },
			payFloor: null,
			experienceStretch: null,
		},
	});
	// Decided straight from a settled Match: the matching pipeline is tested elsewhere.
	const [match] = (
		await database.db.execute<{
			id: string;
		}>(sql`insert into match (user_id, hunt_id, opportunity_id, status, fit, decision, reason, dimensions, evaluated_at)
			values (${owner}, ${hunt.id}, ${ingested.opportunityId}, 'QUALIFIED', 90, 'AUTO_APPLY', 'auto_policy', '[]'::jsonb, now()) returning id`)
	).rows;
	if (!match) throw new Error("no Match");
	const applications = createApplicationPipeline({ db: database.db, jobs, log, readyBacklog: 100 });
	const applicationId = await applications.runDecide(owner, ingested.opportunityId, true);
	if (!applicationId) throw new Error("no Application");
	const llm = createScriptedLlm([
		{
			task: "strategy",
			output: {
				themes: [],
				selectedFactIds: { summary: [], experience: [], projects: [], skills: [], coverLetter: [] },
				keywords: [],
				framings: [],
				leadAngle: "Platform engineer",
				coverLetterAngle: "Platforms",
			},
		},
		{ task: "write", output: { summary: null, skills: [], entries: [] } },
	]);
	await createPreparationPipeline({ db: database.db, jobs, llm, storage, adapters, log }).runPrepare(
		owner,
		applicationId,
	);
	expect((await getApplication(database.db, owner, applicationId))?.status).toBe("READY");
	return { owner, applicationId };
}

/** Stands in for Chromium: does what `act` says with the run's request, then reports a finished Dry Run. */
function fakeRunner(act: (request: RunRequest) => Promise<void> = async () => {}) {
	const requests: RunRequest[] = [];
	const runner: BrowserRunner = {
		async run(request) {
			requests.push(request);
			await act(request);
			return { kind: "dry_run_complete", url: request.url, fields: [] };
		},
		close: async () => {},
	};
	return { runner, requests };
}

const journal = createMemoryJournal();
const marker: RecoveryMarker & { restoring: boolean } = {
	restoring: false,
	present: async () => marker.restoring,
};

const pipeline = (runner: BrowserRunner, script: Parameters<typeof createScriptedLlm>[0] = [], workerId = "worker-a") =>
	createBrowserPipeline({
		db: database.db,
		jobs,
		llm: createScriptedLlm(script),
		storage,
		adapters,
		runner,
		journal,
		marker,
		log,
		workerId,
	});

const CONFIRMATION = {
	text: "Thank you for applying. Your application has been received.",
	url: "https://job-boards.greenhouse.io/acme/jobs/1/confirmation",
	at: "2026-11-23T10:00:00.000Z",
	screenshot: null,
	applicationId: null,
};

/**
 * Stands in for Chromium on a live run: crosses the run's real SubmitGate, as the driver does
 * before its final click, then reports what the page showed afterwards.
 */
function liveRunner(after: "confirmed" | "no_confirmation") {
	const requests: RunRequest[] = [];
	const runner: BrowserRunner = {
		async run(request): Promise<RunOutcome> {
			requests.push(request);
			expect(request.mode).toBe("live");
			if (!(await request.gate.cross([]))) return { kind: "aborted", reason: "submit refused", url: null, fields: [] };
			return after === "confirmed"
				? { kind: "submitted", confirmation: CONFIRMATION, url: CONFIRMATION.url, fields: [] }
				: { kind: "submit_unknown", detail: "no confirmation page", url: null, fields: [] };
		},
		close: async () => {},
	};
	return { runner, requests };
}

/** A READY Application whose Candidate submits live. */
async function liveApplication() {
	const ready = await readyApplication();
	await setSubmissionMode(database.db, ready.owner, "LIVE");
	return ready;
}

const status = async (owner: UserId, id: string) => (await getApplication(database.db, owner, id))?.status;

/** The QUEUED run's job the dispatcher sent for an Application. */
async function queuedRun(applicationId: string) {
	const rows = await database.db.execute<{ user_id: UserId; id: string }>(
		sql`select user_id, id from browser_run where application_id = ${applicationId} and status = 'QUEUED'`,
	);
	const row = rows.rows[0];
	if (!row) throw new Error("no QUEUED run");
	return { owner: row.user_id, browserRunId: row.id };
}

describe("browser_run", () => {
	it("Dry Runs a READY Application once, with its resume and mid-run answers, and leaves it READY with the evidence", async () => {
		const { owner, applicationId } = await readyApplication();
		const { runner, requests } = fakeRunner(async (request) => {
			const resume = request.package.documents.resume;
			expect(
				readFileSync(resume?.path ?? "")
					.subarray(0, 5)
					.toString(),
			).toBe("%PDF-");
			// The page asks something the Package has no answer for; a later run finds it answered.
			if (!request.package.answers.some((a) => a.question.id === HEARD.id)) {
				const [generated] = await request.package.generateMissing([HEARD]);
				expect(generated?.text).toBe("A job board");
			}
			await request.events.record({ type: "stopped_before_submit" });
			const ref = await request.events.evidence("Form filled", PNG);
			await request.events.record({ type: "screenshot", label: "Form filled", ref });
		});
		const browser = pipeline(runner, [
			{
				task: "answer",
				output: {
					answers: [{ questionId: "question_9", class: "PREFERENCE", text: "A job board", choices: [], cites: [] }],
				},
			},
		]);

		expect(await browser.dispatch()).toBe(1);
		expect((await getApplication(database.db, owner, applicationId))?.status).toBe("APPLYING");
		const { browserRunId } = await queuedRun(applicationId);
		await browser.runBrowser(owner, browserRunId);

		const [request] = requests;
		expect(request?.mode).toBe("dry");
		expect(request?.url).toMatch(/job-boards\.greenhouse\.io\/acme\/jobs\//);
		// The resume uploads under the Candidate's name, from a copy of the Package's PDF.
		expect(request?.package.documents.resume?.filename).toBe("Ada Lovelace Resume.pdf");
		expect(request?.package.schema).toEqual([EMAIL]);

		expect((await getApplication(database.db, owner, applicationId))?.status).toBe("READY");
		const [run] = await listBrowserRuns(database.db, owner, applicationId);
		expect(run).toMatchObject({ mode: "dry", status: "COMPLETED", failure: null });
		expect(run?.events.map((e) => e.type)).toEqual(["stopped_before_submit", "screenshot"]);
		const shot = run?.events[1];
		const stored = await storage.get((shot?.type === "screenshot" ? shot.ref : "") as never);
		expect(stored.equals(PNG)).toBe(true);
		// The mid-run answer is saved onto the Package, after the answers it had.
		const pkg = await getPackage(database.db, owner, applicationId);
		expect(pkg?.answers?.map((a) => a.question.id)).toEqual(["email", "question_9"]);
		const codes = (await listEvents(database.db, owner, { type: APPLICATION_SUBJECT, id: applicationId })).map(
			(e) => e.code,
		);
		expect(codes.slice(-5)).toEqual([
			"application_status_changed",
			"browser_run_queued",
			"answers_added",
			"application_status_changed",
			"browser_run_finished",
		]);
		expect(await countDryRuns(database.db, owner)).toBe(1);

		// Not dispatched again while dry, and a repeated job delivery runs nothing.
		expect(await browser.dispatch()).toBe(0);
		await browser.runBrowser(owner, browserRunId);
		expect(requests).toHaveLength(1);

		// The Candidate asks for another Dry Run: it runs.
		await requestDryRun(database.db, owner, applicationId);
		expect(await browser.dispatch()).toBe(1);
		await browser.runBrowser(owner, (await queuedRun(applicationId)).browserRunId);
		expect(await countDryRuns(database.db, owner)).toBe(2);
		expect(await browser.dispatch()).toBe(0);
	});

	it("runs one Application at a time on the one browser, the highest Opportunity Value first", async () => {
		const first = await readyApplication();
		const second = await readyApplication();
		await database.db.execute(sql`update application set fit = 95 where id = ${second.applicationId}`);
		const { runner } = fakeRunner();
		const browser = pipeline(runner);
		expect(await browser.dispatch()).toBe(1);
		expect((await getApplication(database.db, second.owner, second.applicationId))?.status).toBe("APPLYING");
		expect((await getApplication(database.db, first.owner, first.applicationId))?.status).toBe("READY");
		// A finished run frees the browser and dispatches the next one at once.
		await browser.runBrowser(second.owner, (await queuedRun(second.applicationId)).browserRunId);
		expect((await getApplication(database.db, first.owner, first.applicationId))?.status).toBe("APPLYING");
		await browser.runBrowser(first.owner, (await queuedRun(first.applicationId)).browserRunId);
		expect(await browser.dispatch()).toBe(0);
	});

	it("reclaims a run whose worker ended, using no attempt, and Dry Runs it again", async () => {
		const { owner, applicationId } = await readyApplication();
		const { runner, requests } = fakeRunner();
		const browser = pipeline(runner, [], "worker-new");
		expect(await browser.dispatch()).toBe(1);
		const { browserRunId } = await queuedRun(applicationId);
		// A worker that has since been replaced had taken it.
		expect(await startBrowserRun(database.db, owner, browserRunId, "worker-old")).not.toBeNull();
		await browser.runBrowser(owner, browserRunId);
		expect(requests).toHaveLength(0);

		expect(await browser.sweep()).toEqual({ reclaimed: 1, nudged: 0 });
		expect((await getApplication(database.db, owner, applicationId))?.status).toBe("READY");
		expect((await listBrowserRuns(database.db, owner, applicationId))[0]?.status).toBe("ABORTED");
		expect(await countDryRuns(database.db, owner)).toBe(0);
		// An aborted run is not a finished Dry Run, so the Application is dispatched again.
		expect(await browser.dispatch()).toBe(1);
		await browser.runBrowser(owner, (await queuedRun(applicationId)).browserRunId);
		expect(requests).toHaveLength(1);
	});

	it("keeps Live refused until the launch gate: globally and on a Hunt", async () => {
		const { owner } = await readyApplication();
		await expect(setSubmissionMode(database.db, owner, "LIVE")).rejects.toBeInstanceOf(LiveRefused);
		await expect(
			createHunt(database.db, owner, {
				name: "Live",
				submissionMode: "LIVE",
				criteria: {
					roles: { ideal: ["x"], good: [], acceptable: [], unacceptable: [], anythingElseUnacceptable: false },
					locations: { ideal: [], good: [], acceptable: [], unacceptable: [], anythingElseUnacceptable: false },
					payFloor: null,
					experienceStretch: null,
				},
			}),
		).rejects.toThrow(/launch gate/);
		await setSubmissionMode(database.db, owner, "DRY_RUN");
	});
});

// The launch gate is system-wide: these run after the refusal above, with it open.
describe("SubmitGate through the production path", () => {
	beforeAll(async () => {
		// Earlier tests leave READY Dry Run Applications; the one browser is for these scenarios.
		await database.db.execute(sql`update application set status = 'ABANDONED' where status = 'READY'`);
		await recordLaunchStep(database.db, "restore_drill_passed");
		await recordLaunchStep(database.db, "journal_activated");
	});

	it("submits a confirmed Application once: journal entry, intent row, SUBMITTED, counted; a repeated job submits nothing", async () => {
		const { owner, applicationId } = await liveApplication();
		const { runner, requests } = liveRunner("confirmed");
		const browser = pipeline(runner);
		expect(await browser.dispatch()).toBe(1);
		const { browserRunId } = await queuedRun(applicationId);
		await browser.runBrowser(owner, browserRunId);

		expect(await status(owner, applicationId)).toBe("SUBMITTED");
		const [intent] = await listSubmitIntents(database.db, owner, applicationId);
		expect(intent).toMatchObject({ browserRunId, status: "SUBMITTED", confirmation: CONFIRMATION });
		// Journaled under the same intent id, before the row existed.
		expect(journal.entries.get(intent?.id ?? "")).toMatchObject({ applicationId, browserRunId, mode: "live" });
		expect(await countSubmitted(database.db, owner, "UTC")).toEqual({ today: 1, week: 1, allTime: 1 });
		// The Package revision was frozen with the answers it submitted.
		const [row] = (
			await database.db.execute<{ revision: { answers: { question: { id: string } }[] } }>(
				sql`select revision from submit_intent where id = ${intent?.id}`,
			)
		).rows;
		expect(row?.revision.answers.map((a) => a.question.id)).toEqual(["email"]);
		const codes = (await listEvents(database.db, owner, { type: APPLICATION_SUBJECT, id: applicationId })).map(
			(e) => e.code,
		);
		expect(codes.slice(-5)).toEqual([
			"application_status_changed",
			"submit_boundary_crossed",
			"application_status_changed",
			"submission_confirmed",
			"browser_run_finished",
		]);

		// The job delivered again, and the dispatcher, find nothing to do: no second submission.
		await browser.runBrowser(owner, browserRunId);
		expect(await browser.dispatch()).toBe(0);
		expect(requests).toHaveLength(1);
		expect(journal.entries.size).toBe(1);
		expect(await listSubmitIntents(database.db, owner, applicationId)).toHaveLength(1);
	});

	it("records an Uncertain Submission when no confirmation is seen, and never submits it again", async () => {
		const { owner, applicationId } = await liveApplication();
		const { runner, requests } = liveRunner("no_confirmation");
		const browser = pipeline(runner);
		expect(await browser.dispatch()).toBe(1);
		const { browserRunId } = await queuedRun(applicationId);
		await browser.runBrowser(owner, browserRunId);

		expect(await status(owner, applicationId)).toBe("SUBMIT_UNKNOWN");
		const [intent] = await listSubmitIntents(database.db, owner, applicationId);
		expect(intent).toMatchObject({ browserRunId, status: "UNKNOWN", confirmation: null });
		expect(journal.entries.has(intent?.id ?? "")).toBe(true);
		const interventions = await database.db.execute<{ kind: string }>(
			sql`select kind from intervention where application_id = ${applicationId}`,
		);
		expect(interventions.rows).toEqual([{ kind: "SUBMIT_UNKNOWN" }]);
		expect(await countSubmitted(database.db, owner, "UTC")).toEqual({ today: 0, week: 0, allTime: 0 });
		expect(await countUncertain(database.db, owner)).toBe(1);

		await browser.runBrowser(owner, browserRunId);
		expect(await browser.dispatch()).toBe(0);
		await browser.sweep();
		expect(await browser.dispatch()).toBe(0);
		expect(requests).toHaveLength(1);
	});

	it("makes a run lost after the boundary uncertain, never READY again", async () => {
		const { owner, applicationId } = await liveApplication();
		const browser = pipeline(liveRunner("confirmed").runner, [], "worker-new");
		expect(await browser.dispatch()).toBe(1);
		const { browserRunId } = await queuedRun(applicationId);
		// A worker that has since ended crossed the boundary, then died before recording the outcome.
		await startBrowserRun(database.db, owner, browserRunId, "worker-old");
		const intent = await prepareSubmitIntent(database.db, owner, browserRunId, "worker-old");
		if (!intent) throw new Error("no intent");
		await journal.write({
			intentId: intent.intentId,
			userId: owner,
			applicationId,
			opportunityId: intent.opportunityId,
			browserRunId,
			posting: { source: "greenhouse", boardToken: "acme", nativeId: "1", dedupKey: intent.dedupKey },
			applyUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
			mode: "live",
			at: new Date().toISOString(),
		});
		const crossed = await database.db.transaction((tx) =>
			beginSubmission(tx, owner, {
				browserRunId,
				workerId: "worker-old",
				intentId: intent.intentId,
				files: [],
				fields: [],
			}),
		);
		expect(crossed).toBe(true);
		expect(await status(owner, applicationId)).toBe("SUBMITTING");

		expect((await browser.sweep()).reclaimed).toBe(1);
		expect(await status(owner, applicationId)).toBe("SUBMIT_UNKNOWN");
		expect((await listSubmitIntents(database.db, owner, applicationId))[0]?.status).toBe("UNKNOWN");
		expect(await browser.dispatch()).toBe(0);
	});

	it("stays before the boundary when the journal cannot be written: a journal Hold, no intent, no attempt; lifted, it submits", async () => {
		const { owner, applicationId } = await liveApplication();
		const { runner, requests } = liveRunner("confirmed");
		const browser = pipeline(runner);
		journal.failing = true;
		try {
			expect(await browser.dispatch()).toBe(1);
			await browser.runBrowser(owner, (await queuedRun(applicationId)).browserRunId);
			expect(await status(owner, applicationId)).toBe("READY");
			expect(await listSubmitIntents(database.db, owner, applicationId)).toEqual([]);
			expect((await listActiveHolds(database.db, owner)).map((h) => h.scope)).toEqual(["journal"]);
			expect((await listBrowserRuns(database.db, owner, applicationId))[0]?.status).toBe("ABORTED");
			// Held: its live runs wait.
			expect(await browser.dispatch()).toBe(0);
			await browser.sweep();
			expect(await listActiveHolds(database.db, owner)).toHaveLength(1);
		} finally {
			journal.failing = false;
		}
		// The probe finds the journal again and lifts the Hold.
		await browser.sweep();
		expect(await listActiveHolds(database.db, owner)).toEqual([]);
		expect(await browser.dispatch()).toBe(1);
		await browser.runBrowser(owner, (await queuedRun(applicationId)).browserRunId);
		expect(await status(owner, applicationId)).toBe("SUBMITTED");
		expect(requests).toHaveLength(2);
	});

	it("never submits for the canary User, nor while a recovery marker is in place", async () => {
		const canary = await liveApplication();
		await database.db.execute(sql`update "user" set canary = true where id = ${canary.owner}`);
		const { runner, requests } = liveRunner("confirmed");
		const browser = pipeline(runner);
		expect(await browser.dispatch()).toBe(0);
		await database.db.execute(sql`update "user" set canary = false where id = ${canary.owner}`);

		marker.restoring = true;
		try {
			expect(await browser.dispatch()).toBe(0);
			// A run already dispatched is refused at the boundary itself.
			marker.restoring = false;
			expect(await browser.dispatch()).toBe(1);
			marker.restoring = true;
			await browser.runBrowser(canary.owner, (await queuedRun(canary.applicationId)).browserRunId);
		} finally {
			marker.restoring = false;
		}
		expect(requests).toHaveLength(1);
		expect(await status(canary.owner, canary.applicationId)).toBe("READY");
		expect(await listSubmitIntents(database.db, canary.owner, canary.applicationId)).toEqual([]);
	});
});
