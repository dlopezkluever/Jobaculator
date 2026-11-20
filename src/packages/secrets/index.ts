import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { UserId } from "../db/ownership";
import type { Secret } from "../log/secret";

/** What a ciphertext is bound to. Opening it under any other context fails. */
export type SealContext = { owner: UserId; kind: string; rowId: string };

export type MasterKey = { version: number; key: Secret<Buffer> };

export type Secrets = {
	seal(context: SealContext, plaintext: Buffer | string): Buffer;
	open(context: SealContext, sealed: Buffer): Buffer;
};

export class SealError extends Error {
	override name = "SealError";
}

// Layout: format(1) | keyVersion(1) | nonce(12) | tag(16) | ciphertext
const FORMAT = 1;
const NONCE = 12;
const TAG = 16;
const HEADER = 2 + NONCE + TAG;

/**
 * Table-less AES-256-GCM sealing (§14). The first key seals; every key opens what it
 * sealed, so rotation adds a new first key and keeps old ones until re-sealed.
 * AAD binds each ciphertext to `(user_id, kind, row_id)`, so a ciphertext copied to
 * another row, kind or User does not open.
 */
export function createSecrets(keys: readonly MasterKey[]): Secrets {
	const current = keys[0];
	if (!current) throw new SealError("at least one master key is required");
	const byVersion = new Map<number, Buffer>();
	for (const { version, key } of keys) {
		if (!Number.isInteger(version) || version < 1 || version > 255) throw new SealError("invalid key version");
		if (key.reveal().length !== 32) throw new SealError("master key must be 32 bytes");
		byVersion.set(version, key.reveal());
	}

	return {
		seal(context, plaintext) {
			const nonce = randomBytes(NONCE);
			const cipher = createCipheriv("aes-256-gcm", current.key.reveal(), nonce);
			cipher.setAAD(aad(context));
			const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
			return Buffer.concat([Buffer.from([FORMAT, current.version]), nonce, cipher.getAuthTag(), body]);
		},
		open(context, sealed) {
			if (sealed.length < HEADER || sealed[0] !== FORMAT) throw new SealError("unrecognized sealed format");
			const key = byVersion.get(sealed[1] ?? 0);
			if (!key) throw new SealError("unknown key version");
			const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(2, 2 + NONCE));
			decipher.setAAD(aad(context));
			decipher.setAuthTag(sealed.subarray(2 + NONCE, HEADER));
			try {
				return Buffer.concat([decipher.update(sealed.subarray(HEADER)), decipher.final()]);
			} catch {
				throw new SealError("sealed value does not open under this context");
			}
		},
	};
}

function aad({ owner, kind, rowId }: SealContext): Buffer {
	return Buffer.from(JSON.stringify([owner, kind, rowId]), "utf8");
}
