import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { UserId } from "../../db/ownership";
import { Secret } from "../../log/secret";
import { createSecrets, type SealContext } from "../index";

const key = (version: number) => ({ version, key: new Secret(randomBytes(32)) });
const alice = "11111111-1111-4111-8111-111111111111" as UserId;
const bob = "22222222-2222-4222-8222-222222222222" as UserId;
const context: SealContext = { owner: alice, kind: "provider_key", rowId: "row-1" };

describe("secrets", () => {
	it("opens what it sealed, and the ciphertext does not contain the plaintext", () => {
		const secrets = createSecrets([key(1)]);
		const sealed = secrets.seal(context, "sk-live-abcdef");
		expect(sealed.includes(Buffer.from("sk-live-abcdef"))).toBe(false);
		expect(secrets.open(context, sealed).toString()).toBe("sk-live-abcdef");
	});

	it("uses a fresh nonce each time", () => {
		const secrets = createSecrets([key(1)]);
		expect(secrets.seal(context, "x").equals(secrets.seal(context, "x"))).toBe(false);
	});

	it.each([
		["another User", { ...context, owner: bob }],
		["another kind", { ...context, kind: "mailbox" }],
		["another row", { ...context, rowId: "row-2" }],
		// A naive "user|kind|row" join would make these two contexts collide.
		["a shifted separator", { ...context, kind: "provider_key|row", rowId: "1" }],
	])("refuses to open under %s", (_label, other) => {
		const secrets = createSecrets([key(1)]);
		const sealed = secrets.seal(context, "value");
		expect(() => secrets.open(other, sealed)).toThrow("does not open");
	});

	it("rejects a tampered ciphertext", () => {
		const secrets = createSecrets([key(1)]);
		const sealed = secrets.seal(context, "value");
		sealed[sealed.length - 1] = (sealed.at(-1) ?? 0) ^ 1;
		expect(() => secrets.open(context, sealed)).toThrow("does not open");
	});

	it("seals with the first key and still opens values sealed under an older version", () => {
		const v1 = key(1);
		const v2 = key(2);
		const old = createSecrets([v1]).seal(context, "old");
		const rotated = createSecrets([v2, v1]);
		expect(rotated.open(context, old).toString()).toBe("old");
		const fresh = rotated.seal(context, "new");
		expect(fresh[1]).toBe(2);
		expect(() => createSecrets([v1]).open(context, fresh)).toThrow("unknown key version");
	});
});
