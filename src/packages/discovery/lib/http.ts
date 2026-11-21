import type { ListingFailure } from "./types";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Generic product User-Agent: never the Candidate's or the operator's details (§6). */
export const USER_AGENT = "Jobaculator/1.0 (job discovery)";

export type SourceHttpOptions = {
	fetch?: FetchLike;
	/** Minimum spacing between requests to one host, shared by every User (~1 req/s). */
	minIntervalMs?: number;
	/** Attempts per request for 429, 5xx and network errors. */
	maxAttempts?: number;
	/** First backoff delay; doubles per attempt, with jitter. */
	backoffMs?: number;
	/** A `Retry-After` longer than this ends the request as RATE_LIMITED instead of waiting. */
	maxRetryAfterMs?: number;
	timeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
};

/** HTTP for Source adapters: one global per-host limiter, `Retry-After`, backoff on 429/5xx (§6). */
export type SourceHttp = {
	getJson(url: string): Promise<{ status: number; body: unknown } | ListingFailure>;
};

export function createSourceHttp(options: SourceHttpOptions = {}): SourceHttp {
	const fetch = options.fetch ?? globalThis.fetch;
	const minIntervalMs = options.minIntervalMs ?? 1000;
	const maxAttempts = options.maxAttempts ?? 3;
	const backoffMs = options.backoffMs ?? 2000;
	const maxRetryAfterMs = options.maxRetryAfterMs ?? 120_000;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = options.now ?? Date.now;

	// Per host: requests run one at a time, each starting no sooner than `notBefore`.
	const hosts = new Map<string, { tail: Promise<unknown>; notBefore: number }>();

	function throttled<T>(host: string, run: () => Promise<T>): Promise<T> {
		const slot = hosts.get(host) ?? { tail: Promise.resolve(), notBefore: 0 };
		hosts.set(host, slot);
		const result = slot.tail.then(async () => {
			const wait = slot.notBefore - now();
			if (wait > 0) await sleep(wait);
			slot.notBefore = now() + minIntervalMs;
			return run();
		});
		slot.tail = result.catch(() => {});
		return result;
	}

	function delayHost(host: string, ms: number) {
		const slot = hosts.get(host);
		if (slot) slot.notBefore = Math.max(slot.notBefore, now() + ms);
	}

	async function attempt(url: string): Promise<{ status: number; headers: Headers; text: string } | Error> {
		try {
			const response = await fetch(url, {
				headers: { accept: "application/json", "user-agent": USER_AGENT },
				signal: AbortSignal.timeout(timeoutMs),
				redirect: "follow",
			});
			return { status: response.status, headers: response.headers, text: await response.text() };
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
	}

	return {
		async getJson(url) {
			const host = new URL(url).host;
			let last: ListingFailure = { failure: "TRANSIENT", detail: "no attempt made" };
			for (let tries = 1; tries <= maxAttempts; tries++) {
				const response = await throttled(host, () => attempt(url));
				let retryInMs = backoffMs * 2 ** (tries - 1) * (0.75 + Math.random() * 0.5);
				if (response instanceof Error) {
					last = { failure: "TRANSIENT", detail: `network error: ${response.name}` };
				} else if (response.status === 429 || response.status === 503) {
					last = { failure: response.status === 429 ? "RATE_LIMITED" : "TRANSIENT", detail: `HTTP ${response.status}` };
					const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now());
					if (retryAfter !== null) {
						// Every caller on this host waits, not only this request.
						delayHost(host, retryAfter);
						if (retryAfter > maxRetryAfterMs) return last;
						retryInMs = 0;
					}
				} else if (response.status >= 500 || response.status === 408) {
					last = { failure: "TRANSIENT", detail: `HTTP ${response.status}` };
				} else if (response.status === 404 || response.status === 410) {
					return { failure: "NOT_FOUND", detail: `HTTP ${response.status}` };
				} else if (response.status === 401 || response.status === 403) {
					return { failure: "BLOCKED", detail: `HTTP ${response.status}` };
				} else if (response.status < 200 || response.status >= 300) {
					return { failure: "MALFORMED", detail: `unexpected HTTP ${response.status}` };
				} else {
					try {
						return { status: response.status, body: JSON.parse(response.text) };
					} catch {
						return { failure: "MALFORMED", detail: "response is not JSON" };
					}
				}
				if (tries < maxAttempts && retryInMs > 0) await sleep(retryInMs);
			}
			return last;
		},
	};
}

/** `Retry-After` as milliseconds from now: delta-seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const date = Date.parse(trimmed);
	return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}
