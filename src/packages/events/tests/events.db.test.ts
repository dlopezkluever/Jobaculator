import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { assertTwoUserIsolation, createTestDatabase, newUserId, type TestDatabase } from "../../db/testing";
import { appendEvent, defineEvent, listEvents } from "../index";

const matchSkipped = defineEvent({
	code: "match_skipped",
	subject: "match",
	payload: z.object({ reason: z.enum(["below_fit", "excluded_employer"]), huntId: z.uuid() }),
});
const huntId = "33333333-3333-4333-8333-333333333333";

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(() => database.close());

describe("events", () => {
	it("commits with the caller's transaction and rolls back with it", async () => {
		const owner = newUserId();
		await database.db.transaction((tx) => appendEvent(tx, owner, matchSkipped, "m1", { reason: "below_fit", huntId }));
		await expect(
			database.db.transaction(async (tx) => {
				await appendEvent(tx, owner, matchSkipped, "m1", { reason: "excluded_employer", huntId });
				throw new Error("state change failed");
			}),
		).rejects.toThrow("state change failed");

		const events = await listEvents(database.db, owner, { type: "match", id: "m1" });
		expect(events.map((e) => [e.code, e.payload])).toEqual([["match_skipped", { reason: "below_fit", huntId }]]);
	});

	it("rejects a payload that does not match its schema, writing nothing", async () => {
		const owner = newUserId();
		await expect(
			database.db.transaction((tx) => appendEvent(tx, owner, matchSkipped, "m2", { reason: "vibes", huntId } as never)),
		).rejects.toThrow();
		expect(await listEvents(database.db, owner, { type: "match", id: "m2" })).toEqual([]);
	});

	it("is append-only", async () => {
		const owner = newUserId();
		await database.db.transaction((tx) => appendEvent(tx, owner, matchSkipped, "m3", { reason: "below_fit", huntId }));
		await expect(database.db.execute(sql`update event set code = 'x'`)).rejects.toThrow();
		await expect(database.db.execute(sql`delete from event`)).rejects.toThrow();
		expect(await listEvents(database.db, owner, { type: "match", id: "m3" })).toHaveLength(1);
	});

	it("keeps each User's timeline to themselves", async () => {
		await assertTwoUserIsolation({
			seed: (owner) =>
				database.db.transaction((tx) =>
					appendEvent(tx, owner, matchSkipped, "shared", { reason: "below_fit", huntId }),
				),
			read: (owner) => listEvents(database.db, owner, { type: "match", id: "shared" }),
		});
	});
});
