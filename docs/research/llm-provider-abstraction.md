# LLM provider abstraction for BYO keys and structured output

- **Ticket:** [#7](https://github.com/dlopezkluever/Jobaculator/issues/7) (map: [#1](https://github.com/dlopezkluever/Jobaculator/issues/1))
- **Date of research:** 2026-11-03
- **Status:** findings and a recommendation. Final decision is made later with the user. Nothing here is built.
- **Scope:** TypeScript. Providers: Anthropic (primary), OpenAI, Google (deferred but must fit the same seam). PRD sections cited: §42 (no mandated provider), §41 (browser execution), §64 (spend caps), §65 (BYO keys), §72 (secrets).

## Short answer

**Recommend direct first-party SDKs behind a thin in-house `LlmClient` interface.** Anthropic first (`@anthropic-ai/sdk`), OpenAI second (`openai`), Google (`@google/genai`) behind the same seam but not built in Phase 0. The in-house layer owns: schema re-validation, the tool loop, PDF part mapping, a neutral computer-use action vocabulary with one adapter per provider, per-call token-to-cost accounting from a versioned price table, per-user key injection, and error normalization.

Why, in three facts:

1. **Computer use has three incompatible designs** (Anthropic `computer_toolset_20260801`, OpenAI `computer` tool with `computer_call` batches, Gemini `computer_use` with `function_call` intents). PRD §41 needs the browser executor to stay ours, so the abstraction must map to a neutral action set per provider, not hide provider loop semantics behind a framework.
2. **No SDK returns money.** Anthropic's `Usage` type has token counts only, and the Vercel AI SDK's `LanguageModelUsage` also has no cost field. PRD §64's spend caps need cost computed by us in either design, so the raw per-call usage must be preserved; direct SDKs keep it unmodified.
3. **Native structured output drops constraints.** Anthropic's `output_config.format` rejects or ignores most numeric and string-length constraints, and Gemini ignores several too. Schema validation must be ours (zod, re-run on every parsed result) in either design. The Vercel AI SDK additionally switches structured-output mode automatically (`structuredOutputMode: auto` falls back to a JSON tool), which changes behavior by schema shape.

**Runner-up: Vercel AI SDK** (`ai` 7.0.162 with `@ai-sdk/anthropic` 4.0.96). It is the stronger choice for test mocks and multi-provider breadth, and it would be a reasonable pick if we accept its trade-offs: token-only usage, automatic structured-output mode selection, and three major versions in about a year (v5 2025-07-31, v6 2025-12-22, v7 2026-06-25). A framework's major-version churn is more expensive when AI agents write the code against it.

**Not evaluated in depth:** LangChain.js (`@langchain/core` 1.3.4), Mastra (`@mastra/core` 1.81.0), Genkit (`genkit` 1.43.0). Registry facts only (see Sources). They add a framework layer the PRD does not need, but a dedicated pass would be required before ruling them out formally.

## Comparison

| Criterion | Vercel AI SDK (`ai` 7.0.162, `@ai-sdk/anthropic` 4.0.96) | Direct SDKs behind a thin interface (`@anthropic-ai/sdk` 1.4.0, `openai` 7.47.0, `@google/genai` 2.32.0) |
|---|---|---|
| Structured output | `Output.object({ schema })` in `generateText`/`streamText`; auto mode can fall back to a JSON tool | Anthropic `output_config.format` (stable, no beta header) via `messages.parse` + `zodOutputFormat`; OpenAI `text.format` json_schema strict via `responses.parse` + `zodTextFormat`; Gemini `responseJsonSchema` |
| Tool calling | `tool()` with `inputSchema`, `stopWhen`, typed tool-call errors | Native per provider; our loop; our validation |
| PDF input | `type: 'file'` part, `mediaType: 'application/pdf'` | Anthropic `document` block (base64, URL, Files API); OpenAI `input_file` (file_data / file_id / file_url) |
| Streaming | `streamText` with `partialOutputStream`; errors become stream parts | Anthropic `messages.stream()` + `finalMessage()`; OpenAI Responses streaming; Gemini `generateContentStream` (not verified here) |
| Computer use | Anthropic provider-defined tool `computerToolset_20260801`; OpenAI and Gemini computer tools not verified as present | Each provider's own tool and loop; our neutral action adapter |
| Token and cost | `usage` / `totalUsage` with `inputTokenDetails` cache fields; no currency | Anthropic `Usage` (token fields incl. cache), OpenAI `input_tokens_details`, Gemini `usageMetadata`; we compute cost |
| Runtime key injection | `createAnthropic({ apiKey })` per provider instance | `apiKey` accepts a string or an async setter (Anthropic and OpenAI); Google `apiKey?: string` |
| Maturity / types | Versioned majors every ~6 months; strong TS inference; spec V4 mock types | Vendor-maintained; first-party types; features land here first |
| Testability | `ai/test`: `MockLanguageModelV4`, `mockValues`, `simulateReadableStream`; no record/replay | `fetch` option on Anthropic and OpenAI clients (inject a fake or a recorder); no official mocks |

## Findings by criterion

### 1. Structured output and schema validation

- **Anthropic.** `output_config: { format: { type: "json_schema", schema } }` is `featureMetadata.status: stable`, with no beta header. Supported models include `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5`. TypeScript helpers: `zodOutputFormat(zodSchema)` with `client.messages.parse()`; `jsonSchemaOutputFormat` does **not** validate responses. Source: Anthropic structured-outputs docs (`platform.claude.com/docs/en/build-with-claude/structured-outputs.md`); `@anthropic-ai/sdk@1.4.0` `helpers/index.d.ts` exports `zodOutputFormat`; `resources/messages/messages.d.ts` declares `parse<...>(...)`.
  - Not supported (400 if used): recursive schemas, external `$ref`, `minimum`/`maximum`/`multipleOf`, `minLength`/`maxLength`, `maxItems`, `additionalProperties` other than `false`. `minItems` only 0 or 1. Required on objects: `additionalProperties: false`.
  - Helpers transform unsupported constraints into descriptions, and helpers that validate still check the original constraints.
  - `stop_reason: "refusal"` returns HTTP 200 with billed tokens and may not match the schema. `stop_reason: "max_tokens"` may be incomplete. Enum casing may change. Changing `output_config.format` invalidates that thread's prompt cache.
  - Per-request complexity limits: 20 strict tools, 24 optional parameters, 16 union-typed parameters.
- **OpenAI.** `text: { format: { type: "json_schema", strict: true, schema } }` with `openai/helpers/zod` `zodTextFormat` and `client.responses.parse`, read from `output_parsed` (`openai@7.47.0` `helpers/zod.d.ts`). Refusals arrive as a `refusal` content item; incomplete responses have `status: "incomplete"`. The fetched docs page did not state GA status and did not give the supported schema subset (see Gaps).
- **Gemini.** `responseJsonSchema?: unknown` on the generation config (`@google/genai@2.32.0` `dist/genai.d.ts`). The docs page the fetch reached (`aistudio.google.com/docs/structured-output`) describes a `response_format` shape on the Interactions API, not `responseJsonSchema`, and says ignored constraints (`minLength`, `maxLength`, `minProperties`) must be validated in application code. Structured output combined with tools is a preview feature for Gemini 3-series models only.
- **Vercel AI SDK.** `generateText`/`streamText` with `output` (`Output.object`, `Output.array`, `Output.choice`, `Output.json`, `Output.text`). Validation failures throw `AI_NoObjectGeneratedError`; reading `result.output` after tool calls throws `AI_NoOutputGeneratedError`; `streamText` partial outputs cannot be validated against the schema. `generateObject` is `@deprecated` in `ai@7.0.162` ("Use `generateText` with an `output` setting instead", `dist/index.d.ts` near line 8896). `structuredOutputMode` defaults to `auto`, which uses native output format for supported models and otherwise a JSON tool, with warnings.

**Implication:** in either design we need our own zod validation layer after parse. Constraints the provider drops must be checked by us, and a parse failure must be a typed error the job runner can retry or route to Needs You.

### 2. Tool calling

- Vercel AI SDK: `inputSchema` is used both for the model and to validate calls. Typed errors: `NoSuchToolError`, `InvalidToolInputError`, `ToolCallRepairError`, `ToolChoiceViolationError`. `stopWhen` controls the multi-step loop (`isStepCount`, `hasToolCall`, `isLoopFinished`); `prepareStep` can change model, `toolChoice`, or `activeTools` per step. `inputExamples` is supported only by Anthropic providers. Source: `ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling`.
- Anthropic-specific rules that apply to any design (from the claude-api skill reference, which summarizes the Anthropic docs and was not re-verified line by line): forced `tool_choice` (`any`/`tool`) returns 400 on Claude Fable 5.1, Claude Opus 5.5, and Claude Sonnet 5.5; use `auto` with `strict: true`, or structured outputs. Parallel tool results go back in one user message.
- Direct SDKs: our loop, our validation. Acceptable cost because the loop is small, but it must be tested (see Testability).

### 3. PDF and document input

- **Anthropic.** Maximum request size 128 MB on the first-party API; maximum 600 pages per request (100 when the context window is under 1M tokens). Text and images are both analyzed; each page is processed as an image, so dense PDFs can exhaust context before the page limit. Sources: Anthropic PDF support docs (`platform.claude.com/docs/en/build-with-claude/pdf-support.md`). Base64 sources only on Amazon Bedrock and Google-managed Vertex; Files API `file_id` on Microsoft Foundry needs a hosted deployment.
- **OpenAI.** `input_file` with `file_data` (data URL), `file_id`, or `file_url` on the Responses API (`file_url` is not supported in Chat Completions). Each file under 50 MB; combined limit 50 MB per request. `detail` (`auto`/`low`/`high`) controls PDF page-image processing. Page limit not stated. Source: OpenAI PDF file inputs guide (`developers.openai.com/api/docs/guides/pdf-files`).
- **Gemini.** `DocumentContentMimeType` includes `application/pdf` (`@google/genai@2.32.0` `dist/genai.d.ts`). Size and page limits not verified.
- **Vercel AI SDK.** `type: 'file'` parts with `mediaType: 'application/pdf'`. The docs are inconsistent (`mimeType` appears in the URL example, `mediaType` in the base64 example and prose); verify before use.

**Implication:** PDF handling is a provider-adapter concern (base64 vs Files API vs URL, page caps). The PRD's resume and document inputs (PRD §7, §33) stay within both sets of limits, but the adapter must enforce the page cap before sending.

### 4. Streaming (conversational interview, PRD §10)

- Anthropic: `client.messages.stream({...})` returns a stream; `await stream.finalMessage()` returns the complete message (`@anthropic-ai/sdk@1.4.0` `resources/messages/messages.d.ts` doc examples). The claude-api skill recommends streaming for long inputs, long outputs, or high `max_tokens`.
- Vercel AI SDK: `streamText` with `partialOutputStream`, `elementStream`, and `onError`; errors arrive as stream parts. Partial structured output is not schema-validated.
- Direct SDKs: streaming is per provider. Partial JSON must not be treated as validated output. Stream events map cleanly into one internal event type.

### 5. Computer use and browser-agent support

PRD §41 keeps the browser executor (Playwright and the DOM) in our control; the model only proposes actions. Three provider shapes:

- **Anthropic.** `{ "type": "computer_toolset_20260801" }` in `tools`. No beta header. Seventeen member tools (`screenshot`, `zoom`, `left_click`, `type`, `key`, `scroll`, `wait`, and others). Each `tool_use` carries `name` = member, `toolset_name: "computer"`, and no `action` field. Results must include `toolset_name`. Batch rule: answer every `tool_use` block, marking unexecuted ones as errors after a failure. Claude 5.5-and-later accepts only this version on the Claude API and Google Cloud (`computer_20251124` returns 400 there; Amazon Bedrock still accepts it). Older models use `computer_20251124` with beta `computer-use-2025-11-24`. Not available in Claude Managed Agents. ZDR eligible. Source: Anthropic computer-use tool docs (`platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool.md`). `@ai-sdk/anthropic@4.0.96` `dist/index.js` also contains the `computer_toolset_20260801` identifier.
- **OpenAI.** `tools: [{ type: "computer" }]`. The model returns `computer_call` with an ordered `actions` array (click, double_click, drag, move, scroll, keypress, type, wait, screenshot). The application runs the actions in order, then returns `computer_call_output` with a screenshot (`detail: "original"`), chained with `previous_response_id`. Example models in the docs: `gpt-6.1-sol`, `gpt-6-astra`. GA status not stated. Source: OpenAI computer-use guide (`developers.openai.com/api/docs/guides/tools-computer-use`). `openai@7.47.0` ships `helpers/computer.d.ts` (a driver helper).
- **Gemini.** Tool type `computer_use` with `environment` set to `browser`, `mobile`, or `desktop`. The model returns `function_call` with an `intent` and normalized coordinates (the docs say both 1000x1000 and 0-999 ranges; reconcile before use). The client executes actions, returns a `function_result` with a screenshot, and can receive `safety_decision` with `require_confirmation` or blocked; the client must send `safety_acknowledgement` after user confirmation. Models: `gemini-4-argon`, `gemini-3.8-flash` (recommended for computer use), `gemini-3.5-flash-lite`, `gemini-3-flash-preview` (labeled preview). Source: Gemini computer-use docs (`aistudio.google.com/docs/computer-use`, reached via redirect from `ai.google.dev`).

**Implication:** a neutral vocabulary (`navigate`, `click(target)`, `type(text)`, `key`, `scroll`, `screenshot`, `wait`, plus a confirmation hook) with three adapters, each mapping one provider's proposal into it and results back out. Vercel AI SDK's provider-defined computer tool covers only the Anthropic side in the docs read here. Confirmation handling (Gemini `safety_decision`, Anthropic classifier steering, OpenAI's advice to require confirmation on consequential actions) should all route into PRD §45 Needs You.

### 6. Per-call token and cost accounting (PRD §64)

No SDK returns currency. Each returns token fields; cost is ours.

- **Anthropic** `Usage` (`@anthropic-ai/sdk@1.4.0` `resources/messages/messages.d.ts`): `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation`, `inference_geo`, plus server-tool usage. The type comment states `output_tokens` is "the inclusive, authoritative total used for billing."
- **Vercel AI SDK** `LanguageModelUsage` (`ai@7.0.162` `dist/index.d.ts`): `inputTokens`, `inputTokenDetails` (`noCacheTokens`, `cacheReadTokens`, `cacheWriteTokens`), `outputTokens`, reasoning tokens. No cost fields (grep for `cost`/`costUSD` returned none).
- **OpenAI** `ResponseUsage` (`openai@7.47.0` `resources/responses/responses.d.ts`): `input_tokens_details`, with cached-token detail (field names not dumped here).
- **Gemini** `usageMetadata` (`@google/genai@2.32.0` `dist/genai.d.ts`): `promptTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount`, and others.
- **Admin usage and cost APIs** exist for organizations (`platform.claude.com/docs/en/manage-claude/usage-cost-api.md`) but require an Admin API key, which BYO-key users will not supply. Not usable for per-user accounting.
- **Prices (Anthropic, cached):** Opus 5.5 $4 / $20 per MTok; Sonnet 5.5 $2 / $10; Haiku 5.5 $0.10 / $0.50; Fable 5.1 $10 / $50. Cache reads are discounted. Source: claude-api skill model table (cached 2026-10-06). Not re-checked against the pricing page in this pass; the price table must be built and dated at implementation.

**Implication:** the thin layer records raw usage per call (provider, model, token fields, cache fields, tool calls, stop reason, request id), computes cost from a versioned, dated price table, and writes it per call so PRD §64 daily caps can be enforced before a call, not reconciled afterwards.

### 7. Runtime per-user key injection (not env vars)

- **Anthropic.** `apiKey?: string | ApiKeySetter` on the client, where `ApiKeySetter = () => Promise<string>` (`@anthropic-ai/sdk@1.4.0` `client.d.ts` lines 29 and 44). A setter lets the key be decrypted from storage per request without a long-lived plaintext copy in the client. The env var is not used when `apiKey` is set.
- **OpenAI.** `apiKey?: string | ApiKeySetter | null` (`openai@7.47.0` `client.d.ts` line 63).
- **Google.** `apiKey?: string` in the genai type declarations (`@google/genai@2.32.0` `dist/genai.d.ts`). No setter form observed.
- **Vercel AI SDK.** `createAnthropic({ apiKey })` creates a provider instance per key; without the setting it reads `ANTHROPIC_API_KEY` (`ai-sdk.dev/providers/ai-sdk-providers/anthropic`). Per-user instances work, but a per-user provider instance must be cached carefully.

Both designs support per-user keys. Keys must still follow PRD §72 (encrypted, never logged). The thin layer should never accept a raw key in logs, errors, or trace output.

### 8. Maturity, versions, and types

Registry data, 2026-11-03 (`npm view`):

| Package | Latest | Notes |
|---|---|---|
| `ai` | 7.0.162 | majors: 5.0.0 2025-07-31, 6.0.0 2025-12-22, 7.0.0 2026-06-25; dist-tag `beta` 7.0.0-beta.187 |
| `@ai-sdk/anthropic` | 4.0.96 | |
| `@anthropic-ai/sdk` | 1.4.0 | first-party |
| `openai` | 7.47.0 | first-party |
| `@google/genai` | 2.32.0 | first-party |
| `@langchain/core` | 1.3.4 | 1.0.0 2025-10-17 |
| `@mastra/core` | 1.81.0 | 1.0.0 2026-01-20 |
| `genkit` | 1.43.0 | |

None of the listed packages is marked deprecated on npm. The Vercel AI SDK has the faster major cadence. First-party SDKs ship features earlier; the AI SDK adds a dependency on Vercel's release pace.

### 9. Testability (mocking, record and replay)

- **Vercel AI SDK:** `ai/test` exports `MockLanguageModelV4` (constructed with `doGenerate` / `doStream`, or arrays of responses), `mockValues`, `mockId`, `MockEmbeddingModelV4`, and `simulateReadableStream` for streaming tests. Usage shape: nested `inputTokens.total`, `outputTokens.total`. No record/replay facility documented. Source: `ai-sdk.dev/docs/ai-sdk-core/testing`.
- **Anthropic and OpenAI SDKs:** both accept a `fetch` option (`client.d.ts` line 130 in each). A recording and replaying fetch is ours to write (match on request body hash; store responses as fixtures). Neither ships official mocks.
- **Google:** `httpOptions` on the client (`genai.d.ts`); fetch injection not verified.
- **Agent testability:** fixture replay must cover the paths that matter for PRD: schema parse failure, refusal, `max_tokens` truncation, tool error, malformed tool JSON, and the computer-use batch-failure path. Per the claude-api skill, tool inputs must be parsed with `JSON.parse` and validated against their schema because escaping can differ across models.

**Implication:** the direct-SDK design needs a small fixture-replay harness in-house (one fetch wrapper plus recorded JSON). The AI SDK gives mocks for free but not record/replay.

## Proposed seam (sketch, not code)

Every neighbouring part (interview, application agent, browser executor, cost gate) calls only this surface. Provider SDK types do not leak past it.

- `generate({ model, system, messages, tools?, output?: Schema, attachments?, signal })` returns `{ text, parsed?, toolCalls, stop: 'end' | 'tool_use' | 'refusal' | 'truncated' | ..., usage: RawUsage, costUsd, requestId }`.
- `stream(...)` returns an async sequence of normalized events. Partial output is never treated as validated.
- `computerTurn({ ... })` returns neutral actions and the confirmation state; per-provider adapters translate to and from provider tool shapes.
- A key resolver `(scope) => Promise<string>` replaces env vars. Keys are resolved per call and never stored on logs or traces.
- A price table keyed by `provider + model + version date`, with an explicit "unknown model" error that blocks the call (never a silent zero cost).
- Typed errors: `RefusalError`, `TruncatedOutputError`, `SchemaViolationError`, `RateLimitError`, `AuthError`, `ProviderError`. Retry policy (PRD §44) keys off these, not on SDK classes.

## Risks

- **Two-provider adapters for computer use are real work** (Anthropic's per-member tool calls and OpenAI's batched `actions` differ in granularity). Plan for a neutral vocabulary that is coarser than either; fidelity loss is acceptable if the executor validates each action.
- **Native structured output and our schema diverge.** A schema that works for Anthropic may be rejected on Gemini, and vice versa. Keep one canonical zod schema per output, and compile it per provider with an explicit test that each provider accepts it.
- **Model and price churn.** New model IDs appear frequently (Fable, Mythos, Opus 5.x, Sonnet 5.x). Model IDs and prices must come from a versioned table, not literals scattered through code.
- **Preview features.** Gemini structured output with tools is preview-only; OpenAI's computer tool GA status is unknown; Anthropic's `computer_20251124` is rejected by 5.5 models. The adapter must refuse unsupported combinations at startup, not at call time.
- **Automatic fallbacks change behavior.** Anthropic's server-side `fallbacks` and the AI SDK's structured-output auto mode both switch models or modes silently. If used, log the effective model per call; cost is attributed to the model that actually ran.
- **Data retention.** Anthropic's computer-use tool is ZDR-eligible for Claude 5.5+; Fable 5 family requires 30-day retention (not ZDR) per the claude-api skill reference. Screenshots and PDFs are candidate data (PRD §72); this matters for choosing models per task.
- **Framework lock-in (AI SDK path).** Major versions roughly every six months; a migration would touch every call site.

## Facts downstream decisions depend on

- Structured output on Anthropic is stable and needs no beta header; schema validation must be re-run by us after parse.
- Anthropic `Usage` has no currency field; cost is computed from a dated price table. Same for AI SDK and Gemini.
- Each provider exposes per-client `apiKey` injection (Anthropic and OpenAI also accept an async setter), so BYO key storage can stay out of env vars (PRD §72).
- Computer use is three incompatible protocols; the browser executor stays ours (PRD §41).
- PDF limits differ by provider (Anthropic 600 pages / 128 MB request; OpenAI 50 MB per file and per request; Gemini unverified). Adapters must enforce them.
- Testing requires an in-house fixture harness on the direct-SDK path, which is cheap given `fetch` injection exists.

## Gaps and what was not verified

- **OpenAI structured output GA status and supported schema subset:** not stated on the fetched page; needs the API reference.
- **OpenAI PDF page limit:** not stated.
- **Gemini structured output:** the docs reached use the Interactions API `response_format` shape, which conflicts with `responseJsonSchema` in the SDK types. Needs a live call before adoption.
- **Gemini PDF limits:** not verified.
- **Anthropic structured-outputs "Not compatible with" section:** truncated in the fetch. Whether citations, prefill, or forced `tool_choice` conflict with `output_config.format` is not confirmed here. The claude-api skill says citations are incompatible with `output_config.format` (returns 400); needs confirmation against the full page.
- **Anthropic computer-use migration section:** truncated in the fetch.
- **Vercel AI SDK computer-use coverage for OpenAI and Gemini:** not checked.
- **LangChain.js, Mastra, Genkit:** registry facts only. Not evaluated against the criteria.
- **Price table:** cited from the claude-api skill's cached table, not from the pricing page.
- **Streaming on OpenAI and Gemini SDKs:** named but not verified in the type declarations.

## Sources

Primary, retrieved 2026-11-03:

- npm registry (`npm view`): `ai`, `@ai-sdk/anthropic`, `@anthropic-ai/sdk`, `openai`, `@google/genai`, `@langchain/core`, `@mastra/core`, `genkit`. Tarballs were downloaded and grepped read-only, not executed.
- Shipped type declarations: `ai@7.0.162` `dist/index.d.ts` (`generateObject` deprecation, `LanguageModelUsage`); `@anthropic-ai/sdk@1.4.0` `client.d.ts` (`ApiKeySetter`, `apiKey`, `fetch`), `helpers/index.d.ts` (`zodOutputFormat`), `resources/messages/messages.d.ts` (`Usage`, `parse`, `stream`/`finalMessage` examples); `openai@7.47.0` `client.d.ts` (`apiKey`, `fetch`), `helpers/zod.d.ts`, `helpers/computer.d.ts`, `resources/responses/responses.d.ts` (`ResponseUsage`); `@google/genai@2.32.0` `dist/genai.d.ts` (`responseJsonSchema`, `ComputerUse`, `usageMetadata`, `apiKey`); `@ai-sdk/anthropic@4.0.96` `dist/index.js` (`computer_toolset_20260801`).
- Anthropic docs: structured outputs (`platform.claude.com/docs/en/build-with-claude/structured-outputs.md`); PDF support (`platform.claude.com/docs/en/build-with-claude/pdf-support.md`); computer-use tool (`platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool.md`); usage and cost Admin API (`platform.claude.com/docs/en/manage-claude/usage-cost-api.md`).
- OpenAI docs: structured outputs (`developers.openai.com/api/docs/guides/structured-outputs`); PDF file inputs (`developers.openai.com/api/docs/guides/pdf-files`); computer use (`developers.openai.com/api/docs/guides/tools-computer-use`).
- Google docs: structured output (`aistudio.google.com/docs/structured-output`, via redirect from `ai.google.dev`); computer use (`aistudio.google.com/docs/computer-use`, via redirect).
- Vercel AI SDK docs: structured data (`ai-sdk.dev/docs/ai-sdk-core/generating-structured-data`); tools and tool calling (`ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling`); testing (`ai-sdk.dev/docs/ai-sdk-core/testing`); Anthropic provider (`ai-sdk.dev/providers/ai-sdk-providers/anthropic`).
- Secondary, used only for Anthropic model IDs, prices, and feature rules: the claude-api skill reference bundled with this environment (cached 2026-10-06). Not re-verified against the live pricing page.
- PRD: `init-prd.md` §10 (interview), §41 (browser execution), §42 (browser technology; "does not mandate a specific model provider"), §44 (retry policy), §45 (Needs You queue), §64 (application cost controls: daily AI spend cap), §65 (BYO keys; OpenAI, Anthropic, Google, browser/computer-use providers), §72 (secrets).
