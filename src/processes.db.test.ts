import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CSRF_HEADER } from "./api/csrf";
import { getCandidate } from "./packages/candidate/index";
import type { UserId } from "./packages/db/ownership";
import { createTestDatabase, type TestDatabase } from "./packages/db/testing";

let database: TestDatabase;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
	database = await createTestDatabase();
	const credentials = mkdtempSync(join(tmpdir(), "creds-"));
	writeFileSync(join(credentials, "master-key"), randomBytes(32).toString("base64"));
	writeFileSync(join(credentials, "auth-secret"), randomBytes(32).toString("base64url"));
	env = { PATH: process.env.PATH, DATABASE_URL: database.url, CREDENTIALS_DIRECTORY: credentials, WEB_PORT: "0" };
});
afterAll(() => database.close());

type Running = { child: ChildProcess; lines: Array<Record<string, unknown>>; exited: Promise<number | null> };

function start(entry: string): Running {
	const child = spawn(process.execPath, ["--import", "tsx", entry], { env, stdio: ["ignore", "pipe", "pipe"] });
	const lines: Array<Record<string, unknown>> = [];
	let buffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		const parts = buffer.split("\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) if (part.trim()) lines.push(JSON.parse(part));
	});
	const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
	return { child, lines, exited };
}

async function waitForEvent(running: Running, event: string, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const line = running.lines.find((l) => l.event === event);
		if (line) return line;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`no ${event} within ${timeoutMs} ms; saw ${running.lines.map((l) => l.event).join(", ")}`);
}

describe("processes", () => {
	it("web serves /health and stops gracefully on SIGTERM", async () => {
		const web = start("src/server.ts");
		const started = await waitForEvent(web, "web_started");
		const response = await fetch(`http://127.0.0.1:${started.port}/health`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });

		web.child.kill("SIGTERM");
		expect(await web.exited).toBe(0);
		expect(web.lines.map((l) => l.event)).toContain("web_stopped");
	});

	it("the admin CLI creates a User and its Candidate, and the User signs in to web", async () => {
		const cli = (args: string[], input: string) =>
			spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { env, input, encoding: "utf8" });
		const created = cli(["user:create", "--email", "Dana@Example.com", "--name", "Dana"], "a long enough password\n");
		expect(created.stderr).toBe("");
		expect(created.status).toBe(0);
		const userId = created.stdout.match(/created User ([0-9a-f-]{36})/)?.[1] as UserId;
		expect(await getCandidate(database.db, userId)).not.toBeNull();

		const duplicate = cli(["user:create", "--email", "dana@example.com", "--name", "Dana"], "a long enough password\n");
		expect(duplicate.status).toBe(1);
		expect(duplicate.stderr).toContain("already exists");
		const short = cli(["user:create", "--email", "short@example.com", "--name", "S"], "too-short\n");
		expect(short.status).toBe(1);
		expect(short.stderr).not.toContain("too-short");

		const web = start("src/server.ts");
		const { port } = await waitForEvent(web, "web_started");
		const signIn = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://localhost:3000", [CSRF_HEADER]: "1" },
			body: JSON.stringify({ email: "dana@example.com", password: "a long enough password" }),
		});
		expect(signIn.status).toBe(200);
		const cookie = signIn.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; ");
		const summary = await fetch(`http://127.0.0.1:${port}/api/trpc/dashboard.summary`, { headers: { cookie } });
		expect(summary.status).toBe(200);
		const body = (await summary.json()) as { result: { data: { submitted: unknown } } };
		expect(body.result.data.submitted).toEqual({ today: 0, week: 0, allTime: 0 });

		expect(cli(["user:reset-password", "--email", "dana@example.com"], "another long password\n").status).toBe(0);
		expect((await fetch(`http://127.0.0.1:${port}/api/trpc/dashboard.summary`, { headers: { cookie } })).status).toBe(
			401,
		);

		web.child.kill("SIGTERM");
		expect(await web.exited).toBe(0);
	});

	it("runs exactly one worker, which stops gracefully on SIGTERM", async () => {
		const first = start("src/worker.ts");
		await waitForEvent(first, "worker_started");

		const second = start("src/worker.ts");
		expect(await second.exited).toBe(1);
		expect(second.lines.map((l) => l.event)).toContain("worker_already_running");

		first.child.kill("SIGTERM");
		expect(await first.exited).toBe(0);
		expect(first.lines.map((l) => l.event)).toContain("worker_stopped");

		// The lock is released, so a new worker can take over.
		const third = start("src/worker.ts");
		await waitForEvent(third, "worker_started");
		third.child.kill("SIGTERM");
		expect(await third.exited).toBe(0);
	});
});
