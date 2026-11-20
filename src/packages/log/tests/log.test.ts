import { Writable } from "node:stream";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createLogger } from "../index";
import { Secret } from "../secret";

const CANARY = "canary-5f3c9a1e-do-not-log";

function capture() {
	const lines: string[] = [];
	const destination = new Writable({
		write(chunk, _encoding, done) {
			lines.push(chunk.toString());
			done();
		},
	});
	return { log: createLogger({ destination }), output: () => lines.join("") };
}

describe("canary secret never reaches the logs", () => {
	it("through a Secret wrapper", () => {
		const secret = new Secret(CANARY);
		const { log, output } = capture();
		log.info({ key: secret, nested: { key: secret } }, `using ${secret}`);
		expect(String(secret)).toBe("[REDACTED]");
		expect(JSON.stringify({ secret })).not.toContain(CANARY);
		expect(inspect({ secret })).not.toContain(CANARY);
		expect(output()).not.toContain(CANARY);
		expect(secret.reveal()).toBe(CANARY);
	});

	it("through sensitive field names, top level and nested", () => {
		const { log, output } = capture();
		log.info({ password: CANARY, request: { authorization: `Bearer ${CANARY}`, cookie: CANARY }, apiKey: CANARY });
		expect(output()).not.toContain(CANARY);
		expect(output()).toContain("[REDACTED]");
	});

	it("through an SDK-style error carrying headers, request and response", () => {
		const error = Object.assign(new Error("401 Unauthorized"), {
			status: 401,
			headers: { "x-api-key": CANARY },
			request: { headers: { authorization: CANARY }, body: CANARY },
			response: { data: CANARY },
			cause: Object.assign(new Error("inner"), { config: { headers: { cookie: CANARY } } }),
		});
		const { log, output } = capture();
		log.error({ err: error, event: "ai_call_failed" });
		const line = JSON.parse(output());
		expect(output()).not.toContain(CANARY);
		expect(line.err).toMatchObject({ name: "Error", message: "401 Unauthorized", status: 401 });
		expect(line.err.cause.message).toBe("inner");
	});
});
