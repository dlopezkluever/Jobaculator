import { and, asc, eq, isNull } from "drizzle-orm";
import type { Executor } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { type EntryKind, FACT_KINDS, type Provenance } from "../kinds";
import { candidateEntry, candidateFact, type StoredSource } from "./schema";

const KIND_ORDER: readonly string[] = Object.keys(FACT_KINDS);

export type Fact = {
	id: string;
	entryId: string | null;
	kind: string;
	value: string;
	provenance: Provenance;
	authoritative: boolean;
	verified: boolean;
	sources: StoredSource[];
	/** Other live Facts that contradict this one. Generation uses only what they agree on. */
	conflictsWith: string[];
};

export type Entry = { id: string; kind: EntryKind; parentId: string | null; facts: Fact[] };

/** The live Knowledge Base: soft-deleted and superseded Facts are left out. */
export type KnowledgeBase = {
	/** Facts about the Candidate as a whole (contact details, skills, logistics). */
	facts: Fact[];
	/** Most recent first; a child Entry follows its parent. */
	entries: Entry[];
};

export async function getKnowledgeBase(exec: Executor, owner: UserId): Promise<KnowledgeBase> {
	const [entryRows, factRows] = await Promise.all([
		exec
			.select({ id: candidateEntry.id, kind: candidateEntry.kind, parentId: candidateEntry.parentId })
			.from(candidateEntry)
			.where(and(eq(candidateEntry.userId, owner), isNull(candidateEntry.deletedAt)))
			.orderBy(asc(candidateEntry.createdAt)),
		exec
			.select({
				id: candidateFact.id,
				entryId: candidateFact.entryId,
				kind: candidateFact.kind,
				value: candidateFact.value,
				provenance: candidateFact.provenance,
				authoritative: candidateFact.authoritative,
				verified: candidateFact.verified,
				sources: candidateFact.sources,
				conflictGroup: candidateFact.conflictGroup,
			})
			.from(candidateFact)
			.where(and(eq(candidateFact.userId, owner), isNull(candidateFact.deletedAt), isNull(candidateFact.supersededBy)))
			.orderBy(asc(candidateFact.createdAt)),
	]);
	const facts: Fact[] = factRows
		.map(({ conflictGroup, ...fact }) => ({
			...fact,
			conflictsWith: conflictGroup
				? factRows.filter((other) => other.conflictGroup === conflictGroup && other.id !== fact.id).map((o) => o.id)
				: [],
		}))
		// Registry order, so contradicting values sit together; oldest first within a kind (a stable sort).
		.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
	const entries: Entry[] = entryRows.map((entry) => ({
		...entry,
		kind: entry.kind as EntryKind,
		facts: facts.filter((fact) => fact.entryId === entry.id),
	}));
	return { facts: facts.filter((fact) => fact.entryId === null), entries: byRecency(entries) };
}

/** Ongoing first, then by latest end or start date; undated last. A child Entry sorts right after its parent. */
function byRecency(entries: Entry[]): Entry[] {
	const date = (entry: Entry) => {
		const value = (kind: string) => entry.facts.find((fact) => fact.kind === kind)?.value;
		const end = value("end_date") ?? value("issued_date");
		return end === "present" ? "9999" : (end ?? value("start_date") ?? "");
	};
	const top = entries.filter((entry) => entry.parentId === null).sort((a, b) => date(b).localeCompare(date(a)));
	return top.flatMap((parent) => [
		parent,
		...entries.filter((child) => child.parentId === parent.id).sort((a, b) => date(b).localeCompare(date(a))),
	]);
}

export type ContextFact = {
	id: string;
	kind: string;
	value: string;
	provenance: Provenance;
	authoritative: boolean;
	conflictsWith?: string[];
};

export type CandidateContext = {
	facts: ContextFact[];
	entries: { id: string; kind: EntryKind; parentId: string | null; facts: ContextFact[] }[];
	/** Values generation must use exactly as stated, never alter or choose between (#10). */
	authoritativeFacts: (ContextFact & { entryId: string | null })[];
	/** Base Resumes (seeded from uploaded resumes, §8) are not built yet. */
	baseResume: null;
	budget: { limitTokens: number; usedTokens: number; omittedFactIds: string[] };
};

/** A Candidate is about 15–40K tokens (#10), so by default the whole Knowledge Base fits. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 60_000;

/**
 * What generation reads about the Candidate (#10, §8): every Entry and Fact with its id,
 * the Authoritative Facts, and the optional Base Resume. This is the one seam for future
 * retrieval. Today it selects by budget only: Authoritative Facts always fit, then Facts
 * about the Candidate, then Entries from most recent, until the budget runs out.
 * `drivingHuntId` and `opportunityId` are accepted for Positioning and question relevance,
 * which arrive with Hunts and Opportunities; they do not narrow the selection yet.
 */
export async function buildCandidateContext(
	exec: Executor,
	owner: UserId,
	request: { drivingHuntId?: string | null; opportunityId?: string | null; budgetTokens?: number } = {},
): Promise<CandidateContext> {
	const limitTokens = request.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
	const knowledge = await getKnowledgeBase(exec, owner);
	const tokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
	const view = (fact: Fact): ContextFact => ({
		id: fact.id,
		kind: fact.kind,
		value: fact.value,
		provenance: fact.provenance,
		authoritative: fact.authoritative,
		...(fact.conflictsWith.length > 0 ? { conflictsWith: fact.conflictsWith } : {}),
	});

	const ranked = [...knowledge.facts, ...knowledge.entries.flatMap((entry) => entry.facts)];
	const authoritative = ranked.filter((fact) => fact.authoritative);
	// Authoritative Facts appear in their Entry and in their own list, so they count twice.
	let usedTokens = authoritative.reduce((sum, fact) => sum + 2 * tokens(view(fact)), 0);
	const included = new Set(authoritative.map((fact) => fact.id));
	const omittedFactIds: string[] = [];
	for (const fact of ranked) {
		if (fact.authoritative) continue;
		const cost = tokens(view(fact));
		if (omittedFactIds.length === 0 && usedTokens + cost <= limitTokens) {
			usedTokens += cost;
			included.add(fact.id);
		} else {
			omittedFactIds.push(fact.id);
		}
	}

	const keep = (facts: Fact[]) => facts.filter((fact) => included.has(fact.id)).map(view);
	return {
		facts: keep(knowledge.facts),
		entries: knowledge.entries
			.map((entry) => ({ id: entry.id, kind: entry.kind, parentId: entry.parentId, facts: keep(entry.facts) }))
			.filter((entry) => entry.facts.length > 0),
		authoritativeFacts: authoritative.map((fact) => ({ ...view(fact), entryId: fact.entryId })),
		baseResume: null,
		budget: { limitTokens, usedTokens, omittedFactIds },
	};
}
