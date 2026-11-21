import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from "openai";
import type { ResponseCreateParamsNonStreaming, ResponseInputItem } from "openai/resources/responses/responses";
import {
	type AdapterRequest,
	type AdapterResponse,
	type Classified,
	classifyStatus,
	type FetchLike,
	liveCallBlocked,
	NETWORK_ERROR,
	type ProviderAdapter,
} from "./adapter";
import { openaiSchema } from "./dialect";
import type { Message } from "./types";

/** OpenAI Responses API over `openai`: text, structured output and PDF. No computer use (§12). */
export function createOpenAIAdapter(fetch: FetchLike): ProviderAdapter {
	const client = (apiKey: () => Promise<string>) => new OpenAI({ apiKey, fetch, maxRetries: 0 });

	function params(request: AdapterRequest): ResponseCreateParamsNonStreaming {
		const format = request.output ? openaiSchema(request.output.schema) : null;
		return {
			model: request.model,
			max_output_tokens: request.maxOutputTokens,
			store: false,
			...(request.system ? { instructions: request.system } : {}),
			input: request.messages.map(toInputItem),
			...(request.output && format
				? {
						text: {
							format: { type: "json_schema", name: request.output.name, schema: format.schema, strict: format.strict },
						},
					}
				: {}),
		};
	}

	return {
		provider: "openai",
		// 50 MB per file and per request.
		maxPdfBytes: 36 * 1024 * 1024,

		async generate(request) {
			const { data, request_id } = await client(request.apiKey)
				.responses.create(params(request), { signal: request.signal })
				.withResponse();
			return fromResponse(data, request_id ?? null);
		},

		async *stream(request) {
			const { data: events, request_id } = await client(request.apiKey)
				.responses.create({ ...params(request), stream: true }, { signal: request.signal })
				.withResponse();
			for await (const event of events) {
				if (event.type === "response.output_text.delta") yield { delta: event.delta };
				if (event.type === "response.completed" || event.type === "response.incomplete") {
					yield { response: fromResponse(event.response, request_id ?? null) };
					return;
				}
				if (event.type === "response.failed" || event.type === "error") {
					throw new APIError(500, { message: "the response stream failed" }, "stream failed", new Headers());
				}
			}
			throw new APIConnectionError({ message: "the response stream ended without a result" });
		},

		classify(error): Classified | null {
			if (error instanceof APIUserAbortError || liveCallBlocked(error)) return null;
			if (error instanceof APIConnectionError) return NETWORK_ERROR;
			if (error instanceof APIError && typeof error.status === "number")
				return classifyStatus(error.status, error.code);
			return null;
		},
	};
}

function toInputItem(message: Message): ResponseInputItem {
	if (typeof message.content === "string") return { role: message.role, content: message.content };
	if (message.role === "assistant") {
		return { role: "assistant", content: message.content.map((p) => (p.type === "text" ? p.text : "")).join("") };
	}
	return {
		role: "user",
		content: message.content.map((part) =>
			part.type === "text"
				? { type: "input_text" as const, text: part.text }
				: {
						type: "input_file" as const,
						filename: part.filename ?? "document.pdf",
						file_data: `data:application/pdf;base64,${part.data.toString("base64")}`,
					},
		),
	};
}

function fromResponse(response: OpenAI.Responses.Response, requestId: string | null): AdapterResponse {
	let text = "";
	let refused = false;
	for (const item of response.output) {
		if (item.type !== "message") continue;
		for (const content of item.content) {
			if (content.type === "output_text") text += content.text;
			if (content.type === "refusal") refused = true;
		}
	}
	const reason = response.incomplete_details?.reason;
	const usage = response.usage;
	const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
	const written = usage?.input_tokens_details?.cache_write_tokens ?? 0;
	return {
		text,
		stop: refused || reason === "content_filter" ? "refusal" : response.status === "incomplete" ? "truncated" : "end",
		// OpenAI's input_tokens includes cached and cache-written tokens; ours counts only uncached input.
		usage: usage
			? {
					inputTokens: Math.max(0, usage.input_tokens - cached - written),
					outputTokens: usage.output_tokens,
					cacheReadTokens: cached,
					cacheWriteTokens: written,
				}
			: null,
		requestId,
	};
}
