import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../db/testing";
import { createStorage, parseBlobHash } from "../index";

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(() => database.close());

const meta = { mediaType: "application/pdf", retentionClass: "permanent" } as const;

describe("storage", () => {
	it("stores bytes under their SHA-256 and records a blob row", async () => {
		const storage = createStorage(mkdtempSync(join(tmpdir(), "blobs-")));
		const bytes = Buffer.from("%PDF-1.7 resume");
		const hash = await storage.put(database.db, bytes, meta);

		expect(hash).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect((await storage.get(hash)).equals(bytes)).toBe(true);
		expect(readFileSync(storage.openLocalPath(hash)).equals(bytes)).toBe(true);
		expect(await storage.stat(database.db, hash)).toMatchObject({ hash, size: bytes.length, ...meta });
		expect(readdirSync(dirname(storage.openLocalPath(hash))).filter((f) => f.startsWith(".tmp"))).toEqual([]);
	});

	it("resolves identical bytes to one blob", async () => {
		const storage = createStorage(mkdtempSync(join(tmpdir(), "blobs-")));
		const bytes = Buffer.from("same bytes");
		const first = await storage.put(database.db, bytes, meta);
		const second = await storage.put(database.db, bytes, { ...meta, retentionClass: "diagnostics" });
		expect(second).toBe(first);
		expect((await storage.stat(database.db, first))?.retentionClass).toBe("permanent");
	});

	it("has the file on disk before the row commits, and no row when the caller rolls back", async () => {
		const storage = createStorage(mkdtempSync(join(tmpdir(), "blobs-")));
		const bytes = Buffer.from("rolled back");
		const hash = parseBlobHash(createHash("sha256").update(bytes).digest("hex"));
		await expect(
			database.db.transaction(async (tx) => {
				await storage.put(tx, bytes, meta);
				expect(existsSync(storage.openLocalPath(hash))).toBe(true);
				expect(await storage.stat(database.db, hash)).toBeNull();
				throw new Error("referencing row failed");
			}),
		).rejects.toThrow("referencing row failed");
		expect(await storage.stat(database.db, hash)).toBeNull();
	});

	it("refuses paths that are not blob hashes", () => {
		const storage = createStorage(mkdtempSync(join(tmpdir(), "blobs-")));
		expect(() => storage.openLocalPath("../../etc/passwd" as never)).toThrow("invalid blob hash");
	});
});
