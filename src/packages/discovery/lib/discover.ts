import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Executor, Tx } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { appendEvent } from "../../events/index";
import type { Storage } from "../../storage/index";
import { postingChanged, postingClosed, postingDiscovered, postingReopened, postingSighted } from "./events";
import { CONTENT_FIELDS, contentHash, fieldHashes, identityKeys, normalizePosting } from "./normalize";
import { opportunity, opportunityAlias, sighting, watchedBoard } from "./schema";
import type { ListingFailureKind, SourceAdapter, SourceKind, SourcePosting } from "./types";

export const POLL_INTERVAL_MS = 2 * 60 * 60 * 1000;
/** Polls land within ±10% of the interval, so Boards and Users spread out. */
const POLL_JITTER = 0.1;
/** A new posting's first sighting dates it only if the Board was listed this recently before (§6 freshness). */
const CONTINUITY_MS = 3 * POLL_INTERVAL_MS;
const MISSED_LISTINGS_TO_CLOSE = 2;
const NOT_FOUNDS_TO_GONE = 3;
const NOT_FOUND_SPAN_MS = 24 * 60 * 60 * 1000;

export type Adapters = Partial<Record<SourceKind, SourceAdapter>>;
export type Clock = { now?: Date; random?: () => number };

export type BoardSeed = { source: SourceKind; token: string; employer: string };

/** Watches each Board for the owner unless already watched. */
export async function watchBoards(
	exec: Executor,
	owner: UserId,
	boards: readonly BoardSeed[],
	origin: (typeof watchedBoard.$inferInsert)["origin"],
): Promise<void> {
	if (boards.length === 0) return;
	await exec
		.insert(watchedBoard)
		.values(boards.map((b) => ({ userId: owner, source: b.source, token: b.token, employerName: b.employer, origin })))
		.onConflictDoNothing();
}

/** The owner's Boards whose next poll is due, never gone ones. */
export async function dueBoards(exec: Executor, owner: UserId, now = new Date()): Promise<string[]> {
	const rows = await exec
		.select({ id: watchedBoard.id })
		.from(watchedBoard)
		.where(
			and(
				eq(watchedBoard.userId, owner),
				isNull(watchedBoard.goneAt),
				or(isNull(watchedBoard.nextPollAt), lte(watchedBoard.nextPollAt, now)),
			),
		)
		.orderBy(asc(watchedBoard.createdAt), asc(watchedBoard.id));
	return rows.map((row) => row.id);
}

export type IngestRequest = { posting: SourcePosting; continuous: boolean };
export type DiscoverOutcome =
	| { status: "LISTED"; listed: number; toIngest: IngestRequest[]; closedSightings: number }
	| { status: "FAILED"; failure: ListingFailureKind; gone: boolean };

/**
 * Polls one watched Board (§6): lists it, records Board health, counts and closes missing
 * Sightings, and returns the new, changed and reappeared postings to `ingest`. A failing
 * Board only changes its own health. Null when the owner has no such Board, or it is gone.
 */
export async function discover(
	exec: Executor,
	adapters: Adapters,
	owner: UserId,
	boardId: string,
	clock: Clock = {},
): Promise<DiscoverOutcome | null> {
	const [board] = await exec
		.select()
		.from(watchedBoard)
		.where(and(eq(watchedBoard.id, boardId), eq(watchedBoard.userId, owner)));
	if (!board || board.goneAt) return null;
	const adapter = adapters[board.source];
	if (!adapter) throw new Error(`no adapter for Source ${board.source}`);

	const listing = await adapter.listBoard({ source: board.source, token: board.token });
	const now = clock.now ?? new Date();
	const nextPollAt = new Date(
		now.getTime() + POLL_INTERVAL_MS * (1 - POLL_JITTER + 2 * POLL_JITTER * (clock.random ?? Math.random)()),
	);
	const where = and(eq(watchedBoard.id, boardId), eq(watchedBoard.userId, owner));

	if ("failure" in listing) {
		const notFound = listing.failure === "NOT_FOUND";
		const notFoundCount = notFound ? board.notFoundCount + 1 : board.notFoundCount;
		const notFoundSince = notFound ? (board.notFoundSince ?? now) : board.notFoundSince;
		const gone =
			notFound &&
			notFoundCount >= NOT_FOUNDS_TO_GONE &&
			notFoundSince !== null &&
			now.getTime() - notFoundSince.getTime() >= NOT_FOUND_SPAN_MS;
		await exec
			.update(watchedBoard)
			.set({
				lastPolledAt: now,
				nextPollAt,
				lastFailure: listing.failure,
				lastFailureDetail: listing.detail,
				consecutiveFailures: board.consecutiveFailures + 1,
				notFoundCount,
				notFoundSince,
				goneAt: gone ? now : null,
			})
			.where(where);
		return { status: "FAILED", failure: listing.failure, gone };
	}

	const continuous = board.lastListedAt !== null && now.getTime() - board.lastListedAt.getTime() <= CONTINUITY_MS;
	const postings = listing.postings.filter((posting) => posting.listed);

	return exec.transaction(async (tx) => {
		const known = await tx
			.select({
				id: sighting.id,
				nativeId: sighting.nativeId,
				status: sighting.status,
				contentHash: sighting.contentHash,
				opportunityId: sighting.opportunityId,
				missedListings: sighting.missedListings,
			})
			.from(sighting)
			.where(and(eq(sighting.userId, owner), eq(sighting.boardId, boardId)))
			.for("update");
		const byNativeId = new Map(known.map((row) => [row.nativeId, row]));

		const toIngest: IngestRequest[] = [];
		const present = new Set<string>();
		for (const posting of postings) {
			present.add(posting.nativeId);
			const seen = byNativeId.get(posting.nativeId);
			const hash = contentHash(fieldHashes(normalizePosting(posting, board.employerName)));
			if (!seen || seen.status === "CLOSED" || seen.contentHash !== hash) toIngest.push({ posting, continuous });
		}

		const stillOpen = known.filter((row) => row.status === "OPEN" && present.has(row.nativeId)).map((row) => row.id);
		if (stillOpen.length > 0) {
			await tx
				.update(sighting)
				.set({ lastSeenAt: now, missedListings: 0 })
				.where(and(eq(sighting.userId, owner), inArray(sighting.id, stillOpen)));
		}

		const missing = known.filter((row) => row.status === "OPEN" && !present.has(row.nativeId));
		const closing = missing.filter((row) => row.missedListings + 1 >= MISSED_LISTINGS_TO_CLOSE);
		const counted = missing.filter((row) => row.missedListings + 1 < MISSED_LISTINGS_TO_CLOSE);
		if (counted.length > 0) {
			await tx
				.update(sighting)
				.set({ missedListings: sql`${sighting.missedListings} + 1` })
				.where(
					and(
						eq(sighting.userId, owner),
						inArray(
							sighting.id,
							counted.map((row) => row.id),
						),
					),
				);
		}
		if (closing.length > 0) {
			await tx
				.update(sighting)
				.set({ status: "CLOSED", closedAt: now, missedListings: MISSED_LISTINGS_TO_CLOSE })
				.where(
					and(
						eq(sighting.userId, owner),
						inArray(
							sighting.id,
							closing.map((row) => row.id),
						),
					),
				);
			await closeOpportunitiesWithoutOpenSightings(
				tx,
				owner,
				[...new Set(closing.map((row) => row.opportunityId))],
				now,
			);
		}

		await tx
			.update(watchedBoard)
			.set({
				lastPolledAt: now,
				lastListedAt: now,
				nextPollAt,
				lastFailure: null,
				lastFailureDetail: null,
				consecutiveFailures: 0,
				notFoundCount: 0,
				notFoundSince: null,
			})
			.where(where);
		return { status: "LISTED", listed: postings.length, toIngest, closedSightings: closing.length };
	});
}

async function closeOpportunitiesWithoutOpenSightings(tx: Tx, owner: UserId, ids: string[], now: Date) {
	const closed = await tx
		.update(opportunity)
		.set({ status: "CLOSED", closedAt: now, updatedAt: now })
		.where(
			and(
				eq(opportunity.userId, owner),
				inArray(opportunity.id, ids),
				eq(opportunity.status, "OPEN"),
				sql`not exists (select 1 from ${sighting} where ${sighting.opportunityId} = ${opportunity.id} and ${sighting.status} = 'OPEN')`,
			),
		)
		.returning({ id: opportunity.id });
	for (const { id } of closed) await appendEvent(tx, owner, postingClosed, id, {});
}

export type IngestOutcome = "DISCOVERED" | "SIGHTED" | "CHANGED" | "REOPENED" | "UNCHANGED";
export type Ingested = { opportunityId: string; outcome: IngestOutcome };

/**
 * Normalizes one posting from a watched Board and upserts its Opportunity and Sighting (§6):
 * exact-key dedup per User, raw payload to a blob, `posting_changed` when its normalized text
 * changed. Safe to repeat. Null when the owner has no such Board. `onIngested` runs in the
 * same transaction, so the caller's next step (such as enqueueing evaluations) commits with it.
 */
export async function ingest(
	exec: Executor,
	storage: Storage,
	owner: UserId,
	boardId: string,
	posting: SourcePosting,
	options: { continuous: boolean; now?: Date; onIngested?: (tx: Tx, ingested: Ingested) => Promise<void> },
): Promise<Ingested | null> {
	const now = options.now ?? new Date();
	return exec.transaction(async (tx) => {
		const ingested = await upsert(tx);
		if (ingested) await options.onIngested?.(tx, ingested);
		return ingested;
	});

	async function upsert(tx: Tx): Promise<Ingested | null> {
		// One User's ingests run one at a time, so two Sightings of one requisition never race to two Opportunities.
		await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`discovery:${owner}`}, 0))`);
		const [board] = await tx
			.select()
			.from(watchedBoard)
			.where(and(eq(watchedBoard.id, boardId), eq(watchedBoard.userId, owner)));
		if (!board) return null;
		if (posting.source !== board.source || posting.boardToken.toLowerCase() !== board.token) {
			throw new Error("the posting is not from this Board");
		}

		const normalized = normalizePosting(posting, board.employerName);
		const hashes = fieldHashes(normalized);
		const keys = identityKeys(posting, normalized.canonicalUrl);
		const rawBlob = await storage.put(tx, Buffer.from(JSON.stringify(posting.raw)), {
			mediaType: "application/json",
			retentionClass: "permanent",
		});
		const content = {
			employerName: normalized.employerName,
			title: normalized.title,
			titleNormalized: normalized.titleNormalized,
			locationText: normalized.locationText,
			workplaceType: normalized.workplaceType,
			employmentType: normalized.employmentType,
			salary: normalized.salary,
			canonicalUrl: normalized.canonicalUrl,
			descriptionMarkdown: normalized.descriptionMarkdown,
			rawBlob,
		};
		const sightingValues = {
			url: normalized.canonicalUrl,
			applyUrl: posting.applyUrl,
			title: normalized.title,
			locationText: normalized.locationText,
			contentHash: contentHash(hashes),
			fieldHashes: hashes,
			rawBlob,
			status: "OPEN" as const,
			lastSeenAt: now,
			missedListings: 0,
			closedAt: null,
		};
		const addAliases = (opportunityId: string) =>
			tx
				.insert(opportunityAlias)
				.values(keys.map(({ key }) => ({ userId: owner, key, opportunityId })))
				.onConflictDoNothing();

		const [existing] = await tx
			.select()
			.from(sighting)
			.where(and(eq(sighting.userId, owner), eq(sighting.boardId, boardId), eq(sighting.nativeId, posting.nativeId)));

		if (existing) {
			const changed = CONTENT_FIELDS.filter((field) => existing.fieldHashes[field] !== hashes[field]);
			await tx.update(sighting).set(sightingValues).where(eq(sighting.id, existing.id));
			await addAliases(existing.opportunityId);
			const [opp] = await tx
				.select({ dedupKey: opportunity.dedupKey, status: opportunity.status })
				.from(opportunity)
				.where(and(eq(opportunity.id, existing.opportunityId), eq(opportunity.userId, owner)));
			if (!opp) throw new Error("the Sighting's Opportunity is missing");
			// The Opportunity shows the content of the post that created it; other Sightings keep their own.
			const primary = opp.dedupKey === keys[0]?.key;
			const reopened = opp.status === "CLOSED";
			if ((primary && changed.length > 0) || reopened) {
				await tx
					.update(opportunity)
					.set({
						...(primary ? content : {}),
						...(reopened ? { status: "OPEN" as const, closedAt: null } : {}),
						updatedAt: now,
					})
					.where(and(eq(opportunity.id, existing.opportunityId), eq(opportunity.userId, owner)));
			}
			if (reopened) await appendEvent(tx, owner, postingReopened, existing.opportunityId, { sightingId: existing.id });
			if (changed.length > 0) {
				await appendEvent(tx, owner, postingChanged, existing.opportunityId, { sightingId: existing.id, changed });
			}
			const outcome = reopened ? "REOPENED" : changed.length > 0 ? "CHANGED" : "UNCHANGED";
			return { opportunityId: existing.opportunityId, outcome };
		}

		// A new post: the strongest exact key another Opportunity already has decides which one it is a Sighting of.
		const aliases = await tx
			.select({ key: opportunityAlias.key, opportunityId: opportunityAlias.opportunityId })
			.from(opportunityAlias)
			.where(
				and(
					eq(opportunityAlias.userId, owner),
					inArray(
						opportunityAlias.key,
						keys.map(({ key }) => key),
					),
				),
			);
		const match = keys
			.map(({ key, kind }) => ({ kind, opportunityId: aliases.find((alias) => alias.key === key)?.opportunityId }))
			.find((candidate) => candidate.opportunityId !== undefined);

		if (match?.opportunityId) {
			const opportunityId = match.opportunityId;
			const [created] = await tx
				.insert(sighting)
				.values({
					userId: owner,
					opportunityId,
					boardId,
					nativeId: posting.nativeId,
					firstSeenAt: now,
					...sightingValues,
				})
				.returning({ id: sighting.id });
			if (!created) throw new Error("the Sighting was not created");
			await addAliases(opportunityId);
			const reopened = await tx
				.update(opportunity)
				.set({ status: "OPEN", closedAt: null, updatedAt: now })
				.where(and(eq(opportunity.id, opportunityId), eq(opportunity.userId, owner), eq(opportunity.status, "CLOSED")))
				.returning({ id: opportunity.id });
			if (reopened.length > 0) await appendEvent(tx, owner, postingReopened, opportunityId, { sightingId: created.id });
			await appendEvent(tx, owner, postingSighted, opportunityId, { sightingId: created.id, matchedBy: match.kind });
			return { opportunityId, outcome: "SIGHTED" };
		}

		const postedAt = normalized.firstPublishedAt ?? (options.continuous ? now : null);
		const [created] = await tx
			.insert(opportunity)
			.values({
				userId: owner,
				dedupKey: keys[0]?.key ?? "",
				...content,
				postedAt,
				postedAtSource: normalized.firstPublishedAt ? "SOURCE" : options.continuous ? "FIRST_SEEN" : null,
				firstSeenAt: now,
				updatedAt: now,
			})
			.returning({ id: opportunity.id });
		if (!created) throw new Error("the Opportunity was not created");
		await addAliases(created.id);
		const [seen] = await tx
			.insert(sighting)
			.values({
				userId: owner,
				opportunityId: created.id,
				boardId,
				nativeId: posting.nativeId,
				firstSeenAt: now,
				...sightingValues,
			})
			.returning({ id: sighting.id });
		if (!seen) throw new Error("the Sighting was not created");
		await appendEvent(tx, owner, postingDiscovered, created.id, { sightingId: seen.id });
		return { opportunityId: created.id, outcome: "DISCOVERED" };
	}
}
