import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { type FetchLike, LiveCallBlocked } from "../index";

/**
 * Record/replay `fetch` for adapter tests (§12). Replay serves a fixture's interactions in
 * order and fails on any request that differs from the recorded one, so a fixture pins
 * both what we send and what we parse. `pnpm test:record-llm` re-records them live.
 */

export type Interaction = {
	request: { method: string; url: string; body?: unknown };
	response: { status: number; headers?: Record<string, string>; body: unknown };
};

export type Fixture = { note?: string; recordedAt?: string; interactions: Interaction[] };

export type CapturedRequest = { method: string; url: string; headers: Headers; body: unknown };

export type ReplayFetch = FetchLike & {
	readonly requests: readonly CapturedRequest[];
	remaining(): number;
	/** In record mode, writes what was recorded; in replay mode, a no-op. */
	save(): void;
};

/** A request with no matching fixture is treated as a live call, which tests never make. */
export class FixtureMismatch extends LiveCallBlocked {
	override name = "FixtureMismatch";
}

const KEPT_HEADERS = ["content-type", "request-id", "x-request-id"];
const KEY_PATTERN = /sk-[A-Za-z0-9_-]{8,}/g;

export const recording = process.env.LLM_RECORD === "1";

async function capture(input: string | URL | Request, init?: RequestInit): Promise<CapturedRequest> {
	const request = new Request(input, init);
	const text = await request.text();
	let body: unknown = text;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {}
	return { method: request.method, url: request.url, headers: request.headers, body };
}

function toResponse({ status, headers, body }: Interaction["response"]): Response {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

/** Replays in-memory interactions, in order. A missing `request.body` matches any body. */
export function replayFetch(interactions: readonly Interaction[]): ReplayFetch {
	const queue = [...interactions];
	const requests: CapturedRequest[] = [];
	const replay = async (input: string | URL | Request, init?: RequestInit) => {
		const request = await capture(input, init);
		requests.push(request);
		const next = queue.shift();
		if (!next) throw new FixtureMismatch(`unexpected request ${request.method} ${request.url}: no interaction left`);
		if (next.request.method !== request.method || next.request.url !== request.url) {
			throw new FixtureMismatch(
				`expected ${next.request.method} ${next.request.url}, got ${request.method} ${request.url}`,
			);
		}
		if (next.request.body !== undefined && !isDeepStrictEqual(next.request.body, request.body)) {
			throw new FixtureMismatch(
				`request body differs from the fixture:\n${JSON.stringify(request.body)}\n!==\n${JSON.stringify(next.request.body)}`,
			);
		}
		return toResponse(next.response);
	};
	return Object.assign(replay, { requests, remaining: () => queue.length, save() {} });
}

/**
 * A fixture file in `tests/fixtures/`. Replays it, or with `LLM_RECORD=1` (and `LLM_LIVE=1`)
 * calls the real provider and records a key-scrubbed copy: no request headers, only
 * `content-type` and request ids from the response, and any `sk-…` string replaced.
 */
export function fixtureFetch(name: string): ReplayFetch {
	const path = new URL(`./fixtures/${name}.json`, import.meta.url);
	if (!recording) return replayFetch((JSON.parse(readFileSync(path, "utf8")) as Fixture).interactions);

	if (process.env.LLM_LIVE !== "1") throw new Error("LLM_RECORD=1 makes live calls: set LLM_LIVE=1 as well");
	const interactions: Interaction[] = [];
	const requests: CapturedRequest[] = [];
	const record = async (input: string | URL | Request, init?: RequestInit) => {
		const request = await capture(input, init);
		requests.push(request);
		const response = await fetch(input, init);
		const text = await response.clone().text();
		let body: unknown = text;
		try {
			body = JSON.parse(text);
		} catch {}
		const headers: Record<string, string> = {};
		for (const header of KEPT_HEADERS) {
			const value = response.headers.get(header);
			if (value) headers[header] = value;
		}
		interactions.push({
			request: { method: request.method, url: request.url, body: request.body },
			response: { status: response.status, headers, body },
		});
		return response;
	};
	return Object.assign(record, {
		requests,
		remaining: () => 0,
		save() {
			const fixture: Fixture = { recordedAt: new Date().toISOString(), interactions };
			writeFileSync(path, `${JSON.stringify(fixture, null, "\t").replace(KEY_PATTERN, "sk-REDACTED")}\n`);
		},
	});
}
