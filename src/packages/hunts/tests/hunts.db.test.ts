import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { UserId } from "../../db/ownership";
import { assertTwoUserIsolation, createTestDatabase, newUserId, type TestDatabase } from "../../db/testing";
import { listEvents } from "../../events/index";
import type { HuntInput } from "../criteria";
import { createHunt, getHunt, HUNT_SUBJECT, listHunts, setHuntStatus, updateHunt } from "../index";

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(() => database.close());

/** A User row; `users` creates real ones, here a bare row is enough for the foreign key. */
async function newUser(owner: UserId = newUserId()): Promise<UserId> {
	await database.db.execute(
		sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
	);
	return owner;
}

function input(name = "AI / Software Engineering"): HuntInput {
	return {
		name,
		criteria: {
			roles: {
				ideal: ["AI Engineer"],
				good: ["Software Engineer"],
				acceptable: [],
				unacceptable: [],
				anythingElseUnacceptable: true,
			},
			locations: {
				ideal: ["San Francisco"],
				good: [],
				acceptable: ["Remote US"],
				unacceptable: [],
				anythingElseUnacceptable: false,
			},
			payFloor: 100_000,
			experienceStretch: null,
		},
	};
}

const codes = async (owner: UserId, id: string) =>
	(await listEvents(database.db, owner, { type: HUNT_SUBJECT, id })).map((e) => [e.code, e.payload]);

describe("hunts", () => {
	it("creates an ACTIVE, AUTO Hunt with a hunt_created event", async () => {
		const owner = await newUser();
		const created = await createHunt(database.db, owner, input());
		expect(created).toMatchObject({ name: "AI / Software Engineering", status: "ACTIVE", submissionPolicy: "AUTO" });
		expect(await getHunt(database.db, owner, created.id)).toEqual(created);
		expect(await codes(owner, created.id)).toEqual([["hunt_created", {}]]);
	});

	it("writes nothing for invalid criteria", async () => {
		const owner = await newUser();
		const bad = input();
		bad.criteria.roles.unacceptable = ["ai engineer"];
		await expect(createHunt(database.db, owner, bad)).rejects.toBeInstanceOf(ZodError);
		expect(await listHunts(database.db, owner)).toEqual([]);
	});

	it("pauses and resumes with an event each; repeating a status writes none", async () => {
		const owner = await newUser();
		const { id } = await createHunt(database.db, owner, input());
		expect((await setHuntStatus(database.db, owner, id, "PAUSED"))?.status).toBe("PAUSED");
		expect((await setHuntStatus(database.db, owner, id, "PAUSED"))?.status).toBe("PAUSED");
		expect((await setHuntStatus(database.db, owner, id, "ACTIVE"))?.status).toBe("ACTIVE");
		expect((await codes(owner, id)).map(([code]) => code)).toEqual(["hunt_created", "hunt_paused", "hunt_resumed"]);
	});

	it("edits a Hunt, recording which settings changed, and nothing for an edit that changes nothing", async () => {
		const owner = await newUser();
		const { id } = await createHunt(database.db, owner, input());
		// Same values in a different key order and with untrimmed text: no change.
		const same = input(" AI / Software Engineering ");
		same.criteria = {
			experienceStretch: null,
			payFloor: 100_000,
			locations: same.criteria.locations,
			roles: same.criteria.roles,
		};
		await updateHunt(database.db, owner, id, same);

		const edited = input();
		edited.criteria.payFloor = 120_000;
		edited.creativeLatitude = "CONSERVATIVE";
		const updated = await updateHunt(database.db, owner, id, edited);
		expect(updated).toMatchObject({
			creativeLatitude: "CONSERVATIVE",
			criteria: { payFloor: 120_000 },
			status: "ACTIVE",
		});
		expect(await codes(owner, id)).toEqual([
			["hunt_created", {}],
			["hunt_edited", { changed: ["criteria", "creativeLatitude"] }],
		]);
	});

	it("lists only the owner's Hunts", async () => {
		await assertTwoUserIsolation({
			seed: async (owner) => {
				await newUser(owner);
				await createHunt(database.db, owner, input());
			},
			read: (owner) => listHunts(database.db, owner),
		});
	});

	it("never reads, edits, pauses or records events on another User's Hunt", async () => {
		const alice = await newUser();
		const bob = await newUser();
		const hunt = await createHunt(database.db, alice, input());
		expect(await getHunt(database.db, bob, hunt.id)).toBeNull();
		expect(await updateHunt(database.db, bob, hunt.id, input("Taken over"))).toBeNull();
		expect(await setHuntStatus(database.db, bob, hunt.id, "PAUSED")).toBeNull();
		expect(await getHunt(database.db, alice, hunt.id)).toEqual(hunt);
		expect(await codes(alice, hunt.id)).toEqual([["hunt_created", {}]]);
		expect(await codes(bob, hunt.id)).toEqual([]);
	});
});
