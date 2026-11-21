import type { ComputerStep, FailureKind, FailureScope, Message, ProposedAction, Provider, Usage } from "./types";

export type AdapterRequest = {
	/** The SDK's `apiKey` setter: the sealed key is opened only when the request is sent. */
	apiKey: () => Promise<string>;
	model: string;
	system?: string;
	messages: readonly Message[];
	/** The canonical JSON Schema; each adapter converts it to its provider's dialect. */
	output?: { name: string; schema: Record<string, unknown> };
	maxOutputTokens: number;
	signal?: AbortSignal;
};

export type ComputerAdapterRequest = Omit<AdapterRequest, "messages" | "output"> & {
	instruction: string;
	steps: readonly ComputerStep[];
};

export type Stop = "end" | "truncated" | "refusal" | "tool_use";

export type AdapterResponse = {
	text: string;
	stop: Stop;
	/** Null when the provider reported no usage; the call then keeps its reservation. */
	usage: Usage | null;
	requestId: string | null;
	actions?: ProposedAction[];
};

export type StreamChunk = { delta: string } | { response: AdapterResponse };

/**
 * A provider error at its narrowest scope (§12): only authentication is `key`; a
 * permission or model-access error is `model`. `fateKnown` is false when the request may
 * have reached the provider and been billed (network errors, timeouts).
 */
export type Classified = {
	kind: FailureKind;
	scope: FailureScope;
	errorClass: string;
	status: number | null;
	fateKnown: boolean;
};

/** One provider over its first-party SDK. Provider SDK types never leave the adapter. */
export type ProviderAdapter = {
	provider: Provider;
	/** Largest total PDF payload one request may carry. */
	maxPdfBytes: number;
	generate(request: AdapterRequest): Promise<AdapterResponse>;
	stream(request: AdapterRequest): AsyncIterable<StreamChunk>;
	computerTurn?(request: ComputerAdapterRequest): Promise<AdapterResponse>;
	/** Null for errors that are not provider errors (bugs, aborts): the gateway rethrows those. */
	classify(error: unknown): Classified | null;
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Thrown instead of a live provider call under Vitest unless `LLM_LIVE=1`, so `pnpm check` never calls out. */
export class LiveCallBlocked extends Error {
	override name = "LiveCallBlocked";
}

export const guardedFetch: FetchLike = (input, init) => {
	if (process.env.VITEST && process.env.LLM_LIVE !== "1") {
		return Promise.reject(new LiveCallBlocked("live LLM call blocked in tests: set LLM_LIVE=1 to allow it"));
	}
	return fetch(input, init);
};

/** The SDKs wrap fetch failures in their connection error; a blocked live call must surface, not be retried. */
export function liveCallBlocked(error: unknown): LiveCallBlocked | null {
	for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
		if (e instanceof LiveCallBlocked) return e;
	}
	return null;
}

/** Status-based classification shared by both SDKs, whose `APIError`s carry `status` and `code`. */
export function classifyStatus(status: number, code?: string | null): Classified {
	const at = (kind: FailureKind, scope: FailureScope, errorClass: string): Classified => ({
		kind,
		scope,
		errorClass,
		status,
		fateKnown: true,
	});
	if (status === 401) return at("shared", "key", "auth");
	if (status === 402) return at("shared", "key", "billing");
	if (status === 429 && code === "insufficient_quota") return at("shared", "key", "quota");
	if (status === 403) return at("shared", "model", "permission");
	if (status === 404) return at("shared", "model", "model_unavailable");
	if (status === 429) return at("transient", "model", "rate_limited");
	if (status === 529) return at("transient", "provider", "overloaded");
	if (status === 408 || status === 409 || status >= 500) return at("transient", "provider", "server_error");
	return at("deterministic", "none", "bad_request");
}

export const NETWORK_ERROR: Classified = {
	kind: "transient",
	scope: "provider",
	errorClass: "network",
	status: null,
	fateKnown: false,
};

export function pdfBytes(messages: readonly Message[]): number {
	let total = 0;
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const part of message.content) if (part.type === "pdf") total += part.data.length;
	}
	return total;
}

export function textOf(content: Message["content"]): string {
	return typeof content === "string"
		? content
		: content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
