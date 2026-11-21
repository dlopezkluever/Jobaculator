import type { Preset, Provider, Task, Usage } from "./types";

/**
 * Prices in USD per million tokens, from the providers' pricing pages on this date
 * (platform.claude.com/docs/en/about-claude/pricing, developers.openai.com/api/docs/pricing,
 * standard tier, global routing). Change a price only together with this version.
 */
export const PRICE_TABLE_VERSION = "2026-11-20";

/** Per million tokens. `input` is uncached input; `cacheWrite` is the shortest-TTL write price. */
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type ModelInfo = {
	provider: Provider;
	price: Price;
	/** Prices for a request whose prompt (all input tokens) is over `threshold` tokens. */
	longContext?: { threshold: number; price: Price };
	/** Static capability metadata: what the gateway may route here, decided without live calls. */
	structuredOutput: boolean;
	pdf: boolean;
	computerUse: boolean;
	maxOutputTokens: number;
	/** Same provider, one step stronger: tried once after a schema violation or truncation. */
	stronger?: string;
};

export const MODELS = {
	"claude-haiku-5-5": {
		provider: "anthropic",
		price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
		longContext: { threshold: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
		structuredOutput: true,
		pdf: true,
		computerUse: false,
		maxOutputTokens: 64_000,
		stronger: "claude-sonnet-5-5",
	},
	"claude-sonnet-5-5": {
		provider: "anthropic",
		price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		structuredOutput: true,
		pdf: true,
		computerUse: true,
		maxOutputTokens: 64_000,
		stronger: "claude-opus-5-5",
	},
	"claude-opus-5-5": {
		provider: "anthropic",
		price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		structuredOutput: true,
		pdf: true,
		computerUse: true,
		maxOutputTokens: 64_000,
	},
	"gpt-6.1-sol": {
		provider: "openai",
		price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		structuredOutput: true,
		pdf: true,
		computerUse: false,
		maxOutputTokens: 64_000,
		stronger: "gpt-6.2-sol",
	},
	"gpt-6.2-sol": {
		provider: "openai",
		price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		structuredOutput: true,
		pdf: true,
		computerUse: false,
		maxOutputTokens: 64_000,
		stronger: "gpt-6.2-astra",
	},
	"gpt-6.2-astra": {
		provider: "openai",
		price: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 },
		structuredOutput: true,
		pdf: true,
		computerUse: false,
		maxOutputTokens: 64_000,
	},
} as const satisfies Record<string, ModelInfo>;

export type ModelId = keyof typeof MODELS;
export type Route = { provider: Provider; model: ModelId };

const anthropic = (model: ModelId & `claude-${string}`): Route => ({ provider: "anthropic", model });
const openai = (model: ModelId & `gpt-${string}`): Route => ({ provider: "openai", model });

const TEXT_TASKS = ["extract", "score", "strategy", "write", "answer", "interview"] as const;
type TextTask = (typeof TEXT_TASKS)[number];

function chains(bulk: Route[], judgement: Route[], browser: Route[]): Record<Task, readonly Route[]> {
	const byTask = Object.fromEntries(
		TEXT_TASKS.map((task) => [task, task === "extract" || task === "score" ? bulk : judgement]),
	) as Record<TextTask, Route[]>;
	return { ...byTask, browser_agent: browser };
}

/**
 * Task → ordered fallback chain, per preset (§12). Only implemented adapters appear, and
 * computer use only on Anthropic. `extract` and `score` are high-volume; the rest need judgement.
 */
export const ROUTES: Record<Preset, Record<Task, readonly Route[]>> = {
	economy: chains(
		[anthropic("claude-haiku-5-5"), openai("gpt-6.1-sol")],
		[anthropic("claude-haiku-5-5"), openai("gpt-6.1-sol")],
		[anthropic("claude-sonnet-5-5")],
	),
	standard: chains(
		[anthropic("claude-haiku-5-5"), openai("gpt-6.1-sol")],
		[anthropic("claude-sonnet-5-5"), openai("gpt-6.2-sol")],
		[anthropic("claude-sonnet-5-5"), anthropic("claude-opus-5-5")],
	),
	best: chains(
		[anthropic("claude-sonnet-5-5"), openai("gpt-6.2-sol")],
		[anthropic("claude-opus-5-5"), openai("gpt-6.2-astra")],
		[anthropic("claude-opus-5-5"), anthropic("claude-sonnet-5-5")],
	),
};

export class UnknownModelError extends Error {
	override name = "UnknownModelError";
}

/** The price table entry for a model. A model without one is a hard error, never a $0 call. */
export function modelInfo(provider: string, model: string): ModelInfo {
	const info = (MODELS as Record<string, ModelInfo>)[model];
	if (!info || info.provider !== provider) throw new UnknownModelError(`no price for ${provider}/${model}`);
	return info;
}

function priceFor(info: ModelInfo, promptTokens: number): Price {
	return info.longContext && promptTokens > info.longContext.threshold ? info.longContext.price : info.price;
}

/** Cost in micro-USD, rounded up. Tokens × USD per million tokens is exactly micro-USD. */
export function costMicroUsd(provider: string, model: string, usage: Usage): number {
	const info = modelInfo(provider, model);
	const price = priceFor(info, usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
	return Math.ceil(
		usage.inputTokens * price.input +
			usage.outputTokens * price.output +
			usage.cacheReadTokens * price.cacheRead +
			usage.cacheWriteTokens * price.cacheWrite,
	);
}

/** The price snapshot stored on every ledger row. */
export function priceSnapshot(provider: string, model: string, promptTokens: number): Price {
	return priceFor(modelInfo(provider, model), promptTokens);
}
