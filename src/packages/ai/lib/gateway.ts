import { createHash } from "node:crypto";
import type { z } from "zod";
import type { Db } from "../../db/index";
import type { UserId } from "../../db/ownership";
import type { Logger } from "../../log/index";
import type { Secrets } from "../../secrets/index";
import {
	type AdapterResponse,
	type FetchLike,
	guardedFetch,
	liveCallBlocked,
	type ProviderAdapter,
	pdfBytes,
	textOf,
} from "./adapter";
import { createAnthropicAdapter } from "./anthropic";
import { canonicalSchema, schemaHash } from "./dialect";
import { loadKeySetters } from "./keys";
import { finalise, markUnhealthy, readSettings, reserve, unhealthyScopes } from "./ledger";
import { costMicroUsd, MODELS, type ModelId, ROUTES, type Route } from "./models";
import { createOpenAIAdapter } from "./openai";
import {
	type Attribution,
	BudgetExceeded,
	type CallReceipt,
	type ComputerStep,
	type Fingerprint,
	type GenerateResult,
	type LlmClient,
	LlmError,
	type Message,
	NoViableRoute,
	type Provider,
	type Task,
} from "./types";

export type LlmClientOptions = {
	db: Db;
	secrets: Secrets;
	/** Defaults to the real `fetch`, which refuses to run under Vitest unless `LLM_LIVE=1`. */
	fetch?: FetchLike;
	log?: Logger;
	/** Waits before the two in-call retries of a transient failure. */
	retryDelaysMs?: readonly [number, number];
	/** How long a scope stays unhealthy after a transient (retries exhausted) or shared failure. */
	cooldownSeconds?: { transient: number; shared: number };
};

const DEFAULT_MAX_OUTPUT: Record<Task, number> = {
	extract: 4096,
	score: 2048,
	strategy: 8192,
	write: 8192,
	answer: 4096,
	interview: 2048,
	classify: 256,
	browser_agent: 4096,
};

// Conservative token estimates for reservations: ~3 characters per token, ~3 PDF bytes per
// token (pages are processed as images too), and a full-size screenshot per action result.
const CHARS_PER_TOKEN = 3;
const PDF_BYTES_PER_TOKEN = 3;
const SCREENSHOT_TOKENS = 1600;

type Needs = { structured: boolean; pdf: boolean; computer: boolean };
type Candidate = Route & { apiKey: () => Promise<string> };

/** What every attempt of one gateway call shares: for reservations, fingerprints and the payload row. */
type CallBase = {
	task: Task;
	attribution: Attribution;
	maxOutputTokens: number | undefined;
	promptTokens: number;
	schemaHash: string | null;
	payload: unknown;
};

const scopeName = (scope: string, route: Route) =>
	scope === "key"
		? `key:${route.provider}`
		: scope === "provider"
			? `provider:${route.provider}`
			: `model:${route.provider}/${route.model}`;

const routeScopes = (route: Route) => ["key", "provider", "model"].map((scope) => scopeName(scope, route));

/**
 * The AI gateway (§12): routes a task to a model, checks and reserves budget, calls the
 * provider, re-validates structured output, records the ledger and falls back.
 */
export function createLlmClient(options: LlmClientOptions): LlmClient {
	const { db, secrets, log } = options;
	const fetch = options.fetch ?? guardedFetch;
	const adapters: Record<Provider, ProviderAdapter> = {
		anthropic: createAnthropicAdapter(fetch),
		openai: createOpenAIAdapter(fetch),
	};
	const retryDelays = options.retryDelaysMs ?? [1_000, 4_000];
	const cooldown = options.cooldownSeconds ?? { transient: 60, shared: 300 };

	const fingerprint = (base: CallBase, route: Route | null, errorClass: string): Fingerprint => ({
		task: base.task,
		provider: route?.provider ?? null,
		model: route?.model ?? null,
		errorClass,
		schemaHash: base.schemaHash,
	});

	const maxOutput = (base: CallBase, route: Route) =>
		Math.min(base.maxOutputTokens ?? DEFAULT_MAX_OUTPUT[base.task], MODELS[route.model].maxOutputTokens);

	/** The task's chain for the User's preset, keeping capable routes; missing keys become blocked scopes. */
	async function plan(task: Task, owner: UserId, needs: Needs) {
		const settings = await readSettings(db, owner);
		const preset = settings.taskPresets[task] ?? settings.preset;
		const keys = await loadKeySetters(db, secrets, owner);
		const unhealthy = await unhealthyScopes(db, owner);
		const blocked = new Set<string>();
		const candidates: Candidate[] = [];
		for (const route of ROUTES[preset][task]) {
			const info = MODELS[route.model];
			if ((needs.structured && !info.structuredOutput) || (needs.pdf && !info.pdf)) continue;
			if (needs.computer && !info.computerUse) continue;
			const apiKey = keys.get(route.provider);
			if (!apiKey) blocked.add(`key:${route.provider}`);
			else candidates.push({ ...route, apiKey });
		}
		return { candidates, blocked, unhealthy };
	}

	/** One provider request: reserve under the cap, call, finalise. Provider errors become `LlmError`s. */
	async function callOnce(
		base: CallBase,
		route: Candidate,
		invoke: (maxOutputTokens: number) => Promise<AdapterResponse>,
	): Promise<{ response: AdapterResponse; receipt: CallReceipt }> {
		const maxOutputTokens = maxOutput(base, route);
		const reservedMicroUsd = costMicroUsd(route.provider, route.model, {
			inputTokens: base.promptTokens,
			outputTokens: maxOutputTokens,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		const reservation = await reserve(db, {
			task: base.task,
			provider: route.provider,
			model: route.model,
			reservedMicroUsd,
			promptTokensEstimate: base.promptTokens,
			attribution: base.attribution,
			request: base.payload,
		});
		if (!reservation.ok) {
			throw new BudgetExceeded(
				fingerprint(base, route, "budget_exceeded"),
				reservation.capMicroUsd / 1e6,
				reservation.spentMicroUsd / 1e6,
			);
		}
		const { callId } = reservation;
		const owner = base.attribution.userId;
		let response: AdapterResponse;
		try {
			response = await invoke(maxOutputTokens);
		} catch (error) {
			throw await failed(base, route, callId, error);
		}
		const measured = response.usage ? costMicroUsd(route.provider, route.model, response.usage) : null;
		await finalise(db, owner, callId, {
			measuredMicroUsd: measured,
			usage: response.usage,
			requestId: response.requestId,
			outcome: response.stop === "end" || response.stop === "tool_use" ? "ok" : response.stop,
			response: { text: response.text, ...(response.actions ? { actions: response.actions } : {}) },
		});
		const usage = response.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
		return {
			response,
			receipt: { callId, provider: route.provider, model: route.model, usage, costUsd: (measured ?? 0) / 1e6 },
		};
	}

	/** Finalises a failed call and returns what to throw. Non-provider errors (bugs, aborts) are returned as is. */
	async function failed(base: CallBase, route: Candidate, callId: string, error: unknown): Promise<unknown> {
		const classified = adapters[route.provider].classify(error);
		const owner = base.attribution.userId;
		if (!classified) {
			const blocked = liveCallBlocked(error);
			// A blocked call never left the process; anything else may have been sent, so it keeps its reservation.
			await finalise(db, owner, callId, {
				measuredMicroUsd: blocked ? 0 : null,
				usage: null,
				requestId: null,
				outcome: blocked ? "blocked" : "unknown",
			});
			return blocked ?? error;
		}
		const fp = fingerprint(base, route, classified.errorClass);
		await finalise(db, owner, callId, {
			// A refused request is not billed; a request whose fate is unknown keeps its reservation.
			measuredMicroUsd: classified.fateKnown ? 0 : null,
			usage: null,
			requestId: null,
			outcome: classified.fateKnown ? classified.errorClass : "unknown",
			error: { kind: classified.kind, scope: classified.scope, fingerprint: fp },
		});
		log?.warn({
			event: "ai_call_failed",
			task: base.task,
			provider: route.provider,
			model: route.model,
			errorClass: classified.errorClass,
			kind: classified.kind,
			scope: classified.scope,
			status: classified.status,
		});
		return new LlmError(
			`${route.provider}/${route.model}: ${classified.errorClass}`,
			classified.kind,
			classified.scope,
			fp,
			{ cause: error },
		);
	}

	/** `callOnce` with the two in-call retries for transient failures (§12). */
	async function callWithRetries(
		base: CallBase,
		route: Candidate,
		invoke: (maxOutputTokens: number) => Promise<AdapterResponse>,
		retryable: () => boolean = () => true,
	) {
		for (let attempt = 0; ; attempt++) {
			try {
				return await callOnce(base, route, invoke);
			} catch (error) {
				const delay = retryDelays[attempt];
				if (!(error instanceof LlmError) || error.kind !== "transient" || delay === undefined) throw error;
				if (!retryable()) throw error;
				await sleep(delay * (0.75 + Math.random() * 0.5));
			}
		}
	}

	/**
	 * Tries each viable route in order. A transient failure (after retries) or a shared one
	 * marks its scope unhealthy for every process and moves on; budget and deterministic
	 * failures stop the call. Throws `NoViableRoute` when nothing is left.
	 */
	async function runChain<R>(base: CallBase, needs: Needs, run: (route: Candidate) => Promise<R>): Promise<R> {
		const owner = base.attribution.userId;
		const { candidates, blocked, unhealthy } = await plan(base.task, owner, needs);
		const failures: LlmError[] = [];
		for (const route of candidates) {
			const sick = routeScopes(route).find((scope) => unhealthy.has(scope));
			if (sick) {
				blocked.add(sick);
				continue;
			}
			try {
				return await run(route);
			} catch (error) {
				if (!(error instanceof LlmError) || error instanceof BudgetExceeded || error.kind === "deterministic") {
					throw error;
				}
				failures.push(error);
				const scope = scopeName(error.scope, route);
				await markUnhealthy(
					db,
					owner,
					scope,
					error.fingerprint.errorClass,
					error.kind === "transient" ? cooldown.transient : cooldown.shared,
				);
				unhealthy.add(scope);
				blocked.add(scope);
			}
		}
		throw new NoViableRoute(fingerprint(base, null, "no_viable_route"), [...blocked], failures);
	}

	function stronger(route: Candidate): Candidate | null {
		const next = (MODELS[route.model] as { stronger?: ModelId }).stronger;
		return next ? { ...route, model: next } : null;
	}

	return {
		async generate<T>(request: Parameters<LlmClient["generate"]>[0] & { output?: z.ZodType<T> }) {
			const schema = request.output ? canonicalSchema(request.output) : null;
			const base: CallBase = {
				task: request.task,
				attribution: request.attribution,
				maxOutputTokens: request.maxOutputTokens,
				promptTokens: estimatePrompt(request.system, request.messages),
				schemaHash: schema ? schemaHash(schema) : null,
				payload: payloadOf(request.system, request.messages, schema),
			};
			const needs = { structured: schema !== null, pdf: pdfBytes(request.messages) > 0, computer: false };

			const attempt = async (route: Candidate, escalated: boolean): Promise<GenerateResult<T>> => {
				const adapter = adapters[route.provider];
				if (pdfBytes(request.messages) > adapter.maxPdfBytes) {
					throw new LlmError(
						`${route.provider}: PDF input too large`,
						"deterministic",
						"none",
						fingerprint(base, route, "pdf_too_large"),
					);
				}
				const send = (messages: readonly Message[]) =>
					callWithRetries(base, route, (maxOutputTokens) =>
						adapter.generate({
							apiKey: route.apiKey,
							model: route.model,
							...(request.system ? { system: request.system } : {}),
							messages,
							...(schema ? { output: { name: `${request.task}_output`, schema } } : {}),
							maxOutputTokens,
							...(request.signal ? { signal: request.signal } : {}),
						}),
					);
				const escalate = (errorClass: string, cause?: unknown) => {
					const next = escalated ? null : stronger(route);
					if (next) return attempt(next, true);
					throw new LlmError(
						`${route.provider}/${route.model}: ${errorClass}`,
						"deterministic",
						"model",
						fingerprint(base, route, errorClass),
						{ cause },
					);
				};

				let messages = request.messages;
				let { response, receipt } = await send(messages);
				for (let repaired = false; ; repaired = true) {
					if (response.stop === "refusal") {
						throw new LlmError(
							`${route.provider}/${route.model}: refusal`,
							"deterministic",
							"model",
							fingerprint(base, route, "refusal"),
						);
					}
					if (response.stop === "truncated") return escalate("truncated");
					if (!request.output) return { ...receipt, text: response.text, output: response.text as T };
					const parsed = parseOutput(request.output, response.text);
					if (parsed.success) return { ...receipt, text: response.text, output: parsed.data };
					// One repair attempt on the same model, then the next stronger model once.
					if (repaired) return escalate("schema_violation", parsed.error);
					messages = [
						...messages,
						{ role: "assistant", content: response.text },
						{
							role: "user",
							content: `That reply does not match the required JSON schema: ${parsed.error}. Reply with only the corrected JSON.`,
						},
					];
					({ response, receipt } = await send(messages));
				}
			};
			return runChain(base, needs, (route) => attempt(route, false));
		},

		async *stream(request) {
			const base: CallBase = {
				task: request.task,
				attribution: request.attribution,
				maxOutputTokens: request.maxOutputTokens,
				promptTokens: estimatePrompt(request.system, request.messages),
				schemaHash: null,
				payload: payloadOf(request.system, request.messages, null),
			};
			const needs = { structured: false, pdf: pdfBytes(request.messages) > 0, computer: false };
			// Deltas cannot be taken back, so fallback and retries stop once the first one is out.
			let yielded = false;
			const queue: Array<{ delta: string }> = [];
			let wake: (() => void) | null = null;
			let finished: GenerateResult<string> | null = null;
			let failure: { error: unknown } | null = null;

			const run = runChain(base, needs, async (route) => {
				const adapter = adapters[route.provider];
				const result = await callWithRetries(
					base,
					route,
					async (maxOutputTokens) => {
						let final: AdapterResponse | null = null;
						for await (const chunk of adapter.stream({
							apiKey: route.apiKey,
							model: route.model,
							...(request.system ? { system: request.system } : {}),
							messages: request.messages,
							maxOutputTokens,
							...(request.signal ? { signal: request.signal } : {}),
						})) {
							if ("delta" in chunk) {
								yielded = true;
								queue.push(chunk);
								wake?.();
							} else final = chunk.response;
						}
						if (!final) throw new Error("the stream ended without a result");
						return final;
					},
					() => !yielded,
				).catch((error) => {
					// After the first delta a failure is final: no fallback to another route either.
					if (error instanceof LlmError && yielded && error.kind !== "deterministic") {
						throw new LlmError(error.message, "deterministic", error.scope, error.fingerprint, { cause: error });
					}
					throw error;
				});
				if (result.response.stop === "refusal") {
					throw new LlmError(
						`${route.provider}/${route.model}: refusal`,
						"deterministic",
						"model",
						fingerprint(base, route, "refusal"),
					);
				}
				return { ...result.receipt, text: result.response.text, output: result.response.text };
			});
			run.then(
				(result) => {
					finished = result;
					wake?.();
				},
				(error) => {
					failure = { error };
					wake?.();
				},
			);
			while (true) {
				const next = queue.shift();
				if (next) {
					yield { type: "text", delta: next.delta };
					continue;
				}
				if (failure) throw (failure as { error: unknown }).error;
				if (finished) {
					yield { type: "done", result: finished };
					return;
				}
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				wake = null;
			}
		},

		async computerTurn(request) {
			const base: CallBase = {
				task: "browser_agent",
				attribution: request.attribution,
				maxOutputTokens: request.maxOutputTokens,
				promptTokens: estimateComputerPrompt(request.system, request.instruction, request.steps),
				schemaHash: null,
				payload: {
					system: request.system ?? null,
					instruction: request.instruction,
					steps: request.steps.map((step) => ({
						text: step.text,
						actions: step.actions,
						results: step.results.map((r) => ({
							id: r.id,
							screenshotBytes: r.screenshot?.length ?? 0,
							error: r.error,
						})),
					})),
				},
			};
			return runChain(base, { structured: false, pdf: false, computer: true }, async (route) => {
				const adapter = adapters[route.provider];
				const turn = adapter.computerTurn;
				if (!turn) throw new Error(`${route.provider} has no computer-use adapter`);
				const { response, receipt } = await callWithRetries(base, route, (maxOutputTokens) =>
					turn({
						apiKey: route.apiKey,
						model: route.model,
						...(request.system ? { system: request.system } : {}),
						instruction: request.instruction,
						steps: request.steps,
						maxOutputTokens,
						...(request.signal ? { signal: request.signal } : {}),
					}),
				);
				if (response.stop === "refusal" || response.stop === "truncated") {
					throw new LlmError(
						`${route.provider}/${route.model}: ${response.stop}`,
						"deterministic",
						"model",
						fingerprint(base, route, response.stop),
					);
				}
				const actions = response.actions ?? [];
				return { ...receipt, text: response.text, actions, done: actions.length === 0 };
			});
		},
	};
}

function parseOutput<T>(
	schema: z.ZodType<T>,
	text: string,
): { success: true; data: T } | { success: false; error: string } {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return { success: false, error: "not valid JSON" };
	}
	const result = schema.safeParse(json);
	if (result.success) return { success: true, data: result.data };
	return {
		success: false,
		error: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
	};
}

function estimatePrompt(system: string | undefined, messages: readonly Message[]): number {
	const chars = (system?.length ?? 0) + messages.reduce((sum, m) => sum + textOf(m.content).length, 0);
	return Math.ceil(chars / CHARS_PER_TOKEN) + Math.ceil(pdfBytes(messages) / PDF_BYTES_PER_TOKEN);
}

function estimateComputerPrompt(
	system: string | undefined,
	instruction: string,
	steps: readonly ComputerStep[],
): number {
	let chars = (system?.length ?? 0) + instruction.length;
	let screenshots = 0;
	for (const step of steps) {
		chars += step.text.length + JSON.stringify(step.actions).length;
		screenshots += step.results.filter((r) => r.screenshot).length;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN) + screenshots * SCREENSHOT_TOKENS;
}

/** The request as stored in `ai_call_payload`: PDFs by size and hash, not their bytes. */
function payloadOf(system: string | undefined, messages: readonly Message[], schema: object | null) {
	return {
		system: system ?? null,
		messages: messages.map((m) => ({
			role: m.role,
			content:
				typeof m.content === "string"
					? m.content
					: m.content.map((part) =>
							part.type === "text"
								? part
								: {
										type: "pdf",
										bytes: part.data.length,
										sha256: createHash("sha256").update(part.data).digest("hex"),
									},
						),
		})),
		outputSchema: schema,
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
