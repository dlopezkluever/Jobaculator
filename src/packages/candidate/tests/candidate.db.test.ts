import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, it } from "vitest";
import { assertTwoUserIsolation, createTestDatabase, type TestDatabase } from "../../db/testing";
import { createCandidate, getCandidate } from "../index";

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(() => database.close());

describe("candidate", () => {
	it("reads only its owner's Candidate", async () => {
		await assertTwoUserIsolation({
			seed: async (owner) => {
				// The Candidate references its User; `users` creates real ones, here a bare row is enough.
				await database.db.execute(
					sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
				);
				await createCandidate(database.db, owner);
			},
			read: async (owner) => {
				const found = await getCandidate(database.db, owner);
				return found ? [found] : [];
			},
		});
	});
});
