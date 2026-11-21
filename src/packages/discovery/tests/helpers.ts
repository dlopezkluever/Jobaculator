import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGreenhouseAdapter, createSourceHttp, type FetchLike, type SourceAdapter } from "../index";

export type BoardFixture = {
	note: string;
	recordedAt: string;
	url: string;
	body: { jobs: unknown[]; meta: { total: number } };
};

/** A recorded Greenhouse Board listing (`tests/fixtures/greenhouse-<token>.json`). Each call returns a fresh copy. */
export function boardFixture(token: string): BoardFixture {
	return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `greenhouse-${token}.json`), "utf8"));
}

export type Route = { status: number; body?: unknown; headers?: Record<string, string> };

/**
 * A fetch that serves routes by URL and refuses everything else, so tests never reach
 * the network. Change `routes` between calls to simulate a Board changing.
 */
export function routedFetch(routes: Map<string, Route | Route[]>) {
	const requests: { url: string; headers: Headers }[] = [];
	const fetch: FetchLike = async (input, init) => {
		const request = new Request(input, init);
		requests.push({ url: request.url, headers: request.headers });
		const route = routes.get(request.url);
		const next = Array.isArray(route) ? route.shift() : route;
		if (!next) throw new Error(`no route for ${request.url}`);
		const text = next.body === undefined ? "" : typeof next.body === "string" ? next.body : JSON.stringify(next.body);
		return new Response(text, { status: next.status, headers: next.headers });
	};
	return { fetch, requests };
}

/** A Greenhouse adapter over `routes`, without the limiter's real waits. */
export function greenhouseOver(routes: Map<string, Route | Route[]>): SourceAdapter {
	return createGreenhouseAdapter(
		createSourceHttp({ fetch: routedFetch(routes).fetch, minIntervalMs: 0, backoffMs: 0, sleep: async () => {} }),
	);
}

/** Routes serving each token's recorded listing. */
export function boardRoutes(...tokens: string[]): Map<string, Route | Route[]> {
	return new Map(
		tokens.map((token) => {
			const fixture = boardFixture(token);
			return [fixture.url, { status: 200, body: fixture.body }];
		}),
	);
}
