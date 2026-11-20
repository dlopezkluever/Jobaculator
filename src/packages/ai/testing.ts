import { randomUUID } from "node:crypto";
import {
	BudgetExceeded,
	type ComputerTurnRequest,
	type FailureKind,
	type FailureScope,
	type GenerateRequest,
	type LlmClient,
	LlmError,
	NoViableRoute,
	type ProposedAction,
	type StreamRequest,
	type Task,
	type Usage,
} from "./index";

/**
 * Test-only: `ScriptedLlm` implements `LlmClient` for consumer tests (§12). It answers each
 * call with the next scripted step, in order, and records every request. A structured
 * step's `output` is validated against the caller's schema, so a script that drifts from
 * the consumer's schema fails the test instead of passing silently.
 */

export type ScriptStep = {
	/** When set, the call must be for this task. */
	task?: Task;
	usage?: Partial<Usage>;
	costUsd?: number;
} & (
	| { output: unknown; text?: string }
	| { text: string }
	| { actions: ProposedAction[]; text?: string }
	| { error: LlmError }
);

export type ScriptedCall =
	| { method: "generate"; request: GenerateRequest<unknown> }
	| { method: "stream"; request: StreamRequest }
	| { method: "computerTurn"; request: ComputerTurnRequest };

export type ScriptedLlm = LlmClient & {
	readonly calls: readonly ScriptedCall[];
	/** Steps not yet used; assert 0 at the end of a test that expects the whole script to run. */
	remaining(): number;
};

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function createScriptedLlm(script: readonly ScriptStep[]): ScriptedLlm {
	const steps = [...script];
	const calls: ScriptedCall[] = [];

	function next(task: Task): Exclude<ScriptStep, { error: LlmError }> {
		const step = steps.shift();
		if (!step) throw new Error(`ScriptedLlm: no scripted step left for a ${task} call`);
		if (step.task && step.task !== task) throw new Error(`ScriptedLlm: expected a ${step.task} call, got ${task}`);
		if ("error" in step) throw step.error;
		return step;
	}

	const receipt = (step: ScriptStep) => ({
		callId: randomUUID(),
		provider: "anthropic" as const,
		model: "scripted",
		usage: { ...ZERO_USAGE, ...step.usage },
		costUsd: step.costUsd ?? 0,
	});

	return {
		calls,
		remaining: () => steps.length,

		async generate<T>(request: GenerateRequest<T>) {
			calls.push({ method: "generate", request: request as GenerateRequest<unknown> });
			const step = next(request.task);
			if (request.output) {
				if (!("output" in step)) throw new Error("ScriptedLlm: a structured call needs a step with `output`");
				const output = request.output.parse(step.output);
				return { ...receipt(step), text: step.text ?? JSON.stringify(step.output), output };
			}
			if (!("text" in step) || step.text === undefined) throw new Error("ScriptedLlm: a text call needs `text`");
			return { ...receipt(step), text: step.text, output: step.text as T };
		},

		async *stream(request) {
			calls.push({ method: "stream", request });
			const step = next(request.task);
			if (!("text" in step) || step.text === undefined) throw new Error("ScriptedLlm: a stream call needs `text`");
			// One delta per word, so consumers see more than one chunk.
			for (const delta of step.text.match(/\S+\s*|\s+/g) ?? []) yield { type: "text", delta };
			yield { type: "done", result: { ...receipt(step), text: step.text, output: step.text } };
		},

		async computerTurn(request) {
			calls.push({ method: "computerTurn", request });
			const step = next("browser_agent");
			const actions = "actions" in step ? step.actions : [];
			return { ...receipt(step), text: step.text ?? "", actions, done: actions.length === 0 };
		},
	};
}

const fingerprintFor = (task: Task, errorClass: string) => ({
	task,
	provider: null,
	model: null,
	errorClass,
	schemaHash: null,
});

/** A typed gateway failure for a script step, e.g. `{ error: llmFailure("score", "transient", "model", "rate_limited") }`. */
export function llmFailure(task: Task, kind: FailureKind, scope: FailureScope, errorClass: string): LlmError {
	return new LlmError(`scripted ${errorClass}`, kind, scope, fingerprintFor(task, errorClass));
}

export function budgetExceeded(task: Task, capUsd = 1, spentUsd = 1): BudgetExceeded {
	return new BudgetExceeded(fingerprintFor(task, "budget_exceeded"), capUsd, spentUsd);
}

export function noViableRoute(task: Task, scopes: readonly string[]): NoViableRoute {
	return new NoViableRoute(fingerprintFor(task, "no_viable_route"), scopes, []);
}
