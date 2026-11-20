import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../index";

const MASTER_KEY = randomBytes(32).toString("base64");
const DB_PASSWORD = "hunter2-db-password";

function credentialsDir(files: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "creds-"));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), `${content}\n`);
	return dir;
}

const baseEnv = { DATABASE_URL: "postgres:///jobaculator" };

describe("loadConfig", () => {
	it("reads the master key from $CREDENTIALS_DIRECTORY and applies defaults", () => {
		const config = loadConfig("web", {
			...baseEnv,
			CREDENTIALS_DIRECTORY: credentialsDir({ "master-key": MASTER_KEY }),
		});
		expect(config.masterKey.reveal().toString("base64")).toBe(MASTER_KEY);
		expect(config.web).toEqual({ host: "127.0.0.1", port: 3000 });
		expect(JSON.stringify(config)).not.toContain(MASTER_KEY);
	});

	it("ignores a secret passed as an environment variable", () => {
		expect(() => loadConfig("worker", { ...baseEnv, MASTER_KEY, "master-key": MASTER_KEY })).toThrow(
			"CREDENTIALS_DIRECTORY is not set",
		);
	});

	it("needs no credentials for the migrator", () => {
		expect(loadConfig("migrator", baseEnv).masterKey).toBeUndefined();
	});

	it("names the problem without echoing secret values", () => {
		const badKey = "not-a-valid-key-but-still-secret";
		const dir = credentialsDir({ "master-key": badKey });
		const attempt = () => loadConfig("web", { DATABASE_URL: "", WEB_PORT: DB_PASSWORD, CREDENTIALS_DIRECTORY: dir });
		expect(attempt).toThrow(/DATABASE_URL.*WEB_PORT/);
		let message = "";
		try {
			attempt();
		} catch (error) {
			message = String(error);
		}
		expect(message).not.toContain(DB_PASSWORD);

		const keyMessage = (() => {
			try {
				loadConfig("web", { ...baseEnv, CREDENTIALS_DIRECTORY: dir });
				return "";
			} catch (error) {
				return String(error);
			}
		})();
		expect(keyMessage).toContain("master-key must be 32 bytes");
		expect(keyMessage).not.toContain(badKey);
	});
});
