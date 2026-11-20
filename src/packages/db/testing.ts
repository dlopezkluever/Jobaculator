import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDatabase, type Database, migrateDatabase } from "./index";
import type { UserId } from "./ownership";

/** Test-only helpers. DB integration tests need Postgres 18 (`.agents/setup` in an orb, a service in CI). */

export const TEMPLATE_DATABASE = "jobaculator_test_template";

export function adminUrl(): string {
	return process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/postgres";
}

function urlFor(name: string): string {
	const url = new URL(adminUrl());
	url.pathname = `/${name}`;
	return url.toString();
}

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: adminUrl() });
	await client.connect();
	try {
		return await run(client);
	} finally {
		await client.end();
	}
}

/** Recreates the migrated template database. Run once per test run (Vitest globalSetup). */
export async function prepareTemplateDatabase(migrationsFolder: string): Promise<void> {
	await admin(async (client) => {
		await client.query(`drop database if exists ${TEMPLATE_DATABASE} with (force)`);
		await client.query(`create database ${TEMPLATE_DATABASE}`);
	});
	await migrateDatabase(urlFor(TEMPLATE_DATABASE), migrationsFolder);
}

export type TestDatabase = Database & { url: string };

/** A fresh, migrated database of its own, copied from the template. `close()` drops it. */
export async function createTestDatabase(): Promise<TestDatabase> {
	const name = `jobaculator_test_${randomUUID().replaceAll("-", "")}`;
	await admin((client) => client.query(`create database ${name} template ${TEMPLATE_DATABASE}`));
	const url = urlFor(name);
	const database = createDatabase(url);
	return {
		url,
		db: database.db,
		async close() {
			await database.close();
			await admin((client) => client.query(`drop database if exists ${name} with (force)`));
		},
	};
}

export function newUserId(): UserId {
	return randomUUID() as UserId;
}

/**
 * The shared two-user isolation check (ADR 0006). `seed(owner)` creates that User's
 * records through the module's interface; `read(owner)` reads what that User can see.
 * Fails if one User's read returns anything seeded for the other.
 */
export async function assertTwoUserIsolation<T>(check: {
	seed(owner: UserId): Promise<void>;
	read(owner: UserId): Promise<readonly T[]>;
}): Promise<void> {
	const alice = newUserId();
	const bob = newUserId();
	await check.seed(alice);
	const aliceAlone = await check.read(alice);
	if (aliceAlone.length === 0) throw new Error("isolation check is vacuous: read(owner) returned nothing it seeded");
	const bobBefore = await check.read(bob);
	if (bobBefore.length > 0)
		throw new Error(`isolation broken: one User reads ${bobBefore.length} of another's records`);
	await check.seed(bob);
	const aliceAfter = await check.read(alice);
	if (aliceAfter.length !== aliceAlone.length) {
		throw new Error("isolation broken: another User's records appear in this User's read");
	}
}
