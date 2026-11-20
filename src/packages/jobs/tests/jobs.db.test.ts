import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { UserId } from "../../db/ownership";
import { createTestDatabase, newUserId, type TestDatabase } from "../../db/testing";
import { createJobs, defineQueue, type Jobs } from "../index";

const ingest = defineQueue("test_ingest", { postingId: z.string() });

let database: TestDatabase;
let jobs: Jobs;
beforeAll(async () => {
	database = await createTestDatabase();
	jobs = createJobs({ databaseUrl: database.url, queues: [ingest] });
	await jobs.start();
});
afterAll(async () => {
	await jobs.stop({ timeoutMs: 1000 });
	await database.close();
});

describe("jobs", () => {
	it("refuses a payload without a valid userId", async () => {
		await expect(jobs.send(ingest, { postingId: "p" } as never)).rejects.toThrow();
		await expect(jobs.send(ingest, { userId: "not-a-uuid" as UserId, postingId: "p" })).rejects.toThrow();
	});

	it("enqueues inside the caller's transaction and delivers validated payloads", async () => {
		const owner = newUserId();
		await expect(
			database.db.transaction(async (tx) => {
				await jobs.send(ingest, { userId: owner, postingId: "rolled-back" }, { tx });
				throw new Error("state change failed");
			}),
		).rejects.toThrow("state change failed");
		await database.db.transaction((tx) => jobs.send(ingest, { userId: owner, postingId: "committed" }, { tx }));

		const received: string[] = [];
		const done = new Promise<void>((resolve) => {
			void jobs.work(ingest, async (payload) => {
				expect(payload.userId).toBe(owner);
				received.push(payload.postingId);
				resolve();
			});
		});
		await done;
		// Give a rolled-back job (if it wrongly existed) a chance to arrive too.
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(received).toEqual(["committed"]);
	});
});
