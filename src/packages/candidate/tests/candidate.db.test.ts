import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserId } from "../../db/ownership";
import { assertTwoUserIsolation, createTestDatabase, newUserId, type TestDatabase } from "../../db/testing";
import {
	buildCandidateContext,
	createCandidate,
	type Fact,
	getCandidate,
	getKnowledgeBase,
	KnowledgeBaseError,
	type ProposedFact,
	proposeFacts,
	removeEntry,
	removeFact,
} from "../index";
import { agreedValue } from "../kinds";

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(() => database.close());

async function newCandidate(owner: UserId = newUserId()): Promise<UserId> {
	// The Candidate references its User; `users` creates real ones, here a bare row is enough.
	await database.db.execute(
		sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
	);
	await createCandidate(database.db, owner);
	return owner;
}

const fromDocument = (owner: UserId, documentId: string, facts: ProposedFact[]) =>
	proposeFacts(database.db, owner, { kind: "document", documentId }, facts);
const fromCandidate = (owner: UserId, facts: ProposedFact[]) =>
	proposeFacts(database.db, owner, { kind: "candidate", via: "profile_editor" }, facts);

const role = (ref = "r") => ({ ref, kind: "role" as const });

async function live(owner: UserId): Promise<Fact[]> {
	const kb = await getKnowledgeBase(database.db, owner);
	return [...kb.facts, ...kb.entries.flatMap((entry) => entry.facts)];
}
const ofKind = async (owner: UserId, kind: string) => (await live(owner)).filter((fact) => fact.kind === kind);

describe("normalization per kind", () => {
	it("treats organizations and people differently", () => {
		expect(agreedValue("employer", "Acme, Inc.", "ACME")).toBe("Acme, Inc.");
		expect(agreedValue("employer", "The Acme Co", "acme")).toBe("The Acme Co");
		// A legal suffix on an organization is noise; a last name on a person is not.
		expect(agreedValue("name", "Dana Co", "Dana")).toBeNull();
		expect(agreedValue("name", "dana  o’neil", "Dana O'Neil")).toBe("dana  o’neil");
		expect(agreedValue("phone", "(512) 555-0100", "512.555.0100")).toBe("(512) 555-0100");
		expect(agreedValue("link", "https://www.github.com/dana/", "github.com/dana")).not.toBeNull();
	});

	it("merges dates that differ only in precision, keeping the more precise", () => {
		expect(agreedValue("start_date", "2021", "2021-03")).toBe("2021-03");
		expect(agreedValue("start_date", "2021-03-15", "2021-03")).toBe("2021-03-15");
		expect(agreedValue("start_date", "2021-03", "2021-04")).toBeNull();
		// "2021-1" is not a prefix match of "2021-10": precision is compared by component.
		expect(agreedValue("start_date", "2021-01", "2021-10")).toBeNull();
		expect(agreedValue("start_date", "2021", "2022")).toBeNull();
	});
});

describe("proposeFacts", () => {
	it("merges equivalent values from two documents, with both sources, into one Entry", async () => {
		const owner = await newCandidate();
		await fromDocument(owner, "resume", [
			{ kind: "employer", value: "Acme, Inc.", entry: role() },
			{ kind: "title", value: "Software Engineer", entry: role() },
			{ kind: "start_date", value: "2021", entry: role() },
		]);
		const outcomes = await fromDocument(owner, "cv", [
			{ kind: "employer", value: "ACME", entry: role() },
			{ kind: "title", value: "software engineer", entry: role() },
			{ kind: "start_date", value: "2021-03", entry: role() },
		]);
		expect(outcomes.map((o) => o.outcome)).toEqual(["merged", "merged", "merged"]);

		const kb = await getKnowledgeBase(database.db, owner);
		expect(kb.entries).toHaveLength(1);
		const facts = kb.entries[0]?.facts ?? [];
		const employer = facts.find((f) => f.kind === "employer");
		expect(employer).toMatchObject({
			value: "Acme, Inc.",
			provenance: "MULTI_SOURCE_SUPPORTED",
			authoritative: true,
			verified: false,
		});
		expect(employer?.sources.map((s) => s.kind === "document" && s.documentId)).toEqual(["resume", "cv"]);
		// A precision difference is no conflict: the precise value wins and each source keeps what it said.
		const start = facts.find((f) => f.kind === "start_date");
		expect(start?.value).toBe("2021-03");
		expect(start?.conflictsWith).toEqual([]);
		expect(start?.sources.map((s) => s.stated)).toEqual(["2021", "2021-03"]);
	});

	it("keeps a different role at the same employer as its own Entry", async () => {
		const owner = await newCandidate();
		await fromDocument(owner, "resume", [
			{ kind: "employer", value: "Acme", entry: role() },
			{ kind: "title", value: "Engineer", entry: role() },
		]);
		await fromDocument(owner, "cv", [
			{ kind: "employer", value: "Acme", entry: role() },
			{ kind: "title", value: "Engineering Manager", entry: role() },
		]);
		expect((await getKnowledgeBase(database.db, owner)).entries).toHaveLength(2);
	});

	it("keeps contradicting document claims linked, and the Candidate's statement settles them", async () => {
		const owner = await newCandidate();
		const [austin] = await fromDocument(owner, "resume", [{ kind: "location", value: "Austin, TX" }]);
		const [denver] = await fromDocument(owner, "cv", [{ kind: "location", value: "Denver, CO" }]);
		expect(denver?.outcome).toBe("conflict");

		const linked = await ofKind(owner, "location");
		expect(linked.map((f) => [f.value, f.conflictsWith])).toEqual([
			["Austin, TX", [denver?.factId]],
			["Denver, CO", [austin?.factId]],
		]);
		// Both stay usable; nothing is blocked or deleted.
		expect((await buildCandidateContext(database.db, owner)).facts.filter((f) => f.kind === "location")).toHaveLength(
			2,
		);

		await proposeFacts(database.db, owner, { kind: "candidate", via: "about_you" }, [
			{ kind: "location", value: "denver, co" },
		]);
		const settled = await ofKind(owner, "location");
		expect(settled).toHaveLength(1);
		expect(settled[0]).toMatchObject({
			id: denver?.factId,
			value: "denver, co",
			provenance: "USER_EXPLICIT",
			verified: true,
			conflictsWith: [],
		});
	});

	it("lets the Candidate's correction supersede a document value, now and on later uploads", async () => {
		const owner = await newCandidate();
		const [, , end] = await fromDocument(owner, "resume", [
			{ kind: "employer", value: "Brightwell", entry: role() },
			{ kind: "title", value: "Engineer", entry: role() },
			{ kind: "end_date", value: "2023-02", entry: role() },
		]);
		const [corrected] = await fromCandidate(owner, [{ kind: "end_date", value: "2023-03", factId: end?.factId }]);
		// Edited in place: the Fact keeps its id, so citations to it stay valid.
		expect(corrected).toEqual({ factId: end?.factId, outcome: "updated" });

		const [again] = await fromDocument(owner, "old-cv", [
			{ kind: "employer", value: "Brightwell", entry: role() },
			{ kind: "title", value: "Engineer", entry: role() },
			{ kind: "end_date", value: "2023-02", entry: role() },
		]).then((outcomes) => outcomes.slice(2));
		expect(again?.outcome).toBe("superseded");

		const ends = await ofKind(owner, "end_date");
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			value: "2023-03",
			provenance: "USER_EXPLICIT",
			authoritative: true,
			verified: true,
		});
		// The document's disagreeing claim moved off the corrected Fact.
		expect(ends[0]?.sources.map((s) => s.kind)).toEqual(["candidate"]);
	});

	it("lets the Candidate state a new value over a document's without naming the Fact", async () => {
		const owner = await newCandidate();
		await fromDocument(owner, "resume", [{ kind: "phone", value: "512-555-0100" }]);
		await fromCandidate(owner, [{ kind: "phone", value: "512-555-0199" }]);
		// The same number in a new format merges into the Candidate's Fact rather than conflicting.
		const [merged] = await fromDocument(owner, "cv", [{ kind: "phone", value: "(512) 555 0199" }]);
		expect(merged?.outcome).toBe("merged");
		const phones = await ofKind(owner, "phone");
		expect(phones.map((f) => [f.value, f.provenance])).toEqual([["512-555-0199", "USER_EXPLICIT"]]);
	});

	it("keeps a list kind as a list, merging only repeats", async () => {
		const owner = await newCandidate();
		await fromDocument(owner, "resume", [
			{ kind: "skill", value: "TypeScript" },
			{ kind: "skill", value: "Postgres" },
		]);
		const outcomes = await fromDocument(owner, "cv", [
			{ kind: "skill", value: "typescript" },
			{ kind: "skill", value: "Go" },
		]);
		expect(outcomes.map((o) => o.outcome)).toEqual(["merged", "created"]);
		expect((await ofKind(owner, "skill")).map((f) => [f.value, f.conflictsWith])).toEqual([
			["TypeScript", []],
			["Postgres", []],
			["Go", []],
		]);
	});

	it("never makes an inference Authoritative or verified, and refuses one without evidence", async () => {
		const owner = await newCandidate();
		await fromDocument(owner, "resume", [
			{ kind: "work_authorization", value: "US citizen", inference: { evidence: ["Lives in Austin"] } },
		]);
		expect((await ofKind(owner, "work_authorization"))[0]).toMatchObject({
			provenance: "AI_INFERRED",
			authoritative: false,
			verified: false,
		});
		await expect(
			fromDocument(owner, "resume", [{ kind: "clearance", value: "Secret", inference: { evidence: [] } }]),
		).rejects.toThrow(KnowledgeBaseError);
	});

	it("validates each kind and where it may sit, writing nothing when any Fact is invalid", async () => {
		const owner = await newCandidate();
		const invalid: ProposedFact[][] = [
			[{ kind: "email", value: "not an email" }],
			[{ kind: "start_date", value: "March 2021", entry: role() }],
			[{ kind: "employer", value: "Acme" }],
			[{ kind: "no_such_kind", value: "x" }],
		];
		for (const facts of invalid) {
			await expect(fromCandidate(owner, [{ kind: "skill", value: "Go" }, ...facts])).rejects.toThrow(
				KnowledgeBaseError,
			);
		}
		expect(await live(owner)).toEqual([]);
		// Anything without a kind of its own still has a home.
		await fromCandidate(owner, [{ kind: "other", value: "Fluent in Portuguese" }]);
		expect(await ofKind(owner, "other")).toHaveLength(1);
	});

	it("nests an Entry one level deep and no deeper", async () => {
		const owner = await newCandidate();
		await fromCandidate(owner, [
			{ kind: "employer", value: "Acme", entry: role("acme") },
			{ kind: "story_title", value: "Led the migration", entry: { ref: "s", kind: "story", parent: role("acme") } },
		]);
		const [parent, child] = (await getKnowledgeBase(database.db, owner)).entries;
		expect(child?.parentId).toBe(parent?.id);
		await expect(
			fromCandidate(owner, [
				{
					kind: "story_title",
					value: "Too deep",
					entry: { ref: "deep", kind: "story", parent: { id: child?.id ?? "" } },
				},
			]),
		).rejects.toThrow("one level");
	});

	it("soft-deletes a Fact, and an Entry with its children and Facts", async () => {
		const owner = await newCandidate();
		const [skill, employer] = await fromCandidate(owner, [
			{ kind: "skill", value: "Go" },
			{ kind: "employer", value: "Acme", entry: role("acme") },
			{ kind: "story_title", value: "Migration", entry: { ref: "s", kind: "story", parent: role("acme") } },
		]);
		await removeFact(database.db, owner, skill?.factId ?? "");
		const [entry] = (await getKnowledgeBase(database.db, owner)).entries;
		await removeEntry(database.db, owner, entry?.id ?? "");
		expect(await getKnowledgeBase(database.db, owner)).toEqual({ facts: [], entries: [] });
		// Soft: the rows remain.
		const rows = await database.db.execute(sql`select 1 from candidate_fact where id = ${employer?.factId}`);
		expect(rows.rows).toHaveLength(1);
	});
});

describe("buildCandidateContext", () => {
	it("returns Entries and Facts with ids and the Authoritative Facts, within the budget", async () => {
		const owner = await newCandidate();
		await fromCandidate(owner, [
			{ kind: "name", value: "Dana Rivera" },
			{ kind: "email", value: "dana@example.com" },
			{ kind: "employer", value: "Acme", entry: role() },
			{ kind: "accomplishment", value: "Cut p99 latency by 40%", entry: role() },
		]);
		const whole = await buildCandidateContext(database.db, owner, { drivingHuntId: null, opportunityId: null });
		expect(whole.authoritativeFacts.map((f) => f.kind).sort()).toEqual(["email", "employer", "name"]);
		expect(whole.entries[0]?.facts.map((f) => f.kind)).toEqual(["employer", "accomplishment"]);
		expect(whole.budget.omittedFactIds).toEqual([]);
		expect(whole.baseResume).toBeNull();
		for (const fact of [...whole.facts, ...whole.entries.flatMap((e) => e.facts)])
			expect(fact.id).toMatch(/^[0-9a-f-]{36}$/);

		// A budget too small for everything still carries every Authoritative Fact, and says what it left out.
		const tight = await buildCandidateContext(database.db, owner, { budgetTokens: 1 });
		expect(tight.authoritativeFacts).toHaveLength(3);
		expect(tight.entries[0]?.facts.map((f) => f.kind)).toEqual(["employer"]);
		const accomplishment = whole.entries[0]?.facts.find((f) => f.kind === "accomplishment");
		expect(tight.budget.omittedFactIds).toEqual([accomplishment?.id]);
	});
});

describe("two-user isolation", () => {
	const seed = (owner: UserId) =>
		newCandidate(owner).then(() =>
			fromCandidate(owner, [
				{ kind: "email", value: `${owner}@example.com` },
				{ kind: "employer", value: "Acme", entry: role() },
			]),
		);

	it("reads only its owner's Candidate", async () => {
		await assertTwoUserIsolation({
			seed: (owner) => newCandidate(owner).then(() => undefined),
			read: async (owner) => {
				const found = await getCandidate(database.db, owner);
				return found ? [found] : [];
			},
		});
	});

	it("reads only its owner's Knowledge Base", async () => {
		await assertTwoUserIsolation({
			seed: (owner) => seed(owner).then(() => undefined),
			read: async (owner) => {
				const kb = await getKnowledgeBase(database.db, owner);
				return [...kb.facts, ...kb.entries];
			},
		});
	});

	it("builds context only from its owner's Knowledge Base", async () => {
		await assertTwoUserIsolation({
			seed: (owner) => seed(owner).then(() => undefined),
			read: async (owner) => {
				const context = await buildCandidateContext(database.db, owner);
				return [...context.facts, ...context.entries, ...context.authoritativeFacts];
			},
		});
	});

	it("cannot edit, remove or write under another User's Facts and Entries", async () => {
		const alice = await newCandidate();
		const bob = await newCandidate();
		const [email] = await fromCandidate(alice, [
			{ kind: "email", value: "alice@example.com" },
			{ kind: "employer", value: "Acme", entry: role() },
		]);
		const [aliceEntry] = (await getKnowledgeBase(database.db, alice)).entries;
		const factId = email?.factId ?? "";
		const entryId = aliceEntry?.id ?? "";

		await expect(fromCandidate(bob, [{ kind: "email", value: "bob@example.com", factId }])).rejects.toThrow(
			"not found",
		);
		await expect(fromCandidate(bob, [{ kind: "title", value: "CTO", entry: { id: entryId } }])).rejects.toThrow(
			"not found",
		);
		await expect(removeFact(database.db, bob, factId)).rejects.toThrow("not found");
		await expect(removeEntry(database.db, bob, entryId)).rejects.toThrow("not found");
		expect((await ofKind(alice, "email"))[0]?.value).toBe("alice@example.com");
		expect((await getKnowledgeBase(database.db, alice)).entries).toHaveLength(1);
	});
});
