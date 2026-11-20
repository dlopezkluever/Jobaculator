import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../../db/index";
import { newUserId } from "../../db/testing";
import { Secret } from "../../log/secret";
import { createSecrets } from "../../secrets/index";
import { createLlmClient, type FetchLike, type Provider, saveProviderKey } from "../index";
import { recording } from "./replay";

export const secrets = createSecrets([{ version: 1, key: new Secret(randomBytes(32)) }]);

// Fake keys in replay; real ones only when re-recording fixtures (`pnpm test:record-llm`).
export const KEYS: Record<Provider, string> = {
	anthropic: recording ? (process.env.ANTHROPIC_API_KEY ?? "") : "sk-ant-test-00000000000000000000000AnTk",
	openai: recording ? (process.env.OPENAI_API_KEY ?? "") : "sk-test-0000000000000000000000000000OaIk",
};

/** A fresh User (a bare row is enough for the foreign keys) with keys for `providers`. */
export async function newUser(db: Db, providers: readonly Provider[]) {
	const owner = newUserId();
	await db.execute(sql`insert into "user" (id, name, email) values (${owner}, 'x', ${`${owner}@example.com`})`);
	for (const provider of providers) await saveProviderKey(db, secrets, owner, provider, KEYS[provider]);
	return owner;
}

export function client(db: Db, fetch: FetchLike) {
	return createLlmClient({ db, secrets, fetch, retryDelaysMs: [0, 0] });
}

export type LedgerRow = {
	provider: string;
	model: string;
	task: string;
	reserved: number;
	measured: number | null;
	outcome: string | null;
	error_kind: string | null;
	error_scope: string | null;
	application_id: string | null;
	hunt_id: string | null;
	request_id: string | null;
	price_table_version: string;
};

export async function ledger(db: Db, owner: string): Promise<LedgerRow[]> {
	const result = await db.execute<LedgerRow>(sql`
		select provider, model, task, reserved_micro_usd::int as reserved, measured_micro_usd::int as measured,
			outcome, error_kind, error_scope, application_id, hunt_id, request_id, price_table_version
		from ai_call where user_id = ${owner} order by started_at, id
	`);
	return result.rows;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/responses";

type Tokens = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

/** An Anthropic Messages API reply, as the API sends it. */
export function anthropicReply(text: string, options: { model?: string; stop?: string; usage?: Tokens } = {}) {
	const usage = options.usage ?? {};
	return {
		request: { method: "POST", url: ANTHROPIC_URL },
		response: {
			status: 200,
			headers: { "request-id": `req_${randomBytes(6).toString("hex")}` },
			body: {
				id: `msg_${randomBytes(6).toString("hex")}`,
				type: "message",
				role: "assistant",
				model: options.model ?? "claude-haiku-5-5",
				content: [{ type: "text", text }],
				stop_reason: options.stop ?? "end_turn",
				stop_sequence: null,
				usage: {
					input_tokens: usage.input ?? 100,
					output_tokens: usage.output ?? 20,
					cache_creation_input_tokens: usage.cacheWrite ?? 0,
					cache_read_input_tokens: usage.cacheRead ?? 0,
				},
			},
		},
	};
}

export function anthropicError(status: number, type: string) {
	return {
		request: { method: "POST", url: ANTHROPIC_URL },
		response: { status, body: { type: "error", error: { type, message: `scripted ${type}` } } },
	};
}

/** An OpenAI Responses API reply, as the API sends it. */
export function openaiReply(text: string, options: { model?: string; usage?: Tokens } = {}) {
	const usage = options.usage ?? {};
	const input = usage.input ?? 100;
	return {
		request: { method: "POST", url: OPENAI_URL },
		response: {
			status: 200,
			headers: { "x-request-id": `req_${randomBytes(6).toString("hex")}` },
			body: {
				id: `resp_${randomBytes(6).toString("hex")}`,
				object: "response",
				created_at: 1795000000,
				status: "completed",
				model: options.model ?? "gpt-6.1-sol",
				incomplete_details: null,
				output: [
					{
						type: "message",
						id: "msg_1",
						status: "completed",
						role: "assistant",
						content: [{ type: "output_text", text, annotations: [] }],
					},
				],
				usage: {
					input_tokens: input,
					input_tokens_details: { cached_tokens: usage.cacheRead ?? 0, cache_write_tokens: usage.cacheWrite ?? 0 },
					output_tokens: usage.output ?? 20,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: input + (usage.output ?? 20),
				},
			},
		},
	};
}

export function openaiError(status: number, code: string | null = null) {
	return {
		request: { method: "POST", url: OPENAI_URL },
		response: { status, body: { error: { message: "scripted", type: "error", code, param: null } } },
	};
}
