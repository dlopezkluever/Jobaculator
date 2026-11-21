import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Part } from "../../ai/index";
import { createScriptedLlm, noViableRoute, type ScriptStep } from "../../ai/testing";
import type { UserId } from "../../db/ownership";
import { assertTwoUserIsolation, createTestDatabase, newUserId, type TestDatabase } from "../../db/testing";
import { createJobs, type Jobs } from "../../jobs/index";
import { createStorage, parseBlobHash, type Storage } from "../../storage/index";
import {
	addDocument,
	createCandidate,
	type DocumentUpload,
	EXTRACT_DOCUMENT,
	extractDocument,
	type Fact,
	getKnowledgeBase,
	listDocuments,
	retryDocument,
} from "../index";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name));

let database: TestDatabase;
let storage: Storage;
let jobs: Jobs;
beforeAll(async () => {
	database = await createTestDatabase();
	storage = createStorage(mkdtempSync(join(tmpdir(), "blobs-")));
	jobs = createJobs({ databaseUrl: database.url, queues: [EXTRACT_DOCUMENT] });
	await jobs.start();
});
afterAll(async () => {
	await jobs.stop({ timeoutMs: 1000 });
	await database.close();
});

async function newCandidate(owner: UserId = newUserId()): Promise<UserId> {
	await database.db.execute(
		sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
	);
	await createCandidate(database.db, owner);
	return owner;
}

const upload = (owner: UserId, document: DocumentUpload) =>
	addDocument({ db: database.db, storage, jobs }, owner, document);

/** Runs the extraction job as the worker would, answering the `extract` call with `steps`. */
async function extract(owner: UserId, documentId: string, ...steps: ScriptStep[]) {
	const llm = createScriptedLlm(steps.map((step) => ({ task: "extract", ...step })));
	await extractDocument({ db: database.db, storage, llm }, owner, documentId);
	expect(llm.remaining()).toBe(0);
	return llm.calls.map((call) => (call.method === "generate" ? call.request : null));
}

async function queuedJobs(owner: UserId): Promise<number> {
	const result = await database.db.execute<{ count: number }>(
		sql`select count(*)::int as count from pgboss.job where name = ${EXTRACT_DOCUMENT.name} and data->>'userId' = ${owner}`,
	);
	return result.rows[0]?.count ?? 0;
}

async function allFacts(owner: UserId): Promise<Fact[]> {
	const kb = await getKnowledgeBase(database.db, owner);
	return [...kb.facts, ...kb.entries.flatMap((entry) => entry.facts)];
}

const said = (kind: string, value: string, quote = value) => ({ kind, value, quote, inferred: false });
const inferred = (kind: string, value: string, quote: string) => ({ kind, value, quote, inferred: true });

describe("document upload and extraction", () => {
	it("keeps the PDF, sends it natively, and establishes Authoritative Facts only where its text states them", async () => {
		const owner = await newCandidate();
		const bytes = fixture("resume.pdf");
		const { document, duplicate } = await upload(owner, { filename: "resume.pdf", bytes });
		expect(duplicate).toBe(false);
		expect(document).toMatchObject({ filename: "resume.pdf", format: "pdf", status: "queued", size: bytes.length });
		expect(await queuedJobs(owner)).toBe(1);

		const [request] = await extract(owner, document.id, {
			output: {
				facts: [
					said("name", "Dana Reyes"),
					said("email", "dana.reyes@example.com"),
					said("phone", "(512) 555-0142"),
					// Called explicit, but the document never says it.
					said("work_authorization", "US citizen"),
					said("skill", "Kafka", "TypeScript, PostgreSQL, Kafka"),
					inferred("skill", "Event sourcing", "migration of the billing platform to event sourcing"),
					// An employer belongs on a role, not on the Candidate: dropped, not a failed document.
					said("employer", "Brightwell"),
				],
				entries: [
					{
						key: "brightwell",
						kind: "role",
						parentKey: null,
						facts: [
							said("employer", "Brightwell, Inc."),
							said("title", "Senior Software Engineer"),
							said("start_date", "2021-03", "March 2021"),
							said("end_date", "present", "Present"),
							// Wraps onto a second line in the PDF's text layer.
							said(
								"accomplishment",
								"Led the migration of the billing platform to event sourcing, cutting invoice errors by 38%.",
							),
						],
					},
					{
						key: "ut",
						kind: "education",
						parentKey: null,
						facts: [
							said("institution", "University of Texas at Austin"),
							// The quote is real, but the value rewrites it.
							said("degree", "Bachelor of Science", "B.S. Computer Science"),
							// Not a date the registry accepts: dropped.
							said("end_date", "Spring 2016", "2016"),
						],
					},
					{
						key: "story",
						kind: "story",
						parentKey: "brightwell",
						facts: [inferred("story_title", "Billing migration", "Led the migration of the billing platform")],
					},
				],
			},
		});

		const pdf = ((request?.messages[0]?.content ?? []) as Part[]).find((part) => part.type === "pdf");
		expect(pdf?.type === "pdf" && pdf.data.equals(bytes)).toBe(true);
		expect(request?.attribution).toEqual({ userId: owner });

		const [extracted] = await listDocuments(database.db, owner);
		expect(extracted).toMatchObject({ status: "extracted", factCount: 14, error: null, note: null });
		const [{ blob_hash } = { blob_hash: "" }] = (
			await database.db.execute<{ blob_hash: string }>(
				sql`select blob_hash from candidate_document where id = ${document.id}`,
			)
		).rows;
		expect((await storage.get(parseBlobHash(blob_hash))).equals(bytes)).toBe(true);
		expect((await storage.stat(database.db, parseBlobHash(blob_hash)))?.retentionClass).toBe("permanent");

		const facts = await allFacts(owner);
		const fact = (kind: string, value?: string) =>
			facts.find((f) => f.kind === kind && (value === undefined || f.value === value));
		expect(fact("name")).toMatchObject({ authoritative: true, provenance: "DOCUMENT_EXPLICIT", verified: false });
		expect(fact("name")?.sources).toMatchObject([{ kind: "document", documentId: document.id, inferred: false }]);
		expect(fact("work_authorization")).toMatchObject({ authoritative: false, provenance: "AI_INFERRED" });
		expect(fact("skill", "Kafka")).toMatchObject({ provenance: "DOCUMENT_EXPLICIT" });
		expect(fact("skill", "Event sourcing")?.sources).toMatchObject([
			{ inferred: true, evidence: ["migration of the billing platform to event sourcing"] },
		]);
		expect(fact("employer")).toMatchObject({ value: "Brightwell, Inc.", authoritative: true });
		expect(fact("start_date")).toMatchObject({ value: "2021-03", authoritative: true });
		expect(fact("accomplishment")).toMatchObject({ provenance: "DOCUMENT_EXPLICIT" });
		expect(fact("institution")).toMatchObject({ authoritative: true });
		expect(fact("degree")).toMatchObject({ authoritative: false, provenance: "AI_INFERRED" });
		expect(facts.filter((f) => f.kind === "end_date").map((f) => f.value)).toEqual(["present"]);

		const { entries, facts: aboutCandidate } = await getKnowledgeBase(database.db, owner);
		expect(aboutCandidate.map((f) => f.kind)).not.toContain("employer");
		const role = entries.find((entry) => entry.kind === "role");
		expect(entries.find((entry) => entry.kind === "story")?.parentId).toBe(role?.id);
	});

	it("skips an exact duplicate without a second job or extraction; another Candidate's copy is their own", async () => {
		const owner = await newCandidate();
		const bytes = fixture("resume.pdf");
		const first = await upload(owner, { filename: "resume.pdf", bytes });
		const again = await upload(owner, { filename: "resume (1).pdf", bytes });
		expect(again).toMatchObject({ duplicate: true, document: { id: first.document.id, filename: "resume.pdf" } });
		expect(await listDocuments(database.db, owner)).toHaveLength(1);
		expect(await queuedJobs(owner)).toBe(1);

		// A nudge for a document that has already been extracted does nothing, so it needs no script.
		await extract(owner, first.document.id, { output: { facts: [said("name", "Dana Reyes")], entries: [] } });
		expect(await extract(owner, first.document.id)).toEqual([]);

		const other = await newCandidate();
		expect(await upload(other, { filename: "resume.pdf", bytes })).toMatchObject({ duplicate: false });
	});

	it("converts a DOCX to text first", async () => {
		const owner = await newCandidate();
		const { document } = await upload(owner, { filename: "resume.docx", bytes: fixture("resume.docx") });
		const [request] = await extract(owner, document.id, {
			output: {
				facts: [said("email", "dana.reyes@example.com")],
				entries: [{ key: "p", kind: "project", parentKey: null, facts: [said("project_name", "Ledgerline")] }],
			},
		});
		const parts = (request?.messages[0]?.content ?? []) as Part[];
		expect(parts.some((part) => part.type === "pdf")).toBe(false);
		expect(parts.find((part) => part.type === "text" && part.text.includes("double-entry bookkeeping"))).toBeDefined();
		expect((await allFacts(owner)).map((f) => [f.kind, f.provenance])).toEqual([
			["email", "DOCUMENT_EXPLICIT"],
			["project_name", "DOCUMENT_EXPLICIT"],
		]);
	});

	it("takes pasted text as a document, and keeps nothing from a PDF without a text layer Authoritative", async () => {
		const owner = await newCandidate();
		const pasted = await upload(owner, { pastedText: "  Dana Reyes, Austin TX  " });
		expect(pasted.document).toMatchObject({ filename: "Pasted text", format: "text" });
		await extract(owner, pasted.document.id, { output: { facts: [said("location", "Austin TX")], entries: [] } });

		const scanned = await upload(owner, { filename: "scan.pdf", bytes: fixture("scanned.pdf") });
		await extract(owner, scanned.document.id, { output: { facts: [said("name", "Dana Reyes")], entries: [] } });
		const name = (await allFacts(owner)).find((f) => f.kind === "name");
		expect(name).toMatchObject({ authoritative: false, provenance: "AI_INFERRED" });
		const documents = await listDocuments(database.db, owner);
		expect(documents.find((d) => d.id === scanned.document.id)?.note).toMatch(/no text layer/);
		expect(documents.find((d) => d.id === pasted.document.id)).toMatchObject({ status: "extracted", note: null });
	});

	it("records a failure on that document only, and extracts it on retry", async () => {
		const owner = await newCandidate();
		const failing = await upload(owner, { pastedText: "Dana Reyes" });
		const fine = await upload(owner, { pastedText: "dana.reyes@example.com" });
		await extract(owner, failing.document.id, { error: noViableRoute("extract", ["key:anthropic", "key:openai"]) });
		await extract(owner, fine.document.id, {
			output: { facts: [said("email", "dana.reyes@example.com")], entries: [] },
		});

		const byId = async () => new Map((await listDocuments(database.db, owner)).map((d) => [d.id, d]));
		expect((await byId()).get(failing.document.id)).toMatchObject({
			status: "failed",
			error: expect.stringMatching(/Add one in Settings/),
		});
		expect((await byId()).get(fine.document.id)).toMatchObject({ status: "extracted", factCount: 1 });

		await expect(retryDocument({ db: database.db, jobs }, owner, fine.document.id)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await retryDocument({ db: database.db, jobs }, owner, failing.document.id);
		expect((await byId()).get(failing.document.id)).toMatchObject({ status: "queued", error: null });
		expect(await queuedJobs(owner)).toBe(3);
		await extract(owner, failing.document.id, { output: { facts: [said("name", "Dana Reyes")], entries: [] } });
		expect((await byId()).get(failing.document.id)).toMatchObject({ status: "extracted", factCount: 1 });
	});

	it("rejects other file types, mislabelled files and files over 10 MB, keeping nothing", async () => {
		const owner = await newCandidate();
		const attempts: DocumentUpload[] = [
			{ filename: "photo.png", bytes: Buffer.from("png") },
			{ filename: "resume.pdf", bytes: Buffer.from("not really a pdf") },
			{ filename: "notes.txt", bytes: Buffer.from([0xff, 0xfe, 0x00]) },
			{ filename: "big.txt", bytes: Buffer.alloc(10 * 1024 * 1024 + 1, "a") },
			{ pastedText: "   " },
		];
		for (const attempt of attempts) await expect(upload(owner, attempt)).rejects.toMatchObject({ code: "REJECTED" });
		expect(await listDocuments(database.db, owner)).toEqual([]);
		expect(await queuedJobs(owner)).toBe(0);
	});

	it("lists only the owner's documents", async () => {
		await assertTwoUserIsolation({
			seed: async (owner) => {
				await newCandidate(owner);
				await upload(owner, { pastedText: "the same text for both" });
			},
			read: (owner) => listDocuments(database.db, owner),
		});
	});
});
