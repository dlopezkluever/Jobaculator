import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Secret } from "../log/secret";

/** `admin` runs the ops CLI (`user:create`, `user:reset-password`). */
export type Role = "web" | "worker" | "migrator" | "admin";

/** Credential files each role reads from `$CREDENTIALS_DIRECTORY` (systemd `LoadCredential=`). */
const ROLE_CREDENTIALS = {
	web: ["master-key", "auth-secret"],
	worker: ["master-key"],
	migrator: [],
	admin: [],
} as const satisfies Record<Role, readonly CredentialName[]>;

/** Credential files a role reads when present: the worker's narrow journal token (§14). */
const OPTIONAL_CREDENTIALS = {
	web: [],
	worker: ["journal-key"],
	migrator: [],
	admin: [],
} as const satisfies Record<Role, readonly CredentialName[]>;

type Credentials = {
	"master-key": Secret<Buffer>;
	"auth-secret": Secret<string>;
	/** `<access key id>:<secret access key>` of the R2 token that may only create and read journal entries. */
	"journal-key": { accessKeyId: string; secretAccessKey: Secret<string> };
};
type CredentialName = keyof Credentials;

const settingsSchema = z.object({
	DATABASE_URL: z.string().min(1),
	DATA_DIR: z.string().min(1).default("./.data"),
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
	WEB_HOST: z.string().default("127.0.0.1"),
	WEB_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
	/** The origin the browser uses to reach `web` (Caddy, or the SSH tunnel in no-hostname mode). */
	WEB_ORIGIN: z.url({ protocol: /^https?$/ }).default("http://localhost:3000"),
	/** The submit-intent journal's S3 endpoint and bucket (§13); unset, live submission cannot cross the boundary. */
	JOURNAL_ENDPOINT: z.url({ protocol: /^https$/ }).optional(),
	JOURNAL_BUCKET: z.string().min(1).optional(),
});

/**
 * The global seed list of Boards every User watches (§6, ADR 0006: shared configuration).
 * Tracer Bullet 1 polls these hand-picked Greenhouse Boards, verified live.
 */
export const SEED_BOARDS = [
	{ source: "greenhouse", token: "anthropic", employer: "Anthropic" },
	{ source: "greenhouse", token: "figma", employer: "Figma" },
	{ source: "greenhouse", token: "stripe", employer: "Stripe" },
] as const;

type RoleCredentials<R extends Role> = (typeof ROLE_CREDENTIALS)[R][number];

export type Config<R extends Role = Role> = {
	role: R;
	databaseUrl: string;
	dataDir: string;
	logLevel: string;
	web: { host: string; port: number; origin: string };
	/** Master key for `secrets.seal/open`: 32 bytes. Absent for roles that do not receive it. */
	masterKey: "master-key" extends RoleCredentials<R> ? Secret<Buffer> : undefined;
	/** Signs session cookies (Better Auth). Only `web` receives it. */
	authSecret: "auth-secret" extends RoleCredentials<R> ? Secret<string> : undefined;
	/** The submit-intent journal (worker only), or null when it is not configured. */
	journal: {
		endpoint: string;
		bucket: string;
		accessKeyId: string;
		secretAccessKey: Secret<string>;
	} | null;
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
	Object.assign(credentials, readCredentials(OPTIONAL_CREDENTIALS[role], env.CREDENTIALS_DIRECTORY, true));
	const { DATABASE_URL, DATA_DIR, LOG_LEVEL, WEB_HOST, WEB_PORT, WEB_ORIGIN, JOURNAL_ENDPOINT, JOURNAL_BUCKET } =
		settings.data;
	const journalKey = credentials["journal-key"];
	return {
		role,
		databaseUrl: DATABASE_URL,
		dataDir: DATA_DIR,
		logLevel: LOG_LEVEL,
		web: { host: WEB_HOST, port: WEB_PORT, origin: new URL(WEB_ORIGIN).origin },
		masterKey: credentials["master-key"],
		authSecret: credentials["auth-secret"],
		journal:
			journalKey && JOURNAL_ENDPOINT && JOURNAL_BUCKET
				? { endpoint: JOURNAL_ENDPOINT, bucket: JOURNAL_BUCKET, ...journalKey }
				: null,
	} as Config<R>;
}

const PARSERS: { [N in CredentialName]: (raw: string) => Credentials[N] } = {
	"master-key": (raw) => {
		const key = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) ? Buffer.from(raw, "base64") : Buffer.alloc(0);
		if (key.length !== 32) throw new ConfigError("credential master-key must be 32 bytes, base64-encoded");
		return new Secret(key);
	},
	"auth-secret": (raw) => {
		if (raw.length < 32) throw new ConfigError("credential auth-secret must be at least 32 characters");
		return new Secret(raw);
	},
	"journal-key": (raw) => {
		const split = raw.indexOf(":");
		if (split < 1 || split === raw.length - 1) {
			throw new ConfigError("credential journal-key must be <access key id>:<secret access key>");
		}
		return { accessKeyId: raw.slice(0, split), secretAccessKey: new Secret(raw.slice(split + 1)) };
	},
};

function readCredentials(
	names: readonly CredentialName[],
	directory: string | undefined,
	optional = false,
): Partial<Credentials> {
	const out: Partial<Credentials> = {};
	if (names.length === 0) return out;
	if (!directory) {
		if (optional) return out;
		throw new ConfigError("CREDENTIALS_DIRECTORY is not set");
	}
	for (const name of names) {
		let raw: string;
		try {
			raw = readFileSync(join(directory, name), "utf8").trim();
		} catch (error) {
			if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new ConfigError(`credential ${name} is missing or unreadable`);
		}
		Object.assign(out, { [name]: PARSERS[name](raw) });
	}
	return out;
}
