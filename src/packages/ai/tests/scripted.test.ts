import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { UserId } from "../../db/ownership";
import { BudgetExceeded, LlmError } from "../index";
import { budgetExceeded, createScriptedLlm, llmFailure } from "../testing";

const attribution = { userId: "11111111-1111-4111-8111-111111111111" as UserId };
const fit = z.object({ fit: z.number().int().min(0).max(100) });

describe("ScriptedLlm", () => {
	it("answers in script order with typed outputs and failures, and records the calls", async () => {
		const llm = createScriptedLlm([
			{ task: "score", output: { fit: 82 }, costUsd: 0.002 },
			{ error: llmFailure("score", "transient", "model", "rate_limited") },
			{ error: budgetExceeded("write") },
		]);
		const ask = { task: "score" as const, attribution, messages: [{ role: "user" as const, content: "Score it." }] };

		const result = await llm.generate({ ...ask, output: fit });
		expect(result).toMatchObject({ output: { fit: 82 }, costUsd: 0.002 });
		await expect(llm.generate({ ...ask, output: fit })).rejects.toMatchObject({ kind: "transient", scope: "model" });
		const failure = await llm.generate({ ...ask, task: "write" }).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(BudgetExceeded);
		expect(failure).toBeInstanceOf(LlmError);
		expect(llm.calls.map((c) => c.method)).toEqual(["generate", "generate", "generate"]);
		expect(llm.remaining()).toBe(0);
	});

	it("rejects a scripted output that does not match the caller's schema, and a step for the wrong task", async () => {
		const ask = { task: "score" as const, attribution, messages: [{ role: "user" as const, content: "Score it." }] };
		await expect(createScriptedLlm([{ output: { fit: 140 } }]).generate({ ...ask, output: fit })).rejects.toThrow();
		await expect(createScriptedLlm([{ task: "write", text: "x" }]).generate(ask)).rejects.toThrow(
			"expected a write call",
		);
	});

	it("streams scripted text in several deltas", async () => {
		const llm = createScriptedLlm([{ text: "Tell me about your last role." }]);
		const deltas: string[] = [];
		for await (const event of llm.stream({ task: "interview", attribution, messages: [] })) {
			if (event.type === "text") deltas.push(event.delta);
		}
		expect(deltas.length).toBeGreaterThan(1);
		expect(deltas.join("")).toBe("Tell me about your last role.");
	});
});
