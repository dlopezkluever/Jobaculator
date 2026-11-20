import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDatabase, type TestDatabase } from "../../db/testing";
import { getAiSettings, LlmError } from "../index";
import { client, KEYS, ledger, newUser } from "./helpers";
import { fixtureFetch } from "./replay";

// Adapter contract tests: each scenario replays a committed fixture through the real
// provider SDK, so they pin what we send (dialect, PDF, tool results) and what we parse
// (text, usage, stop reasons). `pnpm test:record-llm` re-records the fixtures live.

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(() => database.close());

const profile = z.object({
	title: z.string().min(1),
	years: z.number().int().min(0).max(50),
	skills: z.array(z.string()).min(2).max(10),
	remote: z.boolean().optional(),
});
const pdf = Buffer.from("%PDF-1.4\n% a tiny test document\n");
const messages = [
	{
		role: "user" as const,
		content: [
			{ type: "text" as const, text: "Extract the candidate's profile from this resume." },
			{ type: "pdf" as const, data: pdf, filename: "resume.pdf" },
		],
	},
];

type Body = Record<string, unknown> & { messages: Array<{ role: string; content: unknown }> };

describe("anthropic adapter", () => {
	it("sends PDF and a converted schema, re-validates the output, and records measured cost and attribution", async () => {
		const owner = await newUser(database.db, ["anthropic", "openai"]);
		const fetch = fixtureFetch("anthropic-structured-pdf");
		const result = await client(database.db, fetch).generate({
			task: "extract",
			attribution: { userId: owner, applicationId: "8d1c0b54-0f7e-4c39-9b8c-6f1f3a2e7d10" },
			system: "You extract structured facts.",
			messages,
			output: profile,
		});
		fetch.save();

		expect(result.output).toEqual({ title: "Staff Engineer", years: 7, skills: ["TypeScript", "Postgres"] });
		expect(result).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" });
		// 1200 × $0.10 + 80 × $0.50 + 1000 cache reads × $0.01 per million tokens.
		expect(result.costUsd).toBeCloseTo(0.00017, 9);

		const [request] = fetch.requests;
		// The sealed key is opened by the SDK's apiKey setter and sent only in this header.
		expect(request?.headers.get("authorization")).toBe(`Bearer ${KEYS.anthropic}`);
		const body = request?.body as Body;
		expect(body.model).toBe("claude-haiku-5-5");
		expect(body.system).toBe("You extract structured facts.");
		expect(body.messages[0]?.content).toEqual([
			{ type: "text", text: "Extract the candidate's profile from this resume." },
			{
				type: "document",
				source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") },
				title: "resume.pdf",
			},
		]);
		// Anthropic rejects numeric and length constraints and needs closed objects; minItems > 1 becomes 1.
		expect(body.output_config).toEqual({
			format: {
				type: "json_schema",
				schema: {
					type: "object",
					properties: {
						title: { type: "string" },
						years: { type: "integer" },
						skills: { type: "array", items: { type: "string" }, minItems: 1 },
						remote: { type: "boolean" },
					},
					required: ["title", "years", "skills"],
					additionalProperties: false,
				},
			},
		});

		const [row] = await ledger(database.db, owner);
		expect(row).toMatchObject({
			provider: "anthropic",
			model: "claude-haiku-5-5",
			task: "extract",
			measured: 170,
			outcome: "ok",
			application_id: "8d1c0b54-0f7e-4c39-9b8c-6f1f3a2e7d10",
			hunt_id: null,
			request_id: "req_011CXanthropic01",
			price_table_version: "2026-11-20",
		});
		expect(row?.reserved).toBeGreaterThan(170);
		expect((await getAiSettings(database.db, owner)).spentTodayUsd).toBeCloseTo(0.00017, 9);
	});

	it("streams text deltas, then the finalised result", async () => {
		const owner = await newUser(database.db, ["anthropic"]);
		const fetch = fixtureFetch("anthropic-stream");
		const events = [];
		for await (const event of client(database.db, fetch).stream({
			task: "interview",
			attribution: { userId: owner },
			messages: [{ role: "user", content: "Start the interview." }],
		})) {
			events.push(event);
		}
		fetch.save();

		expect(events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.delta : ""))).toEqual([
			"Tell me about ",
			"your last role.",
		]);
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") return;
		expect(done.result).toMatchObject({ text: "Tell me about your last role.", model: "claude-sonnet-5-5" });
		// 300 × $2 + 12 × $10 per million tokens.
		expect(done.result.costUsd).toBeCloseTo(0.00072, 9);
		expect((fetch.requests[0]?.body as Body | undefined)?.stream).toBe(true);
	});

	it("maps computer-use tool calls to neutral actions and answers every one of them on the next turn", async () => {
		const owner = await newUser(database.db, ["anthropic", "openai"]);
		const fetch = fixtureFetch("anthropic-computer");
		const llm = client(database.db, fetch);
		const attribution = { userId: owner, browserRunId: "1b9f7c0e-6a43-4f0f-9a57-0c7a3c9e2b41" };
		const instruction = "Fill in the first name on the application form.";

		const first = await llm.computerTurn({ attribution, instruction, steps: [] });
		expect(first.done).toBe(false);
		expect(first.actions).toEqual([
			{ id: "toolu_01Click", action: { type: "click", button: "left", count: 1, x: 640, y: 410 } },
			{ id: "toolu_02Type", action: { type: "type", text: "Dana" } },
			// A member outside the vocabulary (zoom is withheld) becomes a screenshot, so the model can re-plan.
			{ id: "toolu_03Zoom", action: { type: "screenshot" } },
		]);
		const firstBody = fetch.requests[0]?.body as Body;
		expect(firstBody.model).toBe("claude-sonnet-5-5");
		expect(firstBody.tools).toEqual([
			{
				type: "computer_toolset_20260801",
				configs: Object.fromEntries(
					["hold_key", "cursor_position", "left_mouse_down", "left_mouse_up", "middle_click", "zoom"].map((name) => [
						name,
						{ enabled: false },
					]),
				),
			},
		]);

		const screenshot = Buffer.from("png-bytes");
		const second = await llm.computerTurn({
			attribution,
			instruction,
			steps: [
				{
					text: first.text,
					actions: first.actions,
					// The executor stopped after the typing failed, so the third action has no result.
					results: [
						{ id: "toolu_01Click", screenshot },
						{ id: "toolu_02Type", error: "no focused field" },
					],
				},
			],
		});
		fetch.save();
		expect(second).toMatchObject({ done: true, actions: [], text: "The name field is filled." });

		const secondBody = fetch.requests[1]?.body as Body;
		expect(secondBody.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(secondBody.messages[1]?.content).toEqual([
			{ type: "text", text: "I'll open the form and fill in the name." },
			{
				type: "tool_use",
				id: "toolu_01Click",
				name: "left_click",
				input: { coordinate: [640, 410] },
				toolset_name: "computer",
			},
			{ type: "tool_use", id: "toolu_02Type", name: "type", input: { text: "Dana" }, toolset_name: "computer" },
			{ type: "tool_use", id: "toolu_03Zoom", name: "screenshot", input: {}, toolset_name: "computer" },
		]);
		expect(secondBody.messages[2]?.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "toolu_01Click",
				toolset_name: "computer",
				content: [
					{ type: "image", source: { type: "base64", media_type: "image/png", data: screenshot.toString("base64") } },
				],
			},
			{
				type: "tool_result",
				tool_use_id: "toolu_02Type",
				toolset_name: "computer",
				is_error: true,
				content: "no focused field",
			},
			{
				type: "tool_result",
				tool_use_id: "toolu_03Zoom",
				toolset_name: "computer",
				is_error: true,
				content: "not executed: an earlier action in this batch failed",
			},
		]);

		const rows = await ledger(database.db, owner);
		expect(rows.map((r) => [r.task, r.measured])).toEqual([
			["browser_agent", 5900],
			["browser_agent", 8550],
		]);
	});
});

describe("openai adapter", () => {
	it("sends PDF as input_file and a strict-or-not schema, and prices cached input separately", async () => {
		// No Anthropic key: the extract chain's first route is skipped for the OpenAI one.
		const owner = await newUser(database.db, ["openai"]);
		const fetch = fixtureFetch("openai-structured-pdf");
		const result = await client(database.db, fetch).generate({
			task: "extract",
			attribution: { userId: owner },
			system: "You extract structured facts.",
			messages,
			output: profile,
		});
		fetch.save();

		expect(result.output).toEqual({ title: "Staff Engineer", years: 7, skills: ["TypeScript", "Postgres"] });
		expect(result).toMatchObject({ provider: "openai", model: "gpt-6.1-sol" });
		// input_tokens includes the 500 cached: 1500 × $2 + 500 × $0.10 + 100 × $10 per million tokens.
		expect(result.costUsd).toBeCloseTo(0.00405, 9);
		expect(result.usage).toEqual({ inputTokens: 1500, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0 });

		const [request] = fetch.requests;
		expect(request?.headers.get("authorization")).toBe(`Bearer ${KEYS.openai}`);
		const body = request?.body as Record<string, unknown> & { input: Array<{ content: unknown }> };
		expect(body).toMatchObject({ model: "gpt-6.1-sol", instructions: "You extract structured facts.", store: false });
		expect(body.input[0]?.content).toEqual([
			{ type: "input_text", text: "Extract the candidate's profile from this resume." },
			{
				type: "input_file",
				filename: "resume.pdf",
				file_data: `data:application/pdf;base64,${pdf.toString("base64")}`,
			},
		]);
		// `remote` is optional, which strict mode cannot express, so the schema goes non-strict.
		// OpenAI keeps the numeric and length constraints; our Zod check runs either way.
		expect(body.text).toEqual({
			format: {
				type: "json_schema",
				name: "extract_output",
				strict: false,
				schema: {
					type: "object",
					properties: {
						title: { type: "string", minLength: 1 },
						years: { type: "integer", minimum: 0, maximum: 50 },
						skills: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 10 },
						remote: { type: "boolean" },
					},
					required: ["title", "years", "skills"],
					additionalProperties: false,
				},
			},
		});
		const [row] = await ledger(database.db, owner);
		expect(row).toMatchObject({ provider: "openai", measured: 4050, outcome: "ok", request_id: "req_openai01" });
	});

	it("reports a refusal as a deterministic model failure, billed and not retried", async () => {
		const owner = await newUser(database.db, ["openai"]);
		const fetch = fixtureFetch("openai-refusal");
		const failure = await client(database.db, fetch)
			.generate({ task: "write", attribution: { userId: owner }, messages: [{ role: "user", content: "Write it." }] })
			.catch((error: unknown) => error);
		fetch.save();

		expect(failure).toBeInstanceOf(LlmError);
		expect(failure).toMatchObject({
			kind: "deterministic",
			scope: "model",
			fingerprint: { task: "write", provider: "openai", model: "gpt-6.2-sol", errorClass: "refusal" },
		});
		expect(fetch.remaining()).toBe(0);
		// A refusal is billed: 400 × $2 + 9 × $10 per million tokens.
		expect((await ledger(database.db, owner)).map((r) => [r.outcome, r.measured])).toEqual([["refusal", 890]]);
	});
});
