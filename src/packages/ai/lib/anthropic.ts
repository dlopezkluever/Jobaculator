import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import {
	type AdapterRequest,
	type AdapterResponse,
	type Classified,
	type ComputerAdapterRequest,
	classifyStatus,
	type FetchLike,
	liveCallBlocked,
	NETWORK_ERROR,
	type ProviderAdapter,
	type Stop,
} from "./adapter";
import { anthropicSchema } from "./dialect";
import type { ComputerAction, Message, ProposedAction, Usage } from "./types";

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;

// Members of `computer_toolset_20260801` the neutral vocabulary has no action for are withheld from the model.
const DISABLED_MEMBERS = ["hold_key", "cursor_position", "left_mouse_down", "left_mouse_up", "middle_click", "zoom"];

/** Anthropic Messages API over `@anthropic-ai/sdk`: text, structured output, PDF and computer use. */
export function createAnthropicAdapter(fetch: FetchLike): ProviderAdapter {
	const client = (apiKey: () => Promise<string>) => new Anthropic({ apiKey, fetch, maxRetries: 0 });

	function params(request: AdapterRequest) {
		return {
			model: request.model,
			max_tokens: request.maxOutputTokens,
			...(request.system ? { system: request.system } : {}),
			messages: request.messages.map(toMessageParam),
			...(request.output
				? {
						output_config: { format: { type: "json_schema" as const, schema: anthropicSchema(request.output.schema) } },
					}
				: {}),
		};
	}

	return {
		provider: "anthropic",
		// 128 MB request limit; base64 inflates by 4/3, so keep the raw PDFs well under it.
		maxPdfBytes: 90 * 1024 * 1024,

		async generate(request) {
			const { data, request_id } = await client(request.apiKey)
				.messages.create(params(request), { signal: request.signal })
				.withResponse();
			return fromMessage(data, request_id ?? null);
		},

		async *stream(request) {
			const stream = client(request.apiKey).messages.stream(params(request), { signal: request.signal });
			for await (const event of stream) {
				if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
					yield { delta: event.delta.text };
				}
			}
			yield { response: fromMessage(await stream.finalMessage(), stream.request_id ?? null) };
		},

		async computerTurn(request) {
			const { data, request_id } = await client(request.apiKey)
				.messages.create(
					{
						model: request.model,
						max_tokens: request.maxOutputTokens,
						...(request.system ? { system: request.system } : {}),
						tools: [
							{
								type: "computer_toolset_20260801",
								configs: Object.fromEntries(DISABLED_MEMBERS.map((name) => [name, { enabled: false }])),
							},
						],
						messages: computerMessages(request),
					},
					{ signal: request.signal },
				)
				.withResponse();
			return fromMessage(data, request_id ?? null);
		},

		classify(error): Classified | null {
			if (error instanceof APIUserAbortError || liveCallBlocked(error)) return null;
			if (error instanceof APIConnectionError) return NETWORK_ERROR;
			if (error instanceof APIError && typeof error.status === "number") return classifyStatus(error.status);
			return null;
		},
	};
}

function toMessageParam(message: Message): MessageParam {
	if (typeof message.content === "string") return { role: message.role, content: message.content };
	return {
		role: message.role,
		content: message.content.map(
			(part): ContentBlockParam =>
				part.type === "text"
					? { type: "text", text: part.text }
					: {
							type: "document",
							source: { type: "base64", media_type: "application/pdf", data: part.data.toString("base64") },
							...(part.filename ? { title: part.filename } : {}),
						},
		),
	};
}

function computerMessages(request: ComputerAdapterRequest): MessageParam[] {
	const messages: MessageParam[] = [{ role: "user", content: request.instruction }];
	for (const step of request.steps) {
		const content: ContentBlockParam[] = step.text ? [{ type: "text", text: step.text }] : [];
		for (const { id, action } of step.actions) {
			const { name, input } = toMember(action);
			content.push({ type: "tool_use", id, name, input, toolset_name: "computer" });
		}
		messages.push({ role: "assistant", content });
		// Every tool_use is answered; one without a result (the batch stopped early) is an error.
		messages.push({
			role: "user",
			content: step.actions.map(({ id }): ContentBlockParam => {
				const result = step.results.find((r) => r.id === id);
				if (!result || result.error !== undefined) {
					return {
						type: "tool_result",
						tool_use_id: id,
						toolset_name: "computer",
						is_error: true,
						content: result?.error ?? "not executed: an earlier action in this batch failed",
					};
				}
				return {
					type: "tool_result",
					tool_use_id: id,
					toolset_name: "computer",
					content: result.screenshot
						? [
								{
									type: "image",
									source: { type: "base64", media_type: "image/png", data: result.screenshot.toString("base64") },
								},
							]
						: "done",
				};
			}),
		});
	}
	return messages;
}

type Member = { name: string; input: Record<string, unknown> };

function toMember(action: ComputerAction): Member {
	const at = (x?: number, y?: number) => (x === undefined || y === undefined ? {} : { coordinate: [x, y] });
	switch (action.type) {
		case "screenshot":
			return { name: "screenshot", input: {} };
		case "click": {
			const name =
				action.button === "right"
					? "right_click"
					: action.count === 3
						? "triple_click"
						: action.count === 2
							? "double_click"
							: "left_click";
			return { name, input: { ...at(action.x, action.y), ...(action.modifiers ? { text: action.modifiers } : {}) } };
		}
		case "move":
			return { name: "mouse_move", input: { coordinate: [action.x, action.y] } };
		case "drag":
			return {
				name: "left_click_drag",
				input: { start_coordinate: [action.from.x, action.from.y], coordinate: [action.to.x, action.to.y] },
			};
		case "type":
			return { name: "type", input: { text: action.text } };
		case "key":
			return { name: "key", input: { text: action.keys, ...(action.repeat ? { repeat: action.repeat } : {}) } };
		case "scroll":
			return {
				name: "scroll",
				input: { ...at(action.x, action.y), scroll_direction: action.direction, scroll_amount: action.amount },
			};
		case "wait":
			return { name: "wait", input: { duration: action.seconds } };
	}
}

const point = (value: unknown): { x: number; y: number } | undefined =>
	Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number"
		? { x: value[0], y: value[1] }
		: undefined;

/** Maps one member call to a neutral action; null for anything malformed or outside the vocabulary. */
function fromMember(name: string, input: Record<string, unknown>): ComputerAction | null {
	const at = point(input.coordinate);
	const modifiers = typeof input.text === "string" ? { modifiers: input.text } : {};
	const click = (button: "left" | "right", count: 1 | 2 | 3): ComputerAction => ({
		type: "click",
		button,
		count,
		...(at ?? {}),
		...modifiers,
	});
	switch (name) {
		case "screenshot":
			return { type: "screenshot" };
		case "left_click":
			return click("left", 1);
		case "double_click":
			return click("left", 2);
		case "triple_click":
			return click("left", 3);
		case "right_click":
			return click("right", 1);
		case "mouse_move":
			return at ? { type: "move", ...at } : null;
		case "left_click_drag": {
			const from = point(input.start_coordinate);
			return from && at ? { type: "drag", from, to: at } : null;
		}
		case "type":
			return typeof input.text === "string" ? { type: "type", text: input.text } : null;
		case "key":
			return typeof input.text === "string"
				? { type: "key", keys: input.text, ...(typeof input.repeat === "number" ? { repeat: input.repeat } : {}) }
				: null;
		case "scroll": {
			const direction = input.scroll_direction;
			if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") return null;
			const amount = typeof input.scroll_amount === "number" ? input.scroll_amount : 3;
			return { type: "scroll", direction, amount, ...(at ?? {}) };
		}
		case "wait":
			return { type: "wait", seconds: typeof input.duration === "number" ? input.duration : 1 };
		default:
			return null;
	}
}

const STOPS: Record<string, Stop> = {
	end_turn: "end",
	stop_sequence: "end",
	max_tokens: "truncated",
	model_context_window_exceeded: "truncated",
	refusal: "refusal",
	tool_use: "tool_use",
	pause_turn: "end",
};

function fromMessage(message: Anthropic.Message, requestId: string | null): AdapterResponse {
	let text = "";
	const actions: ProposedAction[] = [];
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
		if (block.type === "tool_use" && "toolset_name" in block && block.toolset_name === "computer") {
			const action = fromMember(block.name, (block.input ?? {}) as Record<string, unknown>);
			// An action outside the vocabulary becomes a screenshot, so the model sees the page and can re-plan.
			actions.push({ id: block.id, action: action ?? { type: "screenshot" } });
		}
	}
	const usage: Usage = {
		inputTokens: message.usage.input_tokens,
		outputTokens: message.usage.output_tokens,
		cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
		cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
	};
	return {
		text,
		stop: STOPS[message.stop_reason ?? "end_turn"] ?? "end",
		usage,
		requestId,
		...(actions.length > 0 ? { actions } : {}),
	};
}
