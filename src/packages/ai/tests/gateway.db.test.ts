import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { UserId } from "../../db/ownership";
import { assertTwoUserIsolation, createTestDatabase, type TestDatabase } from "../../db/testing";
import {
	BudgetExceeded,
	createLlmClient,
	type FetchLike,
	getAiSettings,
	KeyValidationError,
	LiveCallBlocked,
	LlmError,
	listProviderKeys,
	NoViableRoute,
	purgeExpiredPayloads,
	saveProviderKey,
	updateAiSettings,
} from "../index";
import { anthropicError, anthropicReply, client, ledger, newUser, openaiReply, secrets } from "./helpers";
import { replayFetch } from "./replay";

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(() => database.close());

const ask = (owner: UserId) => ({
	task: "extract" as const,
	attribution: { userId: owner },
	messages: [{ role: "user" as const, content: "Extract the facts." }],
});
const modelsSent = (fetch: { requests: readonly { body: unknown }[] }) =>
	fetch.requests.map((r) => (r.body as { model: string }).model);

describe("routing", () => {
	it("routes by task, re-reading the preset and per-task override on every call", async () => {
		const owner = await newUser(database.db, ["anthropic", "openai"]);
		const fetch = replayFetch(["a", "b", "c", "d"].map((text) => anthropicReply(text)));
		const llm = client(database.db, fetch);

		await llm.generate(ask(owner));
		await updateAiSettings(database.db, owner, { preset: "best" });
		await llm.generate(ask(owner));
		await updateAiSettings(database.db, owner, { taskPresets: { extract: "economy" } });
		await llm.generate(ask(owner));
		await llm.generate({ ...ask(owner), task: "write" });

		expect(modelsSent(fetch)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"]);
	});
});

describe("failures and fallback", () => {
	it("retries a transient failure twice in-call; refused attempts cost nothing", async () => {
		const owner = await newUser(database.db, ["anthropic", "openai"]);
		const fetch = replayFetch([
			anthropicError(429, "rate_limit_error"),
			anthropicError(529, "overloaded_error"),
			anthropicReply("ok"),
		]);
		const result = await client(database.db, fetch).generate(ask(owner));

		expect(result.text).toBe("ok");
		expect((await ledger(database.db, owner)).map((r) => [r.model, r.outcome, r.measured])).toEqual([
			["claude-haiku-5-5", "rate_limited", 0],
			["claude-haiku-5-5", "overloaded", 0],
			["claude-haiku-5-5", "ok", 20],
		]);
	});

	it("after the retries, marks the scope unhealthy for every process and falls back to the next route", async () => {
		const owner = await newUser(database.db, ["anthropic", "openai"]);
		const first = replayFetch([
			anthropicError(429, "rate_limit_error"),
			anthropicError(429, "rate_limit_error"),
			anthropicError(429, "rate_limit_error"),
			openaiReply("from openai"),
		]);
		expect((await client(database.db, first).generate(ask(owner))).provider).toBe("openai");
		expect(modelsSent(first)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", "claude-haiku-5-5", "gpt-6.1-sol"]);

		// Another client (another process) skips the cooling-down model without calling it.
		const second = replayFetch([openaiReply("again")]);
		expect((await client(database.db, second).generate(ask(owner))).text).toBe("again");
		expect(modelsSent(second)).toEqual(["gpt-6.1-sol"]);
		// Only that model cools down: another task on another Anthropic model still goes to Anthropic.
		const third = replayFetch([anthropicReply("sonnet")]);
		await client(database.db, third).generate({ ...ask(owner), task: "write" });
		expect(modelsSent(third)).toEqual(["claude-sonnet-5-5"]);
	});

	it("scopes a permission error to the model and an auth error to the key", async () => {
		const owner = await newUser(database.db, ["anthropic"]);
		const fetch = replayFetch([
			anthropicError(403, "permission_error"),
			anthropicReply("sonnet works"),
			anthropicError(401, "authentication_error"),
		]);
		const llm = client(database.db, fetch);

		const denied = await llm.generate(ask(owner)).catch((e: unknown) => e);
		expect(denied).toBeInstanceOf(NoViableRoute);
		expect((denied as NoViableRoute).failures[0]).toMatchObject({ kind: "shared", scope: "model" });
		// The key still works for other models: a permission error never invalidates it.
		expect((await llm.generate({ ...ask(owner), task: "write" })).text).toBe("sonnet works");

		const unauthorised = await llm.generate({ ...ask(owner), task: "answer" }).catch((e: unknown) => e);
		expect(unauthorised).toBeInstanceOf(NoViableRoute);
		// Both routes of the chain are named: the bad Anthropic key and the missing OpenAI one.
		expect([...(unauthorised as NoViableRoute).scopes].sort()).toEqual(["key:anthropic", "key:openai"]);
		expect((unauthorised as NoViableRoute).failures[0]).toMatchObject({
			kind: "shared",
			scope: "key",
			fingerprint: { task: "answer", provider: "anthropic", model: "claude-sonnet-5-5", errorClass: "auth" },
		});
		expect(fetch.remaining()).toBe(0);
	});

	it("repairs a schema violation once, then tries the next stronger model once, then fails deterministically", async () => {
		const owner = await newUser(database.db, ["anthropic", "openai"]);
		const output = z.object({ fit: z.number().int().min(0).max(100) });
		const repaired = replayFetch([
			anthropicReply('{"fit": 140}'),
			anthropicReply("not json"),
			anthropicReply('{"fit": 82}', { model: "claude-sonnet-5-5" }),
		]);
		const result = await client(database.db, repaired).generate({ ...ask(owner), task: "score", output });
		expect(result).toMatchObject({ output: { fit: 82 }, model: "claude-sonnet-5-5" });
		expect(modelsSent(repaired)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"]);
		const repairRequest = repaired.requests[1]?.body as { messages: Array<{ role: string; content: string }> };
		expect(repairRequest.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(repairRequest.messages[2]?.content).toContain("fit:");

		const hopeless = replayFetch(Array.from({ length: 4 }, () => anthropicReply('{"fit": "high"}')));
		const failure = await client(database.db, hopeless)
			.generate({ ...ask(owner), task: "score", output })
			.catch((e: unknown) => e);
		// No fallback to OpenAI for a deterministic failure: exactly four Anthropic calls.
		expect(failure).toBeInstanceOf(LlmError);
		expect(failure).not.toBeInstanceOf(NoViableRoute);
		expect(failure).toMatchObject({ kind: "deterministic", fingerprint: { errorClass: "schema_violation" } });
		expect((failure as LlmError).fingerprint.schemaHash).toMatch(/^[0-9a-f]{16}$/);
		expect(modelsSent(hopeless)).toEqual([
			"claude-haiku-5-5",
			"claude-haiku-5-5",
			"claude-sonnet-5-5",
			"claude-sonnet-5-5",
		]);
	});

	it("escalates a truncated reply to the next stronger model", async () => {
		const owner = await newUser(database.db, ["anthropic"]);
		const fetch = replayFetch([
			anthropicReply("cut off", { stop: "max_tokens" }),
			anthropicReply("complete", { model: "claude-sonnet-5-5" }),
		]);
		expect((await client(database.db, fetch).generate(ask(owner))).text).toBe("complete");
		expect(modelsSent(fetch)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
	});

	it("refuses live calls in tests unless LLM_LIVE=1, without retrying or charging them", async () => {
		const owner = await newUser(database.db, ["anthropic", "openai"]);
		const llm = createLlmClient({ db: database.db, secrets });
		await expect(llm.generate(ask(owner))).rejects.toBeInstanceOf(LiveCallBlocked);
		expect((await ledger(database.db, owner)).map((r) => [r.outcome, r.measured])).toEqual([["blocked", 0]]);
	});
});

describe("budget", () => {
	/** The reservation one `ask` call makes, measured on a throwaway User. */
	async function reservationForAsk(): Promise<number> {
		const probe = await newUser(database.db, ["anthropic"]);
		await client(database.db, replayFetch([anthropicReply("probe")])).generate(ask(probe));
		const [row] = await ledger(database.db, probe);
		return row?.reserved ?? 0;
	}

	it("throws BudgetExceeded before calling any provider, and fallback never bypasses the cap", async () => {
		const owner = await newUser(database.db, ["anthropic", "openai"]);
		await updateAiSettings(database.db, owner, { dailyCapUsd: 0.001 });
		const fetch = replayFetch([]);
		const failure = await client(database.db, fetch)
			.generate(ask(owner))
			.catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(BudgetExceeded);
		expect(failure).toMatchObject({ kind: "shared", scope: "budget", capUsd: 0.001, spentUsd: 0 });
		expect(fetch.requests).toHaveLength(0);
		expect(await ledger(database.db, owner)).toEqual([]);
	});

	it("counts a finalised call at its measured cost, and a crashed one at its reservation", async () => {
		const reserved = await reservationForAsk();
		const owner = await newUser(database.db, ["anthropic"]);
		// Room for one reservation: once the first call finalises at 20 micro-USD, a second fits too.
		await updateAiSettings(database.db, owner, { dailyCapUsd: (reserved + 100) / 1e6 });
		const fetch = replayFetch([anthropicReply("one"), anthropicReply("two")]);
		await client(database.db, fetch).generate(ask(owner));
		await client(database.db, fetch).generate(ask(owner));
		expect((await getAiSettings(database.db, owner)).spentTodayUsd).toBeCloseTo(40 / 1e6, 9);

		// A network failure may have been billed: it keeps its reservation, labelled unknown.
		const crasher = await newUser(database.db, ["anthropic"]);
		const offline: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
		await expect(client(database.db, offline).generate(ask(crasher))).rejects.toBeInstanceOf(NoViableRoute);
		const rows = await ledger(database.db, crasher);
		expect(rows.map((r) => [r.outcome, r.measured])).toEqual([
			["unknown", null],
			["unknown", null],
			["unknown", null],
		]);
		expect((await getAiSettings(database.db, crasher)).spentTodayUsd).toBeCloseTo((3 * reserved) / 1e6, 9);
	});

	it("never lets parallel reservations for one User exceed the cap", async () => {
		const reserved = await reservationForAsk();
		const owner = await newUser(database.db, ["anthropic"]);
		const cap = 5 * reserved + Math.floor(reserved / 2);
		await updateAiSettings(database.db, owner, { dailyCapUsd: cap / 1e6 });

		// Admitted calls wait inside fetch, so every reservation is still open while the others check.
		let entered = 0;
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reply = anthropicReply("ok").response;
		const gated: FetchLike = async () => {
			entered++;
			await gate;
			return new Response(JSON.stringify(reply.body), { status: 200, headers: { "content-type": "application/json" } });
		};
		const llm = client(database.db, gated);
		let refused = 0;
		const calls = Array.from({ length: 20 }, () =>
			llm.generate(ask(owner)).catch((error: unknown) => {
				if (error instanceof BudgetExceeded) refused++;
				throw error;
			}),
		);
		const settled = Promise.allSettled(calls);
		await vi.waitFor(() => expect(entered + refused).toBe(20), { timeout: 10_000 });

		expect(entered).toBe(5);
		const open = await ledger(database.db, owner);
		expect(open.reduce((sum, row) => sum + row.reserved, 0)).toBeLessThanOrEqual(cap);
		release();
		expect((await settled).filter((s) => s.status === "fulfilled")).toHaveLength(5);
	});
});

describe("ledger", () => {
	it("is append-only once finalised, and drops payloads after 14 days while keeping the row", async () => {
		const owner = await newUser(database.db, ["anthropic"]);
		await client(database.db, replayFetch([anthropicReply("kept")])).generate(ask(owner));

		await expect(database.db.execute(sql`delete from ai_call where user_id = ${owner}`)).rejects.toThrow();
		await expect(
			database.db.execute(sql`update ai_call set measured_micro_usd = 0 where user_id = ${owner}`),
		).rejects.toThrow();

		const payload = await database.db.execute<{ request: { messages: unknown[] }; response: { text: string } }>(
			sql`select request, response from ai_call_payload where user_id = ${owner}`,
		);
		expect(payload.rows[0]?.response.text).toBe("kept");
		await database.db.execute(
			sql`update ai_call_payload set created_at = now() - interval '15 days' where user_id = ${owner}`,
		);
		expect(await purgeExpiredPayloads(database.db)).toBe(1);
		expect(await ledger(database.db, owner)).toHaveLength(1);
	});
});

describe("provider keys", () => {
	it("validates lightly, never returns the key, and replaces it in place", async () => {
		const owner = await newUser(database.db, []);
		await expect(saveProviderKey(database.db, secrets, owner, "anthropic", "hello")).rejects.toBeInstanceOf(
			KeyValidationError,
		);
		await expect(
			saveProviderKey(database.db, secrets, owner, "anthropic", "sk-openai-shaped-0000000000000000"),
		).rejects.toThrow("sk-ant-");

		const key = "sk-ant-api03-secretsecretsecretsecret-WXYZ";
		const saved = await saveProviderKey(database.db, secrets, owner, "anthropic", `  ${key}\n`);
		expect(saved).toMatchObject({ provider: "anthropic", last4: "WXYZ" });
		const stored = await database.db.execute<{ sealed: Buffer }>(
			sql`select sealed from provider_key where user_id = ${owner}`,
		);
		expect(stored.rows[0]?.sealed.includes(Buffer.from("secretsecret"))).toBe(false);

		const replacement = "sk-ant-api03-anotheranotheranother-abcd";
		await saveProviderKey(database.db, secrets, owner, "anthropic", replacement);
		const listed = await listProviderKeys(database.db, owner);
		expect(listed.map((k) => [k.provider, k.last4])).toEqual([["anthropic", "abcd"]]);
		expect(JSON.stringify(listed)).not.toContain("another");

		// The replacement opens under its new row id and is what the provider receives.
		const fetch = replayFetch([anthropicReply("ok")]);
		await client(database.db, fetch).generate(ask(owner));
		expect(fetch.requests[0]?.headers.get("authorization")).toBe(`Bearer ${replacement}`);
	});

	it("lists only its owner's keys", async () => {
		await assertTwoUserIsolation({
			seed: async (owner) => {
				await database.db.execute(
					sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`,
				);
				await saveProviderKey(database.db, secrets, owner, "openai", "sk-proj-0000000000000000000000000000");
			},
			read: (owner) => listProviderKeys(database.db, owner),
		});
	});
});
