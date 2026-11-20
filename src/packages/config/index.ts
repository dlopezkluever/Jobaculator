import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Secret } from "../log/secret";

export type Role = "web" | "worker" | "migrator";

/** Credential files each role reads from `$CREDENTIALS_DIRECTORY` (systemd `LoadCredential=`). */
const ROLE_CREDENTIALS = {
	web: ["master-key"],
	worker: ["master-key"],
	migrator: [],
} as const satisfies Record<Role, readonly CredentialName[]>;

type CredentialName = "master-key";

const settingsSchema = z.object({
	DATABASE_URL: z.string().min(1),
	DATA_DIR: z.string().min(1).default("./.data"),
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
	WEB_HOST: z.string().default("127.0.0.1"),
	WEB_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
});

export type Config<R extends Role = Role> = {
	role: R;
	databaseUrl: string;
	dataDir: string;
	logLevel: string;
	web: { host: string; port: number };
	/** Master key for `secrets.seal/open`: 32 bytes. Absent for roles that do not receive it. */
	masterKey: R extends "migrator" ? undefined : Secret<Buffer>;
};

export class ConfigError extends Error {
	override name = "ConfigError";
}

/**
 * Loads and validates startup config. Non-secret settings come from the environment;
 * secrets only from credential files in `$CREDENTIALS_DIRECTORY`, never env vars,
 * because child processes such as Chromium inherit the environment.
 * Error messages name the setting and the rule, never a value.
 */
export function loadConfig<R extends Role>(role: R, env: NodeJS.ProcessEnv = process.env): Config<R> {
	const settings = settingsSchema.safeParse(env);
	if (!settings.success) {
		const problems = settings.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`);
		throw new ConfigError(`invalid config: ${problems.join("; ")}`);
	}
	const credentials = readCredentials(ROLE_CREDENTIALS[role], env.CREDENTIALS_DIRECTORY);
	const { DATABASE_URL, DATA_DIR, LOG_LEVEL, WEB_HOST, WEB_PORT } = settings.data;
	return {
		role,
		databaseUrl: DATABASE_URL,
		dataDir: DATA_DIR,
		logLevel: LOG_LEVEL,
		web: { host: WEB_HOST, port: WEB_PORT },
		masterKey: credentials.get("master-key"),
	} as Config<R>;
}

function readCredentials(
	names: readonly CredentialName[],
	directory: string | undefined,
): Map<CredentialName, Secret<Buffer>> {
	const out = new Map<CredentialName, Secret<Buffer>>();
	if (names.length === 0) return out;
	if (!directory) throw new ConfigError("CREDENTIALS_DIRECTORY is not set");
	for (const name of names) {
		let raw: string;
		try {
			raw = readFileSync(join(directory, name), "utf8").trim();
		} catch {
			throw new ConfigError(`credential ${name} is missing or unreadable`);
		}
		out.set(name, parseMasterKey(raw));
	}
	return out;
}

function parseMasterKey(raw: string): Secret<Buffer> {
	const key = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) ? Buffer.from(raw, "base64") : Buffer.alloc(0);
	if (key.length !== 32) throw new ConfigError("credential master-key must be 32 bytes, base64-encoded");
	return new Secret(key);
}
