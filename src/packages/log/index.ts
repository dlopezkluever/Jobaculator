import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

/**
 * Field names that never reach a log line, at the top level and one level deep.
 * A backstop only: log ids, status, timing and error classes, never content (§14).
 */
const SENSITIVE_KEYS = [
	"password",
	"secret",
	"token",
	"apiKey",
	"api_key",
	"authorization",
	"cookie",
	"cookies",
	"headers",
	"body",
	"masterKey",
	"credentials",
];

const REDACT_PATHS = SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`]);

/** Error properties kept by the serializer. Everything else (headers, request, response, config) is dropped. */
const ERROR_FIELDS = ["name", "message", "stack", "code", "status", "statusCode", "type"] as const;

function serializeError(error: unknown, depth = 0): Record<string, unknown> {
	if (!(error instanceof Error)) return { type: typeof error };
	const out: Record<string, unknown> = {};
	const source = error as unknown as Record<string, unknown>;
	for (const field of ERROR_FIELDS) {
		const value = source[field];
		if (typeof value === "string" || typeof value === "number") out[field] = value;
	}
	if (error.cause !== undefined && depth < 3) out.cause = serializeError(error.cause, depth + 1);
	return out;
}

export type LoggerOptions = {
	level?: string;
	/** Defaults to stdout (journald in production). Tests pass a capturing stream. */
	destination?: DestinationStream;
};

/** The structured JSON logger every process uses, with path redaction and a header-stripping error serializer. */
export function createLogger(options: LoggerOptions = {}): Logger {
	return pino(
		{
			level: options.level ?? "info",
			base: undefined,
			redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
			serializers: { err: serializeError, error: serializeError },
		},
		options.destination ?? pino.destination(1),
	);
}
