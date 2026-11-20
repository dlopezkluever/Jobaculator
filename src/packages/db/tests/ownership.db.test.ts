import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findUnownedTables } from "../ownership";
import { assertTwoUserIsolation, createTestDatabase, type TestDatabase } from "../testing";

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(() => database.close());

describe("schema ownership (ADR 0006)", () => {
	it("every table in the committed migrations is owned or allowlisted as global", async () => {
		expect(await findUnownedTables(database.db)).toEqual([]);
	});

	it("flags a user-owned table without user_id, and one whose user_id is nullable", async () => {
		await database.db.execute(sql`create table note (id serial primary key, body text)`);
		await database.db.execute(sql`create table draft (id serial primary key, user_id uuid)`);
		await database.db.execute(sql`create table owned (id serial primary key, user_id uuid not null)`);
		expect(await findUnownedTables(database.db)).toEqual(["draft", "note"]);
	});
});

describe("assertTwoUserIsolation", () => {
	it("fails when a read is not scoped to its owner", async () => {
		const rows: string[] = [];
		await expect(
			assertTwoUserIsolation({
				seed: async (owner) => void rows.push(owner),
				read: async () => rows,
			}),
		).rejects.toThrow("isolation broken");
	});

	it("fails when the read returns nothing at all, rather than passing vacuously", async () => {
		await expect(assertTwoUserIsolation({ seed: async () => {}, read: async () => [] })).rejects.toThrow("vacuous");
	});
});
