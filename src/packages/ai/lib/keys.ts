import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../../db/index";
import type { UserId } from "../../db/ownership";
import type { Secrets } from "../../secrets/index";
import { providerKey } from "./schema";
import type { Provider } from "./types";

const SEAL_KIND = "provider_key";

/** Light format checks on save (§12): no live call; a key that stops working fails on use. */
const KEY_FORMATS: Record<Provider, { pattern: RegExp; hint: string }> = {
	anthropic: { pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/, hint: "an Anthropic key starts with sk-ant-" },
	openai: { pattern: /^sk-[A-Za-z0-9_-]{20,}$/, hint: "an OpenAI key starts with sk-" },
};

export class KeyValidationError extends Error {
	override name = "KeyValidationError";
}

export type ProviderKeySummary = { provider: Provider; last4: string; updatedAt: Date };

/** Seals and stores (or replaces) the User's key for one provider. The key is never returned or logged. */
export async function saveProviderKey(
	exec: Executor,
	secrets: Secrets,
	owner: UserId,
	provider: Provider,
	rawKey: string,
): Promise<ProviderKeySummary> {
	const key = rawKey.trim();
	const format = KEY_FORMATS[provider];
	// The message names the rule, never the value.
	if (!format.pattern.test(key)) throw new KeyValidationError(`this does not look like a valid key: ${format.hint}`);
	const id = randomUUID();
	const last4 = key.slice(-4);
	const sealed = secrets.seal({ owner, kind: SEAL_KIND, rowId: id }, key);
	const [row] = await exec
		.insert(providerKey)
		.values({ id, userId: owner, provider, sealed, last4 })
		// The row id is part of the seal context, so a replaced key takes the new id with it.
		.onConflictDoUpdate({
			target: [providerKey.userId, providerKey.provider],
			set: { id, sealed, last4, updatedAt: sql`now()` },
		})
		.returning({ updatedAt: providerKey.updatedAt });
	if (!row) throw new Error("the provider key was not saved");
	return { provider, last4, updatedAt: row.updatedAt };
}

export async function listProviderKeys(exec: Executor, owner: UserId): Promise<ProviderKeySummary[]> {
	const rows = await exec
		.select({ provider: providerKey.provider, last4: providerKey.last4, updatedAt: providerKey.updatedAt })
		.from(providerKey)
		.where(eq(providerKey.userId, owner))
		.orderBy(providerKey.provider);
	return rows.map((row) => ({ ...row, provider: row.provider as Provider }));
}

export async function removeProviderKey(exec: Executor, owner: UserId, provider: Provider): Promise<void> {
	await exec.delete(providerKey).where(and(eq(providerKey.userId, owner), eq(providerKey.provider, provider)));
}

/**
 * The User's keys as SDK `apiKey` setters, by provider. The sealed bytes are read now;
 * each is opened only when its SDK sends a request, and the plaintext is not kept.
 */
export async function loadKeySetters(
	exec: Executor,
	secrets: Secrets,
	owner: UserId,
): Promise<Map<Provider, () => Promise<string>>> {
	const rows = await exec
		.select({ id: providerKey.id, provider: providerKey.provider, sealed: providerKey.sealed })
		.from(providerKey)
		.where(eq(providerKey.userId, owner));
	return new Map(
		rows.map((row) => [
			row.provider as Provider,
			async () => secrets.open({ owner, kind: SEAL_KIND, rowId: row.id }, row.sealed).toString("utf8"),
		]),
	);
}
