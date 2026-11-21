import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { Executor } from "../db/index";
import { blob } from "./lib/schema";

/** SHA-256 of a blob's bytes, lowercase hex. */
export type BlobHash = string & { readonly __brand: "BlobHash" };

/** §13 retention classes. */
export type RetentionClass = "permanent" | "case_evidence" | "diagnostics";

export type BlobInfo = {
	hash: BlobHash;
	size: number;
	mediaType: string;
	retentionClass: RetentionClass;
	createdAt: Date;
};

export type Storage = {
	/**
	 * Writes the bytes durably (temp → fsync → rename → dir fsync), then inserts the
	 * `blob` row through `exec`, so the caller's commit of the referencing row comes
	 * after the file is on disk. Identical bytes resolve to the same blob.
	 */
	put(exec: Executor, bytes: Buffer, meta: { mediaType: string; retentionClass: RetentionClass }): Promise<BlobHash>;
	get(hash: BlobHash): Promise<Buffer>;
	/** A local file path for consumers that need one, such as Playwright uploads. Never write to it. */
	openLocalPath(hash: BlobHash): string;
	stat(exec: Executor, hash: BlobHash): Promise<BlobInfo | null>;
};

const HASH = /^[0-9a-f]{64}$/;

export function parseBlobHash(value: string): BlobHash {
	if (!HASH.test(value)) throw new Error("invalid blob hash");
	return value as BlobHash;
}

/** Content-addressed, immutable blobs on local disk under `root` (§13). */
export function createStorage(root: string): Storage {
	const pathOf = (hash: BlobHash) => join(root, "blobs", hash.slice(0, 2), hash.slice(2, 4), parseBlobHash(hash));

	return {
		async put(exec, bytes, meta) {
			const hash = createHash("sha256").update(bytes).digest("hex") as BlobHash;
			const target = pathOf(hash);
			const dir = dirname(target);
			await mkdir(dir, { recursive: true });
			const temp = join(dir, `.tmp-${randomUUID()}`);
			try {
				// Group-readable: `web` writes uploads that `worker`, another OS user in the shared group, reads.
				const file = await open(temp, "wx", 0o640);
				try {
					await file.writeFile(bytes);
					await file.sync();
				} finally {
					await file.close();
				}
				await rename(temp, target);
			} catch (error) {
				await rm(temp, { force: true });
				throw error;
			}
			const dirHandle = await open(dir, "r");
			try {
				await dirHandle.sync();
			} finally {
				await dirHandle.close();
			}
			await exec
				.insert(blob)
				.values({ hash, size: bytes.length, mediaType: meta.mediaType, retentionClass: meta.retentionClass })
				.onConflictDoNothing();
			return hash;
		},
		get: (hash) => readFile(pathOf(hash)),
		openLocalPath: pathOf,
		async stat(exec, hash) {
			const [row] = await exec.select().from(blob).where(eq(blob.hash, hash));
			return row ? { ...row, hash: row.hash as BlobHash, retentionClass: row.retentionClass as RetentionClass } : null;
		},
	};
}
