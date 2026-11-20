import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor, Tx } from "../../db/index";
import type { UserId } from "../../db/ownership";
import {
	agreedValue,
	ENTRY_KIND_INFO,
	type EntryKind,
	type FactScope,
	factKind,
	isFactKindName,
	type Provenance,
} from "../kinds";
import { candidateEntry, candidateFact, type StoredSource } from "./schema";

/** Where the Candidate said something. Every channel saves as `USER_EXPLICIT`, with no confirmation step. */
export type CandidateChannel = "about_you" | "profile_editor";

export type ProposalSource = { kind: "candidate"; via: CandidateChannel } | { kind: "document"; documentId: string };

/**
 * The Entry a proposed Fact belongs under: an existing one by id, or one named by a
 * `ref` that is local to this proposal. A `ref` Entry whose identity Facts (a role's
 * employer and title, ...) match an existing Entry joins it; otherwise it is created.
 */
export type EntryRef = { id: string } | { ref: string; kind: EntryKind; parent?: EntryRef };

export type ProposedFact = {
	kind: string;
	value: string;
	/** Omitted for a Fact about the Candidate as a whole, such as their email or a skill. */
	entry?: EntryRef;
	/** The Candidate's edit of this existing Fact, in place. */
	factId?: string;
	/** A document's inference, kept only with the evidence it rests on and never Authoritative or verified. */
	inference?: { evidence: string[] };
};

export type ProposalOutcome = {
	factId: string;
	/**
	 * `created` a new Fact; `merged` into an equivalent one; `updated` a Fact in place;
	 * `superseded` stored behind the Candidate's own statement; `conflict` kept linked to
	 * the Facts it contradicts.
	 */
	outcome: "created" | "merged" | "updated" | "superseded" | "conflict";
};

export class KnowledgeBaseError extends Error {
	override name = "KnowledgeBaseError";
	constructor(
		readonly code: "INVALID" | "NOT_FOUND",
		message: string,
	) {
		super(message);
	}
}

type FactRow = typeof candidateFact.$inferSelect;
type ResolvedEntry = { id: string | null; scope: FactScope; parentId: string | null };

/**
 * The only write path into the Candidate Knowledge Base (#10). In one transaction, per
 * proposed Fact: normalize by kind; merge into an equivalent Fact (sources merge, and a
 * difference in precision is not a conflict); let the Candidate's own statement supersede
 * a document's; keep contradicting document claims as linked Facts.
 */
export async function proposeFacts(
	exec: Executor,
	owner: UserId,
	source: ProposalSource,
	facts: readonly ProposedFact[],
): Promise<ProposalOutcome[]> {
	return exec.transaction(async (tx) => {
		// Serializes writers for one Candidate, so two proposals never split a slot between them.
		await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`candidate:${owner}`}, 0))`);
		const at = new Date().toISOString();
		const entries = new Map<string, ResolvedEntry>();
		const outcomes: ProposalOutcome[] = [];
		for (const fact of facts) {
			const stated = statedBy(source, fact, at);
			if (fact.factId !== undefined) {
				outcomes.push(await edit(tx, owner, fact.factId, fact.kind, stated));
			} else {
				const entry = await resolveEntry(tx, owner, fact.entry, facts, entries);
				outcomes.push(await propose(tx, owner, entry, fact.kind, stated));
			}
		}
		return outcomes;
	});
}

function statedBy(source: ProposalSource, fact: ProposedFact, at: string): StoredSource {
	if (!isFactKindName(fact.kind)) throw new KnowledgeBaseError("INVALID", `unknown fact kind: ${fact.kind}`);
	const parsed = factKind(fact.kind).schema.safeParse(fact.value);
	if (!parsed.success) {
		const problem = parsed.error.issues[0]?.message ?? "invalid value";
		throw new KnowledgeBaseError("INVALID", `${factKind(fact.kind).label}: ${problem}`);
	}
	if (source.kind === "candidate") {
		if (fact.inference) throw new KnowledgeBaseError("INVALID", "the Candidate's own statements are not inferences");
		return { kind: "candidate", via: source.via, stated: parsed.data, at };
	}
	if (fact.factId !== undefined) throw new KnowledgeBaseError("INVALID", "only the Candidate edits a Fact in place");
	if (fact.inference && fact.inference.evidence.length === 0) {
		throw new KnowledgeBaseError("INVALID", "an inference must cite its evidence");
	}
	return {
		kind: "document",
		documentId: source.documentId,
		stated: parsed.data,
		inferred: fact.inference !== undefined,
		...(fact.inference ? { evidence: fact.inference.evidence } : {}),
		at,
	};
}

async function resolveEntry(
	tx: Tx,
	owner: UserId,
	ref: EntryRef | undefined,
	proposal: readonly ProposedFact[],
	resolved: Map<string, ResolvedEntry>,
): Promise<ResolvedEntry> {
	if (!ref) return { id: null, scope: "candidate", parentId: null };
	if ("id" in ref) {
		const [found] = await tx
			.select({ id: candidateEntry.id, kind: candidateEntry.kind, parentId: candidateEntry.parentId })
			.from(candidateEntry)
			.where(and(eq(candidateEntry.id, ref.id), eq(candidateEntry.userId, owner), isNull(candidateEntry.deletedAt)));
		if (!found) throw new KnowledgeBaseError("NOT_FOUND", "entry not found");
		return { id: found.id, scope: found.kind as EntryKind, parentId: found.parentId };
	}
	const known = resolved.get(ref.ref);
	if (known) return known;
	if (!Object.hasOwn(ENTRY_KIND_INFO, ref.kind))
		throw new KnowledgeBaseError("INVALID", `unknown entry kind: ${ref.kind}`);
	const parent = ref.parent ? await resolveEntry(tx, owner, ref.parent, proposal, resolved) : null;
	if (parent && parent.parentId !== null) {
		throw new KnowledgeBaseError("INVALID", "an Entry nests at most one level deep");
	}
	const parentId = parent?.id ?? null;
	const identity = ENTRY_KIND_INFO[ref.kind].identity.map(
		(kind) =>
			[
				kind,
				proposal.find((f) => f.kind === kind && f.entry && "ref" in f.entry && f.entry.ref === ref.ref)?.value,
			] as const,
	);
	let id = identity.every(([, value]) => value !== undefined)
		? await findEntryByIdentity(tx, owner, ref.kind, parentId, identity as [string, string][])
		: null;
	if (!id) {
		const [created] = await tx
			.insert(candidateEntry)
			.values({ userId: owner, kind: ref.kind, parentId })
			.returning({ id: candidateEntry.id });
		if (!created) throw new Error("the Entry was not created");
		id = created.id;
	}
	const entry = { id, scope: ref.kind, parentId };
	resolved.set(ref.ref, entry);
	return entry;
}

/** An existing Entry of this kind and parent whose identity Facts all agree with the stated ones. */
async function findEntryByIdentity(
	tx: Tx,
	owner: UserId,
	kind: EntryKind,
	parentId: string | null,
	identity: [string, string][],
): Promise<string | null> {
	const rows = await tx
		.select({ entryId: candidateEntry.id, kind: candidateFact.kind, value: candidateFact.value })
		.from(candidateEntry)
		.innerJoin(candidateFact, eq(candidateFact.entryId, candidateEntry.id))
		.where(
			and(
				eq(candidateEntry.userId, owner),
				eq(candidateEntry.kind, kind),
				parentId === null ? isNull(candidateEntry.parentId) : eq(candidateEntry.parentId, parentId),
				isNull(candidateEntry.deletedAt),
				isNull(candidateFact.deletedAt),
				isNull(candidateFact.supersededBy),
			),
		);
	const ids = new Set(rows.map((row) => row.entryId));
	for (const id of ids) {
		const agrees = identity.every(([kind, value]) =>
			rows.some((row) => row.entryId === id && row.kind === kind && agreedValue(kind, row.value, value) !== null),
		);
		if (agrees) return id;
	}
	return null;
}

async function propose(
	tx: Tx,
	owner: UserId,
	entry: ResolvedEntry,
	kindName: string,
	source: StoredSource,
): Promise<ProposalOutcome> {
	const kind = factKind(kindName);
	if (!kind.scopes.includes(entry.scope)) {
		throw new KnowledgeBaseError("INVALID", `a ${kindName} fact does not belong on a ${entry.scope}`);
	}
	const slot = await liveFacts(tx, owner, entry.id, kindName);
	const fromCandidate = source.kind === "candidate";

	for (const existing of slot) {
		const agreed = agreedValue(kindName, existing.value, source.stated);
		if (agreed === null) continue;
		// Equivalent values merge; the Candidate's own spelling wins, a more precise value wins.
		const value = fromCandidate && kind.normalize(agreed) === kind.normalize(source.stated) ? source.stated : agreed;
		await save(tx, existing.id, kindName, value, withSource(existing.sources, source));
		if (fromCandidate && kind.cardinality === "one") await supersede(tx, slot, existing.id);
		return { factId: existing.id, outcome: "merged" };
	}
	if (slot.length === 0 || kind.cardinality === "many") {
		return { factId: await insertFact(tx, owner, entry.id, kindName, [source], {}), outcome: "created" };
	}

	// One value per slot, and this one differs from every value already there.
	const stated = slot.find(isStatedByCandidate);
	if (fromCandidate) {
		if (stated) return { factId: stated.id, outcome: await correct(tx, owner, stated, source) };
		const id = await insertFact(tx, owner, entry.id, kindName, [source], {});
		await supersede(tx, slot, id);
		return { factId: id, outcome: "created" };
	}
	if (stated) {
		return {
			factId: await insertFact(tx, owner, entry.id, kindName, [source], { supersededBy: stated.id }),
			outcome: "superseded",
		};
	}
	const conflictGroup = slot.find((fact) => fact.conflictGroup)?.conflictGroup ?? randomUUID();
	const id = await insertFact(tx, owner, entry.id, kindName, [source], { conflictGroup });
	await tx
		.update(candidateFact)
		.set({ conflictGroup })
		.where(
			inArray(
				candidateFact.id,
				slot.map((fact) => fact.id),
			),
		);
	return { factId: id, outcome: "conflict" };
}

async function edit(tx: Tx, owner: UserId, factId: string, kindName: string, source: StoredSource) {
	const [fact] = await tx
		.select()
		.from(candidateFact)
		.where(
			and(
				eq(candidateFact.id, factId),
				eq(candidateFact.userId, owner),
				isNull(candidateFact.deletedAt),
				isNull(candidateFact.supersededBy),
			),
		);
	if (!fact) throw new KnowledgeBaseError("NOT_FOUND", "fact not found");
	if (fact.kind !== kindName) throw new KnowledgeBaseError("INVALID", "a Fact keeps its kind");
	return { factId: fact.id, outcome: await correct(tx, owner, fact, source) };
}

/**
 * The Candidate's correction of a Fact, in place: it keeps its id and takes the stated
 * value. Document claims that no longer agree move to a Fact superseded by this one, and
 * other values in its slot are superseded too.
 */
async function correct(tx: Tx, owner: UserId, fact: FactRow, source: StoredSource): Promise<"updated"> {
	const kept: StoredSource[] = [];
	const moved: StoredSource[] = [];
	for (const s of fact.sources) {
		// The Candidate's newer statement replaces their older one.
		if (s.kind === "candidate") continue;
		(agreedValue(fact.kind, s.stated, source.stated) === null ? moved : kept).push(s);
	}
	if (moved.length > 0) {
		await insertFact(tx, owner, fact.entryId, fact.kind, moved, { supersededBy: fact.id });
	}
	await save(tx, fact.id, fact.kind, source.stated, [...kept, source]);
	if (factKind(fact.kind).cardinality === "one") {
		await supersede(tx, await liveFacts(tx, owner, fact.entryId, fact.kind), fact.id);
	}
	return "updated";
}

/** Soft-deletes a Fact. */
export async function removeFact(exec: Executor, owner: UserId, factId: string): Promise<void> {
	const removed = await exec
		.update(candidateFact)
		.set({ deletedAt: new Date() })
		.where(and(eq(candidateFact.id, factId), eq(candidateFact.userId, owner), isNull(candidateFact.deletedAt)))
		.returning({ id: candidateFact.id });
	if (removed.length === 0) throw new KnowledgeBaseError("NOT_FOUND", "fact not found");
}

/** Soft-deletes an Entry with its child Entries and every Fact under them. */
export async function removeEntry(exec: Executor, owner: UserId, entryId: string): Promise<void> {
	await exec.transaction(async (tx) => {
		const now = new Date();
		const removed = await tx
			.update(candidateEntry)
			.set({ deletedAt: now })
			.where(
				and(
					eq(candidateEntry.userId, owner),
					isNull(candidateEntry.deletedAt),
					sql`(${candidateEntry.id} = ${entryId} or ${candidateEntry.parentId} = ${entryId})`,
				),
			)
			.returning({ id: candidateEntry.id });
		if (!removed.some((entry) => entry.id === entryId)) throw new KnowledgeBaseError("NOT_FOUND", "entry not found");
		await tx
			.update(candidateFact)
			.set({ deletedAt: now })
			.where(
				and(
					eq(candidateFact.userId, owner),
					isNull(candidateFact.deletedAt),
					inArray(
						candidateFact.entryId,
						removed.map((entry) => entry.id),
					),
				),
			);
	});
}

function liveFacts(tx: Tx, owner: UserId, entryId: string | null, kind: string): Promise<FactRow[]> {
	return tx
		.select()
		.from(candidateFact)
		.where(
			and(
				eq(candidateFact.userId, owner),
				entryId === null ? isNull(candidateFact.entryId) : eq(candidateFact.entryId, entryId),
				eq(candidateFact.kind, kind),
				isNull(candidateFact.deletedAt),
				isNull(candidateFact.supersededBy),
			),
		)
		.orderBy(candidateFact.createdAt);
}

function isStatedByCandidate(fact: FactRow): boolean {
	return fact.sources.some((s) => s.kind === "candidate");
}

/** One source per Candidate and per document: a repeated statement replaces the earlier one. */
function withSource(sources: readonly StoredSource[], source: StoredSource): StoredSource[] {
	const key = (s: StoredSource) => (s.kind === "candidate" ? "candidate" : `document:${s.documentId}`);
	return [...sources.filter((s) => key(s) !== key(source)), source];
}

/** Provenance, `authoritative` and `verified` follow from the sources on every write. */
function derive(kindName: string, sources: readonly StoredSource[]) {
	const fromCandidate = sources.some((s) => s.kind === "candidate");
	const explicitDocuments = new Set(
		sources.flatMap((s) => (s.kind === "document" && !s.inferred ? [s.documentId] : [])),
	).size;
	const provenance: Provenance = fromCandidate
		? "USER_EXPLICIT"
		: explicitDocuments > 1
			? "MULTI_SOURCE_SUPPORTED"
			: explicitDocuments === 1
				? "DOCUMENT_EXPLICIT"
				: "AI_INFERRED";
	return {
		provenance,
		// A document establishes an Authoritative Fact only when it states the value explicitly.
		authoritative: factKind(kindName).authoritative && (fromCandidate || explicitDocuments > 0),
		verified: fromCandidate,
	};
}

async function insertFact(
	tx: Tx,
	owner: UserId,
	entryId: string | null,
	kind: string,
	sources: StoredSource[],
	options: { supersededBy?: string; conflictGroup?: string },
): Promise<string> {
	const value = sources[sources.length - 1]?.stated;
	if (value === undefined) throw new Error("a Fact needs a source");
	const [created] = await tx
		.insert(candidateFact)
		.values({
			userId: owner,
			entryId,
			kind,
			value,
			sources,
			...derive(kind, sources),
			supersededBy: options.supersededBy ?? null,
			conflictGroup: options.conflictGroup ?? null,
		})
		.returning({ id: candidateFact.id });
	if (!created) throw new Error("the Fact was not created");
	return created.id;
}

async function save(tx: Tx, id: string, kind: string, value: string, sources: StoredSource[]): Promise<void> {
	const derived = derive(kind, sources);
	await tx
		.update(candidateFact)
		.set({
			value,
			sources,
			...derived,
			// Once the Candidate has said it, nothing contradicts it any more.
			...(derived.verified ? { conflictGroup: null } : {}),
			updatedAt: new Date(),
		})
		.where(eq(candidateFact.id, id));
}

async function supersede(tx: Tx, slot: readonly FactRow[], keepId: string): Promise<void> {
	const others = slot.filter((fact) => fact.id !== keepId).map((fact) => fact.id);
	if (others.length === 0) return;
	await tx
		.update(candidateFact)
		.set({ supersededBy: keepId, updatedAt: new Date() })
		.where(inArray(candidateFact.id, others));
}
