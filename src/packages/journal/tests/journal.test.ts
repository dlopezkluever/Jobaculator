import { describe, expect, it } from "vitest";
import { Secret } from "../../log/secret";
import { createR2Journal, type JournalEntry, JournalUnavailable, journalUrl } from "../index";

// The R2 journal against a stand-in for the S3 API: create-only writes (§13, #22).

const ENTRY: JournalEntry = {
	intentId: "6f0c1b52-6a3e-4f7e-9d0b-1c2d3e4f5a6b",
	userId: "0b6f7c2e-1d4a-4c3b-8a9e-2f1d0c9b8a7e",
	applicationId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
	opportunityId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
	browserRunId: "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f",
	posting: {
		source: "greenhouse",
		boardToken: "figma",
		nativeId: "5426468004",
		dedupKey: "greenhouse:figma:5426468004",
	},
	applyUrl: "https://job-boards.greenhouse.io/figma/jobs/5426468004",
	mode: "live",
	at: "2026-11-23T10:00:00.000Z",
};

/** An S3 bucket that honours `If-None-Match: *`; `script` answers requests first, by order. */
function bucket(script: ((request: Request) => Response | Error | null)[] = []) {
	const objects = new Map<string, string>();
	const requests: Request[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push(request.clone());
		const scripted = script.shift()?.(request);
		if (scripted instanceof Error) throw scripted;
		if (scripted) return scripted;
		const key = new URL(request.url).pathname;
		if (request.method === "PUT") {
			if (request.headers.get("if-none-match") === "*" && objects.has(key)) return new Response(null, { status: 412 });
			objects.set(key, await request.text());
			return new Response(null, { status: 200 });
		}
		const body = objects.get(key);
		return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
	};
	const journal = createR2Journal({
		endpoint: "https://account.r2.cloudflarestorage.com",
		bucket: "journal",
		accessKeyId: "key",
		secretAccessKey: new Secret("secret"),
		backoffMs: 1,
		fetch: fetch as typeof globalThis.fetch,
	});
	return { journal, objects, requests };
}

describe("the R2 submit-intent journal", () => {
	it("writes the entry create-only, signed, under its intent id", async () => {
		const { journal, objects, requests } = bucket();
		await journal.write(ENTRY);
		const [put] = requests;
		expect(put?.method).toBe("PUT");
		expect(put?.headers.get("if-none-match")).toBe("*");
		expect(put?.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
		expect(JSON.parse(objects.get(`/journal/intents/${ENTRY.intentId}.json`) ?? "")).toEqual(ENTRY);
	});

	it("counts an entry an earlier attempt stored as written, after a lost response", async () => {
		const { journal, objects } = bucket([
			// The first PUT reaches the bucket, but its response is lost.
			(request) => {
				void request.text().then((body) => objects.set(new URL(request.url).pathname, body));
				return new TypeError("fetch failed");
			},
		]);
		await journal.write(ENTRY);
		expect(objects.size).toBe(1);
	});

	it("never overwrites another entry stored under the same id", async () => {
		const { journal } = bucket();
		await journal.write({ ...ENTRY, browserRunId: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a" });
		await expect(journal.write(ENTRY)).rejects.toBeInstanceOf(JournalUnavailable);
	});

	it("retries a failing bucket, then gives up with JournalUnavailable", async () => {
		const unavailable = () => new Response(null, { status: 503 });
		const { journal, requests } = bucket([unavailable, unavailable, unavailable, unavailable]);
		await expect(journal.write(ENTRY)).rejects.toThrow(/HTTP 503/);
		expect(requests).toHaveLength(4);
		const denied = bucket([() => new Response(null, { status: 403 })]);
		await expect(denied.journal.write(ENTRY)).rejects.toBeInstanceOf(JournalUnavailable);
		expect(denied.requests).toHaveLength(1);
	});

	it("records apply URLs without their query", () => {
		expect(journalUrl("https://careers.example.com/jobs/1?gh_jid=5&utm_source=x#apply")).toBe(
			"https://careers.example.com/jobs/1",
		);
	});
});
