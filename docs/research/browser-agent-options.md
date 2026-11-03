# Browser-agent and computer-use options for Phase 0

- **Issue:** [#4](https://github.com/dlopezkluever/Jobaculator/issues/4), map [#1](https://github.com/dlopezkluever/Jobaculator/issues/1)
- **Researched:** 2026-11-03. Model names, prices and versions are as the vendor pages showed on that date. Re-check them before any build decision.
- **Constraints applied:** PRD §41–§43 (browser execution, technology, session persistence), §105 (CAPTCHAs escalate via Needs You), §64/§68 (cost controls, single VPS). Map Notes: fixed infra ≤ $20/month including any hosted browser; one ~4 GB VPS; BYO LLM keys; TypeScript lean.
- **Evidence caveat:** Facts were read from vendor pages through a summarizing fetch. Each claim names its page, but the exact wording should be spot-checked against the page before it goes into a spec.

## Short answer (recommendation, for decision later)

1. **Executor: Playwright (TypeScript) driving headless Chromium on the VPS**, one browser at a time, `--ipc=host`. It serves both the ATS-specific drivers (PRD §41 preferred path) and the general fallback. Marginal cost is $0. Trace capture and session-state persistence are built in.
2. **Fallback "brain": a provider computer-use model called from our own loop**, with actions executed through the same Playwright executor. Default candidate is Anthropic's computer-use toolset on a Claude 5.x model. OpenAI's `computer` tool and Gemini Computer Use sit behind the same adapter as alternates. This keeps LLM spend on BYO keys and avoids a hosted browser.
3. **Stagehand (MIT, TypeScript-first) is a candidate library, not a dependency decision.** Use it for DOM-level `act`/`observe` inside ATS drivers if a spike shows value. Its caching and Model Gateway are described as hosted-only, so local Phase 0 use would skip them.
4. **No hosted browser in Phase 0 by default.** Browserbase's $20/month Developer plan alone consumes the whole budget before the VPS. Its Free plan gives 1 browser-hour per month. Steel's pay-as-you-go Launch tier ($0 plus $0.10/browser-hour, one-time $30 credit) is the only hosted option that fits as overflow.
5. **Human takeover is not turnkey on self-hosted Chromium.** Playwright has no live view. Browserbase's live view is turnkey but hosted. This is the main gap to size in a follow-up ticket.

## Comparison

Cost per run assumes a ~25-turn application run. Assumptions are in the cost section below.

| Option | TypeScript | Reliability evidence | Cost per run (model + browser) | Memory on ~4 GB VPS | Persistence | Screenshots / trace | Human takeover |
|---|---|---|---|---|---|---|---|
| **Playwright** (self-hosted Chromium) | Yes, TypeScript is the default in its installer | Vendor docs only; no independent numbers found | $0 browser; LLM cost depends on which layer drives | ~0.7 GB peak for one headless browser (one unofficial measurement) | `storageState` (cookies, localStorage, IndexedDB); `launchPersistentContext(userDataDir)` | Trace viewer: screenshots, DOM snapshots, network, console, action log | Not provided; must build (headed Chromium on a virtual display plus a remote viewer) |
| **Stagehand** (local Chrome) | Yes, first-class TS/Python/Go SDKs | Vendor-published only | Library is OSS; LLM tokens per `act`/`observe`; caching is hosted-only | Same as Chromium; Chrome must be installed locally | Not stated for local runs | `metrics()` gives per-method token usage; trace not described | Not stated |
| **browser-use** | Python primary; TS agent and harness exist but are secondary | Self-reported benchmarks only (Stealth Bench V2 90.5%, BU Bench V2 subset), no methodology page | OSS free; cloud stealth browser from $0.02/hr | Same as Chromium | Not evaluated | Not evaluated | Cloud has a live view URL; OSS not stated |
| **Anthropic computer use** | Client-side loop; any language | Vendor and aggregator OSWorld-Verified figures (see risks) | ~$0.4–1.1 (Sonnet 5.5) per run; ~$0.8–2.2 (Opus 5.5) | Browser runs elsewhere; loop is cheap | App-managed (we store state) | Client returns screenshots; we control capture | We own it |
| **OpenAI computer use** (`gpt-6.1-sol`) | Client-side loop | Not verified | ~$0.4–1.1 per run (same token rates as Sonnet 5.5) | Browser runs elsewhere | App-managed | Client returns screenshots | We own it |
| **Gemini Computer Use** (`gemini-3.8-flash`) | Client-side loop; Playwright is the sample's executor | Not verified | ~$0.17–0.40 per run (rates rise 2× on 1 Jan 2027) | Browser runs elsewhere | App-managed | Client returns screenshots | We own it |
| **Browserbase** | SDK is TS-first (not separately verified in this pass) | Self-reported "Verified" session claims; no figures | Developer $20/mo + $0.12/browser-hr over 100 hrs; Free = 1 hr/mo | Hosted (no VPS memory cost) | Contexts and live-view link | Session replay / observability (not detailed) | Live view, interactive or read-only iframe |
| **Steel** (hosted or self-hosted) | Not verified | Labeled public beta in its repo (v0.5.5-beta) | Launch: $0 + $0.10/browser-hr, 10 concurrent, 15-min max session; $3/1k CAPTCHA solves | Self-host: ≥ 4 GB RAM and 10 GB disk per Steel docs | Not verified | Not verified | Not verified |
| **Browserless** | Not verified | Not verified | Free 1k units/mo; paid from $25/mo (annual billing) | Self-host is a licensed/Enterprise option | Not verified | Not verified | Not verified |

## Playwright alone

- **Fit.** It is the deterministic executor. The PRD §41 preferred path (Greenhouse, Lever, Ashby, Workday, iCIMS drivers) would be written against it.
- **TypeScript.** The installer defaults to TypeScript: `npm init playwright@latest` ([Playwright intro](https://playwright.dev/docs/intro)).
- **Version.** Latest GitHub release is v1.64.1, published 2026-10-14 ([microsoft/playwright releases](https://github.com/microsoft/playwright/releases/tag/v1.64.1)).
- **Container.** The docs recommend `--ipc=host` for Chromium because without it "Chromium can run out of memory and crash." They recommend `--init`. Alpine/musl is not supported ([Playwright Docker](https://playwright.dev/docs/docker)).
- **Memory.** One measurement gives peak memory of 706 MB headless versus 1094 MB headed for a single browser, idle for 5 s. The author measured summed driver and browser process memory, not per-tab RSS, on an unnamed machine ([datawookie.dev](https://datawookie.dev/blog/2025-06-06-playwright-browser-footprint/)). Other blog estimates conflict widely; this is weak evidence. Measure on the target VPS before setting concurrency.
- **Persistence.**
  - `storageState` saves and reuses cookies, localStorage, IndexedDB and passkeys. sessionStorage is not persisted; the docs give a manual snippet ([Playwright auth](https://playwright.dev/docs/auth)).
  - `launchPersistentContext(userDataDir)` keeps browser data in a folder. Only one browser may use a given directory at a time, and the default Chrome profile is not supported for automation ([Playwright BrowserType API](https://playwright.dev/docs/api/class-browsertype)).
  - Headless is the default in `launchPersistentContext`.
- **Trace and screenshots.** `trace.zip` covers screenshots (film strip), DOM snapshots before, during and after each action, network, console, and an action log. `trace: 'retain-on-failure'` and `'on-first-retry'` keep storage low ([Playwright trace viewer](https://playwright.dev/docs/trace-viewer)).
- **Human takeover.** Not in Playwright. Options are a headed browser on a virtual display plus VNC/noVNC, or a CDP screencast to a web UI. Both are engineering work, not verified turnkey options.

## LLM-on-DOM libraries

### Stagehand

- **Status.** Repo `browserbase/stagehand`, MIT, latest release `stagehand-server-v3/v3.7.7` (2026-10-23) ([repo](https://github.com/browserbase/stagehand)).
- **API.** `act` (natural-language actions, "self-heals"), `extract` (schema-typed output), `observe` (lists candidate actions/selectors). `metrics()` reports per-method token use ([Stagehand docs](https://docs.stagehand.dev/)).
- **Connection.** Drives Chromium over CDP with "no Playwright or Puppeteer dependency," while offering Playwright-style `page` methods ([Stagehand docs](https://docs.stagehand.dev/)).
- **Local vs hosted.** Local runs require Chrome installed. "A hosted browser is what enables server-side caching." Model Gateway is hosted ([Stagehand docs](https://docs.stagehand.dev/); [repo](https://github.com/browserbase/stagehand)).
- **Computer-use mode.** `stagehand.agent({ mode: "cua", model })`. Supported providers listed in docs: Google, OpenAI, Anthropic, Microsoft. Example model IDs are `google/gemini-2.5-computer-use-preview-10-2025`, `openai/computer-use-preview`, `anthropic/claude-sonnet-4-6`. The docs disagree with other pages on current IDs. Viewport must be set (default 1288×711) because CUA returns XY coordinates ([CUA docs](https://docs.stagehand.dev/best-practices/computer-use)).
- **Judgment.** Good fit for DOM-level steps. Its strongest features (caching, gateway) are hosted, so the Phase 0 value is smaller than the marketing implies.

### browser-use

- **Status.** Repo `browser-use/browser-use`, MIT, release `0.13.14` (2026-10-26) ([repo](https://github.com/browser-use/browser-use)).
- **Language.** Python is the primary library. The README says the open-source agent is available "in Python and TypeScript," listing "Browser Harness JS" and "Browser Use Pi" as TypeScript pieces ([README](https://github.com/browser-use/browser-use)). Maturity of TS parts not verified.
- **Cloud.** Stealth browsers from $0.02/hour; residential proxies, CAPTCHA solving and live-view URL add charges ([README](https://github.com/browser-use/browser-use)).
- **Benchmarks.** Self-reported (Stealth Bench V2 90.5%; BU Bench V2 60-task subset). Methodology lives on the vendor's site; not verified.
- **Judgment.** Not recommended as the core: Python-first conflicts with the TypeScript-lean constraint. Revisit only if its TS SDK matures.

## Provider computer-use

### Anthropic

- **Current tool.** `"type": "computer_toolset_20260801"`: a client toolset with 17 member tools (for example `screenshot`, `left_click`, `type`, `zoom`). Requests need no beta header. Earlier versions `computer_20251124` (beta `computer-use-2025-11-24`) and `computer_20250124` (beta `computer-use-2025-01-24`) remain ([Anthropic computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)). The header-to-version pairing is inferred from the docs' metadata.
- **Models.** Toolset: Claude 5.5 and later, including `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5` ([same page](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)).
- **Screenshots.** Opus 4.7+ and the toolset: max 2,576 px long edge and 4,784 visual tokens, with tokens = ⌈w/28⌉ × ⌈h/28⌉ (same page). A 1280×800 screenshot is about 1,334 tokens by this formula; the docs estimate 1,000–1,800 per screenshot. Oversized images are rejected, not downscaled. More than 20 images in a request triggers stricter limits.
- **Environment.** Docs recommend a minimal-privilege VM or container, a domain allowlist, no sensitive credentials, and human confirmation for consequential actions. Reference implementation is Docker + Xvfb + Mutter ([same page](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)).
- **Pricing.** Standard token prices apply. Sonnet 5.5: $2 in, $0.10 cache hit, $10 out per MTok. Opus 5.5: $4 in, $0.20 cache hit, $20 out. Haiku 5.5: $0.10 in, $0.01 cache hit, $0.50 out ([Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)).

### OpenAI

- **Tool.** Responses API `{ "type": "computer" }`. The model returns `computer_call` with an ordered `actions` list (`click`, `double_click`, `drag`, `move`, `scroll`, `keypress`, `type`, `wait`, `screenshot`). Screenshots go back as base64 PNG with `detail: "original"` ([OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)).
- **Model.** `gpt-6.1-sol` is used in every example. The page gives no list of computer-use models and no status (GA vs preview). It does mention a migration from `computer-use-preview`.
- **Environment.** Isolated browser/VM, fresh profile, site allowlist, outcome verification, step/time/cost limits. Hosted options named include Browserbase and Browser Use ([same page](https://developers.openai.com/api/docs/guides/tools-computer-use)).
- **Pricing.** `gpt-6.1-sol`: $2.00 in, $0.10 cached, $10.00 out per MTok at ≤272K input ([OpenAI pricing](https://developers.openai.com/api/docs/pricing)). The computer tool itself is not priced separately on that page.

### Google

- **Models.** `gemini-3.8-flash` is "the recommended model for computer use" per the docs. `gemini-4-argon` is listed as most capable; `gemini-3-flash-preview` is the only model labeled preview ([Gemini Computer Use](https://aistudio.google.com/docs/computer-use)). The old `ai.google.dev` URL redirects here.
- **Environments and actions.** `browser`, `mobile`, `desktop`. Browser actions include `click`, `type`, `drag_and_drop`, `press_key`, `take_screenshot`, `scroll`, `navigate`. Coordinates are on a 0–999 normalized grid ([same page](https://aistudio.google.com/docs/computer-use)).
- **Playwright.** Sample client uses Playwright (Chromium) as the action executor; reference repo `google/computer-use-preview`. The `Meta+A` shortcut is macOS-specific ([same page](https://aistudio.google.com/docs/computer-use)).
- **Pricing.** `gemini-3.8-flash`: $0.75 in, $0.075 cached, $3.75 out per MTok through 2026-12-31; $1.50 / $0.15 / $7.50 from 2027-01-01 ([Gemini pricing](https://aistudio.google.com/docs/pricing)).

### Reliability evidence (provider models)

- No official OSWorld-Verified leaderboard was retrieved. Aggregators disagree. One snapshot (late October 2026) has Claude Fable 5 at 85% and Claude Mythos 5 at 85%; another lists Claude Opus 5 at 83.4% and Gemini 3.6 Flash at 83% ([BenchLM](https://benchlm.ai/benchmarks/osworld-verified); other aggregator snapshots disagree). Treat these as unverified and, in any case, a general desktop benchmark, not job-application sites.
- No independent evidence on job-application forms was found. Phase 0 needs its own measurement (fixtures plus dry-run), which the map already plans for.

## Hosted browsers vs self-hosted Chromium

### Cost and budget

- **Browserbase.** Free: $0, 1 browser-hour/month, 15-min session limit, 3 concurrent. Developer: $20/month, 100 browser-hours, then $0.12/browser-hour, 25 concurrent, 1 GB proxies, CAPTCHA solving. Startup: $99/month. Scale: custom ([Browserbase pricing](https://www.browserbase.com/pricing)). **Developer alone equals the whole $20 budget before the VPS.**
- **Steel.** Launch: $0 plus usage, $30 one-time credit, 10 concurrent, 15-min max session, $0.10/browser-hour, proxies $10/GB, CAPTCHA $3/1k. Scale: $250/month plus usage, $100 credits/month, 100 concurrent, 1-hour sessions, $0.08/browser-hour, $1/1k CAPTCHA ([Steel pricing](https://steel.dev/pricing)).
- **Browserless.** Free: 1k units/month, 2 concurrent. Prototyping: $25/month (annual billing), 20k units. Self-hosting appears to be a licensed Enterprise option; not priced ([Browserless pricing](https://www.browserless.io/pricing)).
- **Self-hosted Chromium.** $0 marginal browser cost. The VPS is the cost, and it is already in the budget.

### CAPTCHA posture

- **Browserbase.** "Verified" sessions use a custom Chromium and are claimed to get "significantly fewer CAPTCHA challenges" (no figures). Verified is on Scale. Web Bot Auth is beta and "doesn't grant access or sign your agent into a user account" ([Browserbase stealth](https://docs.browserbase.com/features/stealth-mode)).
- **Steel.** Solves CAPTCHA at $3/1k on Launch. Documented support for specific challenge types not verified.
- **PRD position.** §105: CAPTCHAs escalate via Needs You. So solving is not a Phase 0 requirement, and hosted CAPTCHA features are not needed to pass the budget.

### Session and live view

- **Browserbase live view.** Interactive embed (`pointer-events` not set) or read-only (`pointer-events: none`), per-tab URLs, and a fullscreen debugger URL. Recording and replay are linked but not described ([Browserbase live view](https://docs.browserbase.com/features/session-live-view)).
- **Steel.** Self-host runs on Docker with ports 3000 (API), 9223 (Chrome DevTools) and 5173 (UI) in compose. Docs say "Set up proper authentication if deploying publicly" but do not describe built-in auth. ≥4 GB RAM recommended ([Steel self-hosting](https://docs.steel.dev/overview/self-hosting/docker)).

### Memory on the VPS

- A single headless Chromium peaked near 0.7 GB in one measurement ([datawookie.dev](https://datawookie.dev/blog/2025-06-06-playwright-browser-footprint/)). Steel's own requirement of ≥4 GB RAM shows the full container stack is tight on a 4 GB box.
- Working assumption: one concurrent browser on the VPS, alongside Postgres and the Node services. Verify before setting concurrency.

## Cost per typical application run

Assumptions (estimates, not measured):

- ~25 model turns per run, with a screenshot each (~1,300–1,500 tokens at 1280×800).
- ~20k average input tokens per turn (system and tools, candidate context, last ~3 screenshots, short history). Total input ~500k tokens.
- ~300 output tokens per turn (~7.5k total).
- Two cases: no caching, and 70% of input served from cache.
- ~10 minutes of browser time per run.

Results (model cost only, USD):

| Model (per MTok rates from the pricing pages) | No cache | 70% cache |
|---|---|---|
| Claude Sonnet 5.5 ($2 / $0.10 / $10) | ~$1.08 | ~$0.41 |
| Claude Opus 5.5 ($4 / $0.20 / $20) | ~$2.15 | ~$0.82 |
| Claude Haiku 5.5 ($0.10 / $0.01 / $0.50) | ~$0.05 | ~$0.02 |
| GPT-6.1-sol ($2 / $0.10 / $10) | ~$1.08 | ~$0.41 |
| Gemini 3.8 Flash ($0.75 / $0.075 / $3.75, through 2026-12-31) | ~$0.40 | ~$0.17 |

Browser time for 10 minutes: Browserbase Developer overage ~$0.02; Steel Launch ~$0.017; self-hosted $0. The DOM-only path (Stagehand `act`/`observe`, no screenshots) would use far fewer input tokens per step; not estimated here.

**Read-across:** caching and screenshot pruning change run cost by 2–3×. A 100-run month on Sonnet 5.5 with caching is roughly $40, which is LLM spend under BYO keys (PRD §64 caps), not infra.

## Open risks

1. **Benchmark conflicts.** Aggregators disagree on OSWorld-Verified leaders and dates. No official leaderboard was retrieved.
2. **Model churn.** Vendors list different current model IDs (Stagehand docs show Gemini 2.5 CU preview; Google docs show Gemini 3.8 Flash). Pin versions at build time.
3. **Beta header pairing.** The Anthropic docs say the toolset needs no beta header; the header-to-version mapping for older tools is inferred.
4. **Browser fingerprinting and blocks.** Self-hosted Chromium from a VPS IP may be blocked more often than hosted "Verified" sessions. Not measured. Verified sessions are a Scale-plan feature.
5. **Human takeover gap.** Self-hosted takeover needs building. Browserbase's live view is turnkey but hosted.
6. **Gemini price step-up.** Rates roughly double on 2027-01-01.
7. **Steel stability.** Repo labeled public beta; self-host docs lack an auth statement.
8. **Prompt injection.** All three providers say screen content is untrusted and recommend confirmation for consequential actions. Dry-run (map Notes) covers the submit step; the general agent needs guardrails (map "Not yet specified").
9. **ATS terms of service and bot policies.** Not researched in this ticket.
10. **Playwright persistent contexts.** One browser per `userDataDir`; never point at the main Chrome profile.

## Facts downstream tickets depend on

- Playwright is TypeScript-installable; latest release v1.64.1 (2026-10-14); `--ipc=host` required for Chromium in containers.
- Playwright trace.zip covers screenshots, DOM snapshots, network, console and action logs. Human takeover is not included.
- Session persistence options: `storageState` (no sessionStorage) and `launchPersistentContext` (one browser per profile dir).
- Anthropic's current toolset is `computer_toolset_20260801` (no beta header), for Claude 5.5-class models. Screenshot token formula: ⌈w/28⌉ × ⌈h/28⌉.
- OpenAI's `computer` tool on `gpt-6.1-sol`; Gemini's on `gemini-3.8-flash` with 0–999 normalized coordinates.
- Browserbase Developer ($20/month) alone breaks the budget; Free gives 1 browser-hour/month; Steel Launch is pay-as-you-go.
- PRD §105: CAPTCHAs escalate to Needs You, so CAPTCHA solving is not a Phase 0 requirement.
- Single-browser memory on a 4 GB VPS is the planning assumption; measure before setting concurrency.

## Sources

- [Playwright intro](https://playwright.dev/docs/intro)
- [Playwright trace viewer](https://playwright.dev/docs/trace-viewer)
- [Playwright auth / storageState](https://playwright.dev/docs/auth)
- [Playwright BrowserType API](https://playwright.dev/docs/api/class-browsertype)
- [Playwright Docker](https://playwright.dev/docs/docker)
- [microsoft/playwright v1.64.1](https://github.com/microsoft/playwright/releases/tag/v1.64.1)
- [browserbase/stagehand](https://github.com/browserbase/stagehand); [Stagehand docs](https://docs.stagehand.dev/); [Stagehand CUA](https://docs.stagehand.dev/best-practices/computer-use)
- [browser-use/browser-use](https://github.com/browser-use/browser-use)
- [Anthropic computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use); [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [Gemini Computer Use](https://aistudio.google.com/docs/computer-use); [Gemini pricing](https://aistudio.google.com/docs/pricing)
- [BenchLM OSWorld-Verified](https://benchlm.ai/benchmarks/osworld-verified) (aggregator)
- [Browserbase pricing](https://www.browserbase.com/pricing); [Browserbase live view](https://docs.browserbase.com/features/session-live-view); [Browserbase stealth](https://docs.browserbase.com/features/stealth-mode)
- [Steel pricing](https://steel.dev/pricing); [Steel self-hosting](https://docs.steel.dev/overview/self-hosting/docker); [steel-dev/steel-browser](https://github.com/steel-dev/steel-browser)
- [Browserless pricing](https://www.browserless.io/pricing)
- [datawookie.dev Playwright browser footprint](https://datawookie.dev/blog/2025-06-06-playwright-browser-footprint/)
- Repo: `init-prd.md` §41–§43, §64, §68, §105
