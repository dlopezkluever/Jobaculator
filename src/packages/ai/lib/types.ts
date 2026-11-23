import type { z } from "zod";
import type { UserId } from "../../db/ownership";

export const TASKS = [
	"extract",
	"score",
	"strategy",
	"write",
	"answer",
	"interview",
	"classify",
	"browser_agent",
] as const;
/** What a call is for. Callers name a task, never a model; the route table picks the model. */
export type Task = (typeof TASKS)[number];

export const PROVIDERS = ["anthropic", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PRESETS = ["economy", "standard", "best"] as const;
export type Preset = (typeof PRESETS)[number];

/** Who a call is for and why: every ledger row carries it. Only `userId` is required. */
export type Attribution = {
	userId: UserId;
	huntId?: string | null;
	applicationId?: string | null;
	browserRunId?: string | null;
	opportunityId?: string | null;
};

export type Part = { type: "text"; text: string } | { type: "pdf"; data: Buffer; filename?: string };
export type Message = { role: "user" | "assistant"; content: string | readonly Part[] };

export type GenerateRequest<T> = {
	task: Exclude<Task, "browser_agent">;
	attribution: Attribution;
	system?: string;
	messages: readonly Message[];
	/** Structured output: converted to each provider's schema dialect, and the result re-validated here. */
	output?: z.ZodType<T>;
	maxOutputTokens?: number;
	signal?: AbortSignal;
};

export type StreamRequest = Omit<GenerateRequest<never>, "output">;

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

/** One finalised provider call: the ledger row id, who ran it and what it measurably cost. */
export type CallReceipt = { callId: string; provider: Provider; model: string; usage: Usage; costUsd: number };

export type GenerateResult<T> = CallReceipt & { text: string; output: T };

export type StreamEvent = { type: "text"; delta: string } | { type: "done"; result: GenerateResult<string> };

/**
 * The neutral computer-use vocabulary (§12). Coordinates are screenshot pixels. The
 * browser executor runs these; provider adapters translate to and from their own tools.
 */
export type ComputerAction =
	| { type: "screenshot" }
	| { type: "click"; x?: number; y?: number; button: "left" | "right"; count: 1 | 2 | 3; modifiers?: string }
	| { type: "move"; x: number; y: number }
	| { type: "drag"; from: { x: number; y: number }; to: { x: number; y: number } }
	| { type: "type"; text: string }
	| { type: "key"; keys: string; repeat?: number }
	| { type: "scroll"; x?: number; y?: number; direction: "up" | "down" | "left" | "right"; amount: number }
	| { type: "wait"; seconds: number };

export type ProposedAction = { id: string; action: ComputerAction };
/** What happened when the executor ran one proposed action: a PNG screenshot, or an error. */
export type ActionResult = { id: string; screenshot?: Buffer; error?: string };
/** One earlier turn: what the model said and proposed, and the executor's results for every proposal. */
export type ComputerStep = { text: string; actions: readonly ProposedAction[]; results: readonly ActionResult[] };

export type ComputerTurnRequest = {
	attribution: Attribution;
	system?: string;
	instruction: string;
	steps: readonly ComputerStep[];
	maxOutputTokens?: number;
	signal?: AbortSignal;
};

/** `done` when the model proposed no action: it considers the instruction finished (or cannot go on, see `text`). */
export type ComputerTurnResult = CallReceipt & { text: string; actions: ProposedAction[]; done: boolean };

/** The single seam every LLM call goes through (§12), in `web` (interactive) and `worker` (autonomous). */
export type LlmClient = {
	generate<T = string>(request: GenerateRequest<T>): Promise<GenerateResult<T>>;
	/** Text only. Falls back to another route only until the first delta has been yielded. */
	stream(request: StreamRequest): AsyncIterable<StreamEvent>;
	/** One turn of the browser agent (task `browser_agent`); Anthropic models only. */
	computerTurn(request: ComputerTurnRequest): Promise<ComputerTurnResult>;
};

/**
 * - `transient`: may succeed if tried again (rate limit, overload, network).
 * - `deterministic`: the same request fails the same way (refusal, schema violation, truncation, bad request).
 * - `shared`: something every call through that scope depends on is broken (bad key, no model access).
 */
export type FailureKind = "transient" | "deterministic" | "shared";
export type FailureScope = "key" | "provider" | "model" | "budget" | "none";

/** Identifies "the same failure" for pipeline backoff and Holds (§12). */
export type Fingerprint = {
	task: Task;
	provider: Provider | null;
	model: string | null;
	errorClass: string;
	schemaHash: string | null;
};

export class LlmError extends Error {
	override name = "LlmError";
	constructor(
		message: string,
		readonly kind: FailureKind,
		readonly scope: FailureScope,
		readonly fingerprint: Fingerprint,
		options?: { cause?: unknown },
	) {
		super(message, options);
	}
}

/** The User's daily AI spend cap would be exceeded by this call. Never bypassed by fallback. */
export class BudgetExceeded extends LlmError {
	override name = "BudgetExceeded";
	constructor(
		fingerprint: Fingerprint,
		readonly capUsd: number,
		readonly spentUsd: number,
	) {
		super("the daily AI spend cap would be exceeded", "shared", "budget", fingerprint);
	}
}

/** Every route for the task was unusable. `scopes` names what blocked them, e.g. `key:openai`. */
export class NoViableRoute extends LlmError {
	override name = "NoViableRoute";
	constructor(
		fingerprint: Fingerprint,
		readonly scopes: readonly string[],
		readonly failures: readonly LlmError[],
	) {
		super(`no viable route: ${scopes.join(", ") || "none configured"}`, "shared", "none", fingerprint);
	}
}
