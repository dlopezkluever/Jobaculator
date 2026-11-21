import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCandidate, EXTRACT_DOCUMENT } from "../packages/candidate/index";
import { trySessionLock } from "../packages/db/index";
import { createTestDatabase, type TestDatabase } from "../packages/db/testing";
import { createJobs, type Jobs, WORKER_LOCK_KEY } from "../packages/jobs/index";
import { createLogger } from "../packages/log/index";
import { Secret } from "../packages/log/secret";
import { createSecrets } from "../packages/secrets/index";
import { createStorage } from "../packages/storage/index";
import { createUser, createUsers, resetPassword } from "../packages/users/index";
import { createApp } from "./app";
import { CSRF_HEADER } from "./csrf";

const ORIGIN = "http://jobaculator.test";
const EMAIL = "dana@example.com";
const PASSWORD = "correct horse battery";

let database: TestDatabase;
let jobs: Jobs;
let app: Hono;
beforeAll(async () => {
	database = await createTestDatabase();
	// The worker installs pg-boss and creates the queues; `web` only sends.
	const worker = createJobs({ databaseUrl: database.url, queues: [EXTRACT_DOCUMENT] });
	await worker.start();
	await worker.stop({ timeoutMs: 1000 });
	jobs = createJobs({ databaseUrl: database.url, queues: [EXTRACT_DOCUMENT], sendOnly: true });
	const log = createLogger({ destination: new Writable({ write: (_chunk, _encoding, done) => done() }) });
	const users = createUsers({
		db: database.db,
		origin: ORIGIN,
		secret: new Secret(randomBytes(32).toString("hex")),
		log,
	});
	app = createApp({
		db: database.db,
		secrets: createSecrets([{ version: 1, key: new Secret(randomBytes(32)) }]),
		storage: createStorage(mkdtempSync(join(tmpdir(), "blobs-"))),
		jobs,
		users,
		origin: ORIGIN,
		log,
	});
	await database.db.transaction(async (tx) => {
		await createCandidate(tx, await createUser(tx, { email: EMAIL, name: "Dana", password: PASSWORD }));
	});
});
afterAll(async () => {
	await jobs.stop({ timeoutMs: 1000 });
	await database.close();
});

let clientIp = 0;
/** A distinct client per test, so the per-IP sign-in rate limit of one test does not reach another. */
function client() {
	const ip = `203.0.113.${++clientIp}`;
	let cookie = "";
	const request = async (
		path: string,
		init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
	) => {
		const headers: Record<string, string> = { "x-forwarded-for": ip, ...init.headers };
		if (cookie) headers.cookie = cookie;
		const form = init.body instanceof FormData;
		if (init.body !== undefined && !form) headers["content-type"] = "application/json";
		const response = await app.request(`${ORIGIN}${path}`, {
			method: init.method ?? "GET",
			headers,
			body: init.body === undefined ? undefined : form ? (init.body as FormData) : JSON.stringify(init.body),
		});
		const set = response.headers.getSetCookie().map((c) => c.split(";")[0] ?? "");
		if (set.length > 0) cookie = set.join("; ");
		return response;
	};
	const mutation = (path: string, body: unknown = {}) =>
		request(path, { method: "POST", body, headers: { origin: ORIGIN, [CSRF_HEADER]: "1" } });
	return {
		request,
		mutation,
		signIn: (password = PASSWORD) => mutation("/api/auth/sign-in/email", { email: EMAIL, password }),
		query: async (procedure: string) => {
			const response = await request(`/api/trpc/${procedure}`);
			return {
				status: response.status,
				data: response.ok ? ((await response.json()) as { result: { data: unknown } }).result.data : undefined,
			};
		},
	};
}

describe("signing in", () => {
	it("refuses tRPC calls without a session", async () => {
		const anonymous = client();
		expect((await anonymous.query("dashboard.summary")).status).toBe(401);
		expect((await anonymous.query("system.status")).status).toBe(401);
		const forged = await anonymous.request("/api/trpc/dashboard.summary", {
			headers: { cookie: "jobaculator.session_token=forged" },
		});
		expect(forged.status).toBe(401);
	});

	it("signs in with email and password to a 30-day Secure, HttpOnly, SameSite=Lax session cookie", async () => {
		const user = client();
		const response = await user.signIn();
		expect(response.status).toBe(200);
		const [sessionCookie] = response.headers.getSetCookie().filter((c) => c.includes("session_token="));
		expect(sessionCookie).toMatch(/; Secure/i);
		expect(sessionCookie).toMatch(/; HttpOnly/i);
		expect(sessionCookie).toMatch(/; SameSite=Lax/i);
		expect(sessionCookie).toMatch(/; Max-Age=2592000/i);

		expect(await user.query("dashboard.summary")).toEqual({
			status: 200,
			data: {
				submitted: { today: 0, week: 0, allTime: 0 },
				inFlight: { queued: 0, preparing: 0, inBrowser: 0 },
				dryRuns: 0,
				attention: { needsYou: 0, review: 0, uncertain: 0 },
				holds: 0,
			},
		});
	});

	it("slides the 30-day session when the SPA checks it, renewing the row and the cookie together", async () => {
		const user = client();
		await user.signIn();
		const expiresAt = async () => {
			const result = await database.db.execute<{ days: number }>(
				sql`select extract(epoch from max(expires_at) - now()) / 86400 as days from auth_session`,
			);
			return Number(result.rows[0]?.days);
		};
		// Two days into the session: past the one-day refresh age.
		await database.db.execute(sql`update auth_session set expires_at = now() + interval '28 days'`);

		// tRPC reads the session without renewing it: a renewed row behind an unrenewed cookie would expire early.
		expect((await user.query("system.status")).status).toBe(200);
		expect(await expiresAt()).toBeLessThan(28.01);

		const check = await user.request("/api/auth/get-session");
		expect(check.status).toBe(200);
		expect(await expiresAt()).toBeGreaterThan(29.99);
		const [renewed] = check.headers.getSetCookie().filter((c) => c.includes("session_token="));
		expect(renewed).toMatch(/; Max-Age=2592000/i);
	});

	it("refuses a wrong password, and rate-limits repeated sign-in attempts", async () => {
		const attacker = client();
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) statuses.push((await attacker.signIn("wrong password guess")).status);
		expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
		expect((await attacker.signIn()).status).toBe(429);
		expect((await client().signIn()).status).toBe(200);
	});

	it("has registration and self-service account changes off", async () => {
		const visitor = client();
		const signUp = await visitor.mutation("/api/auth/sign-up/email", {
			email: "new@example.com",
			password: PASSWORD,
			name: "x",
		});
		expect(signUp.status).toBe(404);
		expect((await visitor.mutation("/api/auth/request-password-reset", { email: EMAIL })).status).toBe(404);
	});

	it("signs out on the server", async () => {
		const user = client();
		await user.signIn();
		expect((await user.query("system.status")).status).toBe(200);
		const session = (await (await user.request("/api/auth/get-session")).json()) as { user: { email: string } } | null;
		expect(session?.user.email).toBe(EMAIL);
		expect((await user.mutation("/api/auth/sign-out")).status).toBe(200);
		expect((await user.query("system.status")).status).toBe(401);
	});

	it("a password reset signs out every session and replaces the password", async () => {
		const other = "a different long password";
		const user = client();
		await user.signIn();
		await resetPassword(database.db, { email: EMAIL.toUpperCase(), password: other });
		expect((await user.query("system.status")).status).toBe(401);
		expect((await client().signIn()).status).toBe(401);
		expect((await client().signIn(other)).status).toBe(200);
		await resetPassword(database.db, { email: EMAIL, password: PASSWORD });
	});
});

describe("CSRF and CORS", () => {
	it("refuses a mutation without the custom header or from another origin", async () => {
		const user = client();
		await user.signIn();
		const body = { email: EMAIL, password: PASSWORD };
		const noHeader = await user.request("/api/auth/sign-in/email", {
			method: "POST",
			body,
			headers: { origin: ORIGIN },
		});
		expect(noHeader.status).toBe(403);
		const crossSite = await user.request("/api/auth/sign-out", {
			method: "POST",
			body: {},
			headers: { origin: "https://evil.example", [CSRF_HEADER]: "1" },
		});
		expect(crossSite.status).toBe(403);
		const noOrigin = await user.request("/api/auth/sign-out", {
			method: "POST",
			body: {},
			headers: { [CSRF_HEADER]: "1" },
		});
		expect(noOrigin.status).toBe(403);
		const trpcMutation = await user.request("/api/trpc/system.status", {
			method: "POST",
			body: {},
			headers: { origin: ORIGIN },
		});
		expect(trpcMutation.status).toBe(403);
		// The refused sign-out did nothing.
		expect((await user.query("system.status")).status).toBe(200);
	});

	it("grants no cross-origin access", async () => {
		const preflight = await client().request("/api/trpc/system.status", {
			method: "OPTIONS",
			headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
		});
		expect(preflight.status).toBe(403);
		expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("sends a strict CSP and security headers", async () => {
		const response = await client().request("/health");
		const csp = response.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).not.toContain("unsafe-inline");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	});
});

describe("system status", () => {
	it("reports Dry Run and whether the worker holds its lock", async () => {
		const user = client();
		await user.signIn();
		expect((await user.query("system.status")).data).toEqual({ mode: "DRY_RUN", workerRunning: false });
		const lock = await trySessionLock(database.url, WORKER_LOCK_KEY, () => {});
		try {
			expect((await user.query("system.status")).data).toEqual({ mode: "DRY_RUN", workerRunning: true });
		} finally {
			await lock?.release();
		}
	});
});

describe("AI settings", () => {
	it("saves keys write-only, showing only their last 4 characters, and sets the daily cap", async () => {
		const user = client();
		await user.signIn();
		const key = "sk-ant-api03-thisisthewholesecretkey-k3Y9";

		const refused = await user.mutation("/api/trpc/ai.saveKey", { provider: "anthropic", key: "not a key" });
		expect(refused.status).toBe(400);
		expect(await refused.text()).toContain("sk-ant-");

		const saved = await user.mutation("/api/trpc/ai.saveKey", { provider: "anthropic", key });
		expect(saved.status).toBe(200);
		expect(await saved.text()).not.toContain("thisisthewholesecretkey");
		expect((await user.mutation("/api/trpc/ai.updateSettings", { dailyCapUsd: 2.5, preset: "economy" })).status).toBe(
			200,
		);

		const response = await user.request("/api/trpc/ai.settings");
		const text = await response.text();
		expect(text).not.toContain("thisisthewholesecretkey");
		const settings = (JSON.parse(text) as { result: { data: Record<string, unknown> } }).result.data;
		expect(settings).toMatchObject({
			keys: [{ provider: "anthropic", last4: "k3Y9" }],
			preset: "economy",
			dailyCapUsd: 2.5,
			spentTodayUsd: 0,
		});
	});
});

describe("document upload", () => {
	const file = (name: string, content: string) => {
		const form = new FormData();
		form.set("file", new File([content], name));
		return form;
	};
	const upload = (user: ReturnType<typeof client>, form: FormData) =>
		user.request("/api/candidate/documents", {
			method: "POST",
			body: form,
			headers: { origin: ORIGIN, [CSRF_HEADER]: "1" },
		});

	it("takes one file per request from a signed-in Candidate and queues it, skipping the same bytes pasted later", async () => {
		expect((await upload(client(), file("resume.md", "# Dana Reyes"))).status).toBe(401);

		const user = client();
		await user.signIn();
		const refused = await upload(user, file("photo.png", "png"));
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({ error: "Only PDF, DOCX, TXT and Markdown files are accepted." });

		const uploaded = await upload(user, file("resume.md", "# Dana Reyes"));
		expect(uploaded.status).toBe(200);
		expect(await uploaded.json()).toMatchObject({
			duplicate: false,
			document: { filename: "resume.md", format: "markdown", status: "queued" },
		});
		const queued = await database.db.execute(sql`select 1 from pgboss.job where name = ${EXTRACT_DOCUMENT.name}`);
		expect(queued.rows).toHaveLength(1);

		const pasted = await user.mutation("/api/trpc/candidate.documents.paste", { text: "# Dana Reyes\n" });
		expect(((await pasted.json()) as { result: { data: unknown } }).result.data).toMatchObject({ duplicate: true });
		expect((await user.query("candidate.documents.list")).data).toMatchObject([{ filename: "resume.md" }]);
	});
});
