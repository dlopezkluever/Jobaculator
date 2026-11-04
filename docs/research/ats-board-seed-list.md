# Phase 0 ATS seed list: how to build and grow the Boards to watch

- **Resolves:** the seed-list ticket, [#28](https://github.com/dlopezkluever/Jobaculator/issues/28), under map [#1](https://github.com/dlopezkluever/Jobaculator/issues/1)
- **Related:** the discovery architecture ticket, [#13](https://github.com/dlopezkluever/Jobaculator/issues/13) (Board model and seed-list dependency); the job-sources ticket, [#2](https://github.com/dlopezkluever/Jobaculator/issues/2) (prior findings on branch `research/job-sources`, file `docs/research/job-sources.md`); ADR 0007 (`docs/adr/0007-discovery-watches-boards-not-hunt-searches.md`)
- **Evidence date:** 2026-11-04. Every live check, page read and repo read below was done that day unless a source line says otherwise.
- **PRD anchors (as cited in the job-sources findings):** §20 persistent discovery loop, §21 source list, §76 Tracer Bullet 1 (polls a small hand-picked set of Greenhouse Boards), §104 non-goal ("dozens of job-source integrations").
- **Map constraints:** fixed infra at most $20/month. Metered APIs are optional and capped, never required. One VPS. AI agents write the code.
- **Scope:** planning facts and a recommendation. No crawler code is in the repo. Throwaway probe scripts and logs live in the research scratch directory, outside the repo.
- **Status:** facts and a recommendation. Not a production design. Common Crawl could not be queried at all on the evidence date, so its row is open.

---

## Answer

**Recommendation.** Build the initial global seed list by probing employer names against the three public GET endpoints (Greenhouse, Lever, Ashby), using an LLM-proposed name list as input, and read the employer's careers page only for names that miss. Grow it with the same loop on a weekly cadence, but judge each run by its measured novelty and validation rate, not by volume. Do not use Common Crawl, third-party token lists or Brave for Phase 0 now. Common Crawl returned HTTP 504 on all four queries, the public token lists are CC BY-NC or unlicensed, and Brave's API terms forbid storing or caching results.

### (a) Initial global seed list (one-time build plus manual curation)

| Rank | Method | Measured here | Cost | Notes |
|---|---|---|---|---|
| 1 | LLM-proposed employer names, then slug probes on all three Sources | 40-name proxy: 33 names resolved to 34 Boards. The 30 LLM-proposed names gave 27 (90%). About 2.5 probes per name in the first pass, 139 requests in total including checks. | $0 infra. LLM name generation is metered and capped (not priced here). | Probe every Source per name. Do not stop at the first hit (see Open risks). |
| 2 | Careers-page inspection for names that miss all three probes | 15-employer scan: an ATS is visible in the HTML of 7 pages. It resolved one slug mismatch (Glean, which is `gleanwork` on Greenhouse). | $0. About 2 requests per employer (robots plus one GET). | Catches mismatches and gives the token directly. Misses JS-rendered and blocked pages. |
| 3 | Manual curation by the User | Not measured. | $0. | Required for Hunts the LLM proposes poorly. Keeps the seed list honest. |
| - | Common Crawl CDX | 4 of 4 queries returned 504. | $0 infra; load and terms constrain it. | Not usable for Phase 0 until it answers. Revisit once it does (Area 1). |
| - | Public token lists | 3 candidate repos with data. Licence blockers on each. | $0 | Use only after a legal read. Do not import contents (Area 2). |
| - | Brave Search API | Pricing conflicts on the same page. Storage banned by API terms. | Metered. $5 per 1,000 requests, with a $5 monthly credit. | Exclude from the seed list (Area 3). |

### (b) Ongoing automatic growth (weekly loop)

Loop: LLM suggestions, then dedupe against names already known, then slug probes on all three Sources, then careers-page check for names that miss all three, then validate, then dedupe at Board level (Employer plus Source), then add to the watched set. Re-probe the whole seed list monthly.

- **Expected yield.** On the famous-name proxy, about 25 Boards per 100 requests (34 Boards from 139 requests). That rate is an upper bound for a generic list. The weekly limit is novelty: how many suggested employers are not already known. This research could not measure novelty. Illustration only, not a measurement: 25 suggestions with half new and 80% resolving gives about 10 new Boards per week.
- **Cost.** Probe and careers requests run from the VPS within the existing budget, so about $0. The LLM suggestion call is metered and capped (not priced here). No search API is needed.
- **Maintenance.** Re-probe each seed Board once a month, about 1 request per Board. For 300 Boards that is about 300 requests, roughly 5 minutes at one request per second.
- **Bandwidth caveat.** The Ashby default response is large (13.6 MB for 818 postings, about 17 KB per posting). Greenhouse's list response is about 0.6 KB per posting. Polling cadence therefore matters more for Ashby than the request count does.

### Key risks (full list under Open risks)

1. **Board identity.** Stopping at the first hit under-counts real Boards: Ramp has 1 posting on Greenhouse and 166 on Ashby. Lever returned a 200 with zero postings. The documented Ashby list fields and the Lever fields in the job-sources findings carry no company name to check against.
2. **Terms of the free ATS APIs.** Documented as public, but the terms are unsettled and the Ashby wording is employer-facing. Lever's docs say postings "may be scraped by third parties". Get a legal read before multi-user use.
3. **Coverage bias.** The probe set skews to well-known technology employers, and 13 of the 30 LLM-proposed names were already in the careers-page sample. The proxy is not a random sample of employers.

### Tracer Bullet 1 is not blocked

Hand-picked Greenhouse tokens verified live on 2026-11-04: `anthropic` (682 postings), `figma` (146), `stripe` (755). These are our own probe results, not list contents.

---

## 1. Common Crawl URL index (CDX)

| Check | Result (2026-11-04) |
|---|---|
| `collinfo.json` | 200 in 0.3 s. Latest index listed is `CC-MAIN-2026-43` ("October 2026 Index"). |
| CDX `boards.greenhouse.io/*` with `showNumPages=true` on `CC-MAIN-2026-43` | 504 at 10.1 s. Retry after a 90 s pause: 504 at 10.2 s. |
| CDX `jobs.lever.co/leverdemo*` on `CC-MAIN-2026-39`, `limit=2` | 504 at 10.1 s. |
| CDX `jobs.ashbyhq.com/*` with `showNumPages=true` on `CC-MAIN-2026-43`, after a 60 s pause | 504 at 10.1 s. |

- **Outcome.** 4 of 4 CDX queries failed with a gateway timeout at about 10 seconds. The page counts, identity counts and latency of a successful query are therefore not obtained. The 504 is consistent across index versions and hosts, which suggests the index server, not the query, is at fault.
- **Implied Board identities.** Not measurable from this run. The only evidence is secondary: the job-board aggregator repo (Area 2) says its CDX-based harvest across 20+ ATS domain patterns and several crawl snapshots yields "give or take 95,000 unique company identifiers" ([README, "Company Discovery"](https://github.com/Riley-Dorrington/job-board-aggregator)). That figure is self-reported and undated.
- **Monthly pull budget.** Cannot be estimated from this run. No page count was returned, and bulk download was out of scope. The pywb reference documents `showNumPages` (example response `{"blocks": 423, "pages": 85, "pageSize": 5}`), which is how a pull would be sized once the server answers ([pywb CDX server API](https://pywb.readthedocs.io/en/latest/manual/cdxserver_api.html)).
- **Load guidance.** The index page says "Please do not overload the URL index server." It also says the index files "are free to download" and suggests running your own index server ([index.commoncrawl.org](https://index.commoncrawl.org/)).
- **Terms.** Common Crawl grants "a limited, non-assignable, non-transferable, non-sublicensable, non-exclusive, limited license to access and use the Service" (section 1). Crawled Content "may be subject to separate terms of use or terms of service from the owners of such Crawled Content" (section 2). The terms were last updated 2024-03-07 ([terms of use](https://commoncrawl.org/terms-of-use)). In our reading, the terms grant no rights to the underlying employer content, so a CDX-derived list is only as usable as the source terms allow.
- **Recommendation.** Do not depend on CDX for the Phase 0 seed list. If it answers later, run a single small, throttled, one-off query set and record the page counts before any pull.

---

## 2. Public ATS token lists and their licences

Searches used `gh search repos` and `gh search code` (2026-11-04). Candidate repos are listed by URL. Files were downloaded only where they were small, read as text, and never executed or imported. Contents are not reproduced here.

| Repo (URL) | Licence (API field and file) | Last push | Data in repo | Reuse posture |
|---|---|---|---|---|
| [Riley-Dorrington/job-board-aggregator](https://github.com/Riley-Dorrington/job-board-aggregator) (search showed the older owner name) | MIT for code (`LICENSE`). Its README says the curated company datasets in `data/` are CC BY-NC 4.0, non-commercial only. | 2026-11-04 | `greenhouse_companies.json` (142,968 bytes): 8,333 entries (counted). `ashby_companies.json` (45,964 bytes) and `lever_companies.json` (66,680 bytes) present, not counted under the one-file rule. | Non-commercial only. The README says the lists are built from Common Crawl CDX. Blocker for any commercial use, and the lists are someone else's compilation. |
| [Servation/job-search-agent-slugs](https://github.com/Servation/job-search-agent-slugs) | None (no `LICENSE`; API `license` is null). | 2026-08-21 | `slugs.json` (8,750 bytes): Greenhouse 104, Lever 1, Ashby 30, Workday 42 (objects), SmartRecruiters 6 (objects). | No licence means no reuse permission by default. |
| [kamerozkan/ats-job-change-feed-sample](https://github.com/kamerozkan/ats-job-change-feed-sample) | MIT for code. `DATA_NOTICE.md` says the licence "does not grant rights to third-party company names, trademarks, career-page content, job descriptions, or other source data." | 2026-10-06 | `benchmarks/pilot-500-boards.json` (23,535 bytes): 500 boards. Counts by ATS: Greenhouse 90, Lever 15, Ashby 75, plus Workable 110, Recruitee 55, Personio 65, Teamtailor 45, Workday 45. | Data not licensed. Sample only. |
| [Somitha-git/find-companies-using-ashby-job-boards](https://github.com/Somitha-git/find-companies-using-ashby-job-boards) | MIT (code). | 2026-10-14 | No list. Example CSV with 2 rows. | Excluded. A discovery tool, not a list. |
| [crispchris33/greenhouse_token_collector](https://github.com/crispchris33/greenhouse_token_collector) | None. | 2026-04-10 | Browser extension code only. | Excluded. |
| [AnshumanAtrey/lever-jobs-search](https://github.com/AnshumanAtrey/lever-jobs-search) and [greenhouse-jobs-search](https://github.com/AnshumanAtrey/greenhouse-jobs-search) | MIT (code). | 2026-11-03 | No list file in the tree. README claims 2,300+ Lever companies (not verified). | Excluded. Scrapers, not lists. |

- **Entries counted.** Only the Riley Greenhouse file (8,333) and the Servation and kamerozkan files were parsed for counts. Entry counts for the other Riley files are not taken, so the Ashby and Lever sizes are file sizes only.
- **Quality note.** No file was checked against the live APIs or against the probe set, so the accuracy and freshness of each list are unknown.
- **Recommendation.** Do not import any of these into the repo. Get a legal read before using a compiled list as a candidate-name source. Even then, every entry must be validated by our own API call, and the stored record must carry our verification date, not the source's.

---

## 3. Brave Search API pricing and terms

Read-only documentation fetches, 2026-11-04. No account, no credentials, no paid calls.

| Source | What it says |
|---|---|
| [brave.com/search/api](https://brave.com/search/api/) (home page) | Hero: "Up to $20 in free calls every month · Prepaid credits, no subscription." Search plan card: "$5 per 1,000 requests … Includes $5 in free credits every month." Answers plan: "$4 per 1,000 requests + $5 per million input/output tokens." Structured data: "Up to thousands of free queries per month, depending on plan." FAQ: storage "Yes, with a plan that includes storage rights." No plan is named as the one with storage rights. |
| [API documentation: pricing](https://api-dashboard.search.brave.com/documentation/pricing) | Search "$5.00 per 1,000 requests", "free $5 in credits every month", 50 requests per second. Answers "$4.00 per 1,000 queries" plus token rates. Spellcheck and Autosuggest "$5.00 per 10,000 requests". No storage terms on this page. |
| [Search API Terms of Use](https://api-dashboard.search.brave.com/documentation/resources/terms-of-service) (last updated 1 Sep 2026) | Customer shall not "store, cache, or create a database of Search Results, in whole or in part, other than transient storage required for operation of Customer Applications" (Use Restrictions, item i). Customer shall not "use the Search Results to create, evaluate, train, re-train, fine-tune, benchmark or otherwise improve artificial intelligence models" (item xiii). Also "redistribute, resell, or sublicense the Search Results" (item xii). The text read contains no plan-based exception to these. It does reference negotiated "Order Form[s]". |

**Conflicts on the day of checking.**

- Hero says "$20 in free calls every month"; plan cards say "$5 in free credits every month"; structured data says "thousands of free queries". At the $5 per 1,000 list price, the $5 credit covers about 1,000 Search requests a month. The $20 figure is not explained.
- The home page FAQ says storage rights come from "a plan that includes storage rights". Neither the pricing page nor the Search plan card names one.
- The API terms prohibit storing or caching results with no exception in the text read. That is the binding document for the Use Restrictions, so the FAQ claim cannot be relied on without written confirmation.

**Cost math.** About $0 for roughly 1,000 Search requests a month if the credit applies to Search only. The cost is not the blocker. The blocker is that storing derived results, including Board identities drawn from them, sits inside the prohibited storage and derivative-use wording.

**Recommendation.** Exclude Brave from the seed list and from growth. If a search-based step is ever wanted, ask Brave in writing whether the storage rights apply to the plan in question before building.

---

## 4. Careers-page ATS embed patterns

Method: `robots.txt` checked for the host (the `User-agent: *` group, evaluated against the careers path with wildcard matching). One GET per careers page. Redirects were followed once where noted. No JavaScript executed, no iframes or `/embed/` paths fetched. The probe is in scratch, not in the repo. Requests: 34 for the 15 employers (15 robots, 15 pages, 3 redirect follows, 1 robots on a redirect host). Four further employers (the probe misses) took 2 requests each.

| Employer | Careers URL read | robots for path | Page | ATS visible in HTML | Pattern |
|---|---|---|---|---|---|
| OpenAI | openai.com/careers/ | Allowed | 403 (bot block, 9.8 KB) | Not readable | Not scanned |
| Anthropic | anthropic.com/careers | Allowed | 200 (227 KB) | None in HTML (Next.js page; job list probably loaded by script, not verified) | Greenhouse API has 682 postings. |
| Mistral AI | mistral.ai/careers, 301 to /careers/ (followed) | Allowed | 200 (261 KB) | Ashby board `mistral.ai` | Links in embedded JSON, not anchors |
| Perplexity | perplexity.ai/hub/careers | Allowed | 200 (119 KB) | None | Ashby API has 137 postings |
| Cohere | cohere.com/careers | Allowed | 200 (572 KB) | Ashby `cohere` | Links in embedded JSON |
| Scale AI | scale.com/careers | Allowed (only `/careers/legal` is disallowed) | 200 (120 KB) | None | Greenhouse API has 166 postings |
| ElevenLabs | elevenlabs.io/careers | Allowed | 200 (607 KB) | None | Ashby API has 144 postings |
| Replit | replit.com/careers | Allowed | 200 (228 KB) | Ashby `replit` (68 references) | Links in embedded JSON |
| Stripe | stripe.com/jobs, 301 to /careers (followed) | Allowed | 200 (328 KB) | None | Greenhouse API has 755 postings, not linked from the page |
| Figma | figma.com/careers/ | Allowed | 200 (1.8 MB) | Greenhouse `figma` (145 anchors, `gh_jid` links) | Direct anchor links to `boards.greenhouse.io/figma/jobs/…` |
| Notion | notion.com/careers | Allowed (`/embed/*` is disallowed in the `*` group; not fetched) | 200 (251 KB) | Ashby `notion` (146 anchors) | Direct anchor links to `jobs.ashbyhq.com/notion/{uuid}` |
| Linear | linear.app/careers | Allowed | 200 (451 KB) | Ashby `Linear` (62 references) | Links in embedded JSON |
| Ramp | ramp.com/careers | Allowed | 200 (4.5 MB) | Ashby `ramp` (332 references); also Workday and BambooHR mentions | Links in embedded JSON |
| Datadog | datadoghq.com/careers/, 301 to careers.datadoghq.com (followed; that host's robots lists only a sitemap) | Allowed | 200 (189 KB) | None (own domain) | Greenhouse API `absolute_url` uses careers.datadoghq.com |
| Shopify | shopify.com/careers | Allowed | 200 (646 KB) | None | None found. All three probes 404. |

**Totals and patterns.**

- Reachable pages: 14 of 15 (OpenAI returned 403). ATS visible in HTML: 7 of 15 (47%), or 7 of 14 reachable.
- Patterns: direct anchor links 2 (Figma, Notion). Links in embedded JSON 5 (Mistral, Cohere, Replit, Linear, Ramp). Iframes 0. Greenhouse embed script (`greenhouse.io/embed/job_board`) 0 (Figma's page has one script reference to `boards.greenhouse.io`, not the embed path). Lever postings links 0. A Lever `api.lever.co/v1/opportunities` call appeared in one script (Glean), which is not the postings API.
- Cross-check with probes (Area 5): the 7 HTML-visible ATS signals all agreed with a live 200 on the same token. The probe also found 7 Boards that the HTML did not show (OpenAI, Anthropic, Perplexity, Scale AI, ElevenLabs, Stripe, Datadog). So the careers HTML is an incomplete oracle, and the probe is the primary method.
- Redirect and host notes: Hugging Face's careers page redirects to `apply.workable.com/huggingface`, a fourth ATS outside the three Sources (Area 6).

---

## 5. Slug probing hit rates

**Method.** 40 employer names (30 LLM-proposed, written before any probe, plus 10 extras). Slug variants were derived by rule: lowercase alphanumeric (`mistralai`), hyphenated (`mistral-ai`), and suffix-stripped (`mistral`). Phases ran in that order, probing Greenhouse, then Ashby, then Lever, and stopped at the first 200 with at least one posting. Rate was one request per second with a generic User-Agent. No personal contact details appear in requests. Job content was never stored; only status codes, counts and URL hostnames were logged.

**Variant count.** Most single-word names yield one plausible variant under these rules, so the brief's "2 to 3 slugs per name" was met only for the multi-word names. This is a deviation to note.

### Probe log summary (first pass, 99 requests)

| Endpoint | Requests | 200 with postings | 200 with zero postings | 404 | Timeout | 429 |
|---|---|---|---|---|---|---|
| Greenhouse | 48 | 18 | 0 | 30 | 0 | 0 |
| Ashby | 30 | 9 (4 more were 200s truncated by my 2 MB read cap, corrected below) | 0 | 17 | 0 | 0 |
| Lever | 21 | 0 | 1 (`mistral`) | 18 | 2 (20 s each) | 0 |

**Follow-up requests (40 in total).** Validation re-checks (33: every hit re-requested, recording only URL hostnames and counts). Truncation fixes (4: OpenAI and Snowflake full reads, Ramp list and single job). Glean's `gleanwork` token (1). Ashby check for Ramp (1). Ashby unknown-name control, `zz-no-such-board-xyz-research`: 404 with plain text "Not Found" (1). **Total ATS API requests: 139, with no 429 or 403 responses observed.**

**Correction note.** My first-pass Ashby read capped responses at 2 MB, which truncated four bodies and recorded them as "nonjson". Re-reading in full resolved OpenAI (818 postings), Snowflake (370), ElevenLabs (144) and Notion (146). The validation re-check used a 3 MB cap, which also truncated OpenAI and Snowflake; both were re-read in full. The first-pass Ashby count of 9 is therefore a floor.

### Results (33 of 40 names resolved, 34 Boards)

- **Greenhouse (19 Boards).** Anthropic 682, Databricks 926, Stripe 755, GitLab 245, Cloudflare 464, Coinbase 278, Brex 270, Datadog 395, MongoDB 361, Airbnb 211, Figma 146, Robinhood 159, Scale AI 166, Together AI 86, Vercel 88, Airtable 5, Wise 18, Ramp 1 (company name RAMP), and Glean as `gleanwork` 129.
- **Ashby (15 Boards).** OpenAI 818, Snowflake 370, Plaid 139, Perplexity 137, Cohere 117, ElevenLabs 144, Notion 146, Temporal 79, Supabase 70, Replit 34, Linear 31, Anyscale 22, Runway 3, Mistral as `mistral.ai` 235, and Ramp 166 (also on Ashby).
- **Lever (0 Boards with postings).** One zero-posting site (`mistral`, a stale or unused Lever site).

### Failure modes and patterns

| Mode | Observed |
|---|---|
| 404 for unknown name | All 30 Greenhouse and 17 Ashby misses; Lever 18. Plain text "Not Found" on Ashby. |
| 200 with zero postings | Lever `mistral`. Treat as "exists but empty", not a Board. |
| 200 with a single posting | Greenhouse `ramp` (company name RAMP, a real board). Low counts need a second check. |
| Early stop hides a second Board | Ramp: 1 on Greenhouse, 166 on Ashby. The first-hit rule was unsafe. |
| Timeouts | 2 of 21 Lever probes (20 s each: `mistral-ai`, `walmart`). |
| 429 / 403 / Cloudflare / redirects on APIs | None observed in 139 requests. |
| Slug mismatch | `glean` 404, `gleanwork` 200 with 129 postings. Found via the careers page. |
| Dotted names | Ashby `mistral.ai` 200 with 235 postings. `mistralai` 404. |
| Case | Ashby `Linear` and `linear` both 200 with 31 postings. Case looks ignored. |
| Successful slug forms (33 resolved) | 30 plain lowercase alphanumeric. 1 suffix-stripped (`perplexity`). 1 dotted (`mistral.ai`). 1 mismatch (`gleanwork`). No hyphenated slug resolved in this run. |

**Payload sizes (for bandwidth).** Ashby OpenAI 13.6 MB for 818 postings. Ashby Ramp 2.8 MB for 166. Greenhouse Glean 77 KB for 129, about 0.6 KB per posting in the list response.

---

## 6. LLM-suggested employer sample for an example Hunt

**Hunt example.** "AI / Software Engineering." The list was written from memory before any probe result or ATS list was read. It is a proxy for what the seed-list LLM step would produce, not a measurement of it. 13 of the 30 names overlap the careers-page sample, which was drawn before the list was written, so the proxy is biased toward names I already knew.

| Group | Names | Resolved | Source split | First-pass requests |
|---|---|---|---|---|
| LLM-proposed (30) | AI labs, dev tools and infra, fintech and general software | 27 (90%) | Greenhouse 14 (includes Ramp), Ashby 14 (includes Ramp), Lever 0 | 77 |
| Extras (10), not in the LLM list | Linear, Airtable, Shopify, Airbnb, Coinbase, Robinhood, Canva, Wise, Walmart, JPMorgan Chase | 6 (60%) | Greenhouse 5, Ashby 1 | 22 |

**Misses (7 names) and why, as far as this run can say.**

| Name | Probe result | Careers check | Cause |
|---|---|---|---|
| Hugging Face | 404 on all three | Redirects to `apply.workable.com/huggingface` | Not on the three Sources (Workable). Confirmed by redirect. |
| Replicate | 404 on all three | 302 to `/about#open-roles`, not followed | Unknown. |
| Weights & Biases | 404 on all three, three variants tried | 301 to `/site/careers/`, not followed | Unknown. A `wandb` variant was not probed. |
| Shopify | 404 on all three | No ATS in HTML | Probably not on these three. Not confirmed. |
| Canva | 404 on all three | Not checked | Unknown. |
| Walmart | Lever timeout, 404 on other two | Not checked | Unknown. Lever timeout may hide a real site. |
| JPMorgan Chase | 404 on all three, two variants | Not checked | Unknown. |

**Summary.** Of the 7 misses, one is confirmed as a non-target ATS, zero are confirmed as slug mismatch (the one mismatch, Glean, now resolves), and 6 are unexplained. The resolution rate is a function of the proxy list, not a general rate for the Sources.

---

## 7. Cost and terms risk, by method

| Method | Monthly cost estimate | Request volume (monthly) | ToS and licence posture | Key risk |
|---|---|---|---|---|
| Common Crawl CDX | $0 infra. Cost unknown. | Unknown. 4 of 4 queries 504 (about 10 s each). | "Limited license" (Terms section 1). Third-party terms apply to Crawled Content (section 2). Index server asks users not to overload it. | Unreliable today. Cannot size a pull. |
| Token-list ingestion | $0 | One download per repo (about 9 to 150 KB each). | MIT code, CC BY-NC data (Riley), no licence (Servation), "no rights" for data (kamerozkan). | Licence blockers. CDX-derived lists (Riley) carry the CDX terms too. |
| Brave Search API | Metered. $5 per 1,000 Search requests, $5 monthly credit (about 1,000 requests free at list price). | Would be small if used. | Storage and caching of results prohibited (ToS, last updated 1 Sep 2026). Training prohibited. | Terms ban the storage the method needs. Pricing conflicts. |
| Careers-page inspection | $0 | About 2 requests per employer per check (robots plus page). 100 employers a month is about 200 GETs. | `robots.txt` respected: no disallow matched our paths. No ToS text read for the employers. | Misses JS-rendered and blocked pages (OpenAI 403, Anthropic client-rendered). |
| Slug probing | $0 | About 3 requests per resolved Board. 300 names once is about 900 requests. Monthly re-probe of 300 Boards is about 300 requests. | Documented public GETs (Greenhouse: "publicly available"). Ashby docs describe the API for employers hosting their own careers page. Lever: "may be scraped by third parties." | Undocumented rate limits (none hit at 1 request per second). Namespace collisions and early-stop errors. |
| LLM name suggestions | Metered by the AI provider. Weekly call is small, and must sit inside the LLM spend cap. Not priced here. | About 4 to 5 calls a month. | Model-generated names, not a source. | Bias toward known employers. Plausible but non-existent names (these fail cheaply at 404). |

---

## Open risks

1. **Board identity and collisions.** A first-hit stop hides second Boards (Ramp). A 200 with zero postings (Lever `mistral`) and a single-posting board (Greenhouse `ramp`) need flags. The documented Ashby list fields and the Lever fields carry no company name, so identity checks there rely on URL hostnames (every Ashby hit checked was on `jobs.ashbyhq.com`, which says nothing about the employer) and cross-checks with the careers page. The validation rule for the weekly loop is therefore not yet settled.
2. **Terms of the free ATS APIs.** Greenhouse says job board data is "publicly available, so authentication is not required for any GET endpoints" ([Greenhouse Job Board docs](https://docs.greenhouse.io/job-board.html)). Lever says "These jobs may be scraped by third parties" ([Lever postings API](https://github.com/lever/postings-api)). Ashby's page says "If you host your own careers page, you can use this data to populate it" ([Ashby public job posting API](https://developers.ashbyhq.com/docs/public-job-posting-api)). That is a changed phrase from the job-sources findings, which paraphrased it as "intended for organizations that host their own careers page and want to populate it". Get a legal read before any multi-user use.
3. **Undocumented rate limits.** Greenhouse's docs have no rate-limit section (checked 2026-11-04). None of our 139 requests got a 429, but that is one run, not a limit.
4. **Bandwidth at polling cadence.** Ashby responses are about 17 KB per posting. Daily polling of hundreds of Ashby Boards is a real VPS bandwidth line. Estimate per poll only, not measured for a full watch set.
5. **Coverage bias.** The probe set skews to well-known technology employers. The 7 misses include several Workable and non-tech employers, and Workday, SmartRecruiters, Workable and others are out of scope. The seed list will undercount everything outside these three Sources.
6. **Novelty of the weekly loop is unmeasured.** Its yield depends on how many LLM-suggested names are new, which this run could not measure. The first four weeks should log novelty and validation rate per run before the loop is trusted.
7. **Common Crawl may come back.** If it does, its page counts and latency must be recorded before any pull. The Riley CDX-derived lists show the approach works at scale, but their licence is non-commercial.
8. **Brave storage terms.** The FAQ says storage rights are sold by plan. The API terms prohibit storage without any exception in the text read. Get written confirmation before any use.
9. **Careers-page scans can be wrong in both directions.** Stripe and Anthropic show no ATS in HTML while their Greenhouse boards are live (probe-only Boards), so the careers HTML is not a complete oracle. A page can also link a token that differs from the employer name (Glean).

---

## Sources

All read or checked 2026-11-04 unless noted. Local documents read: `GLOSSARY.md`, `docs/adr/0007-discovery-watches-boards-not-hunt-searches.md`, and the prior findings in `docs/research/job-sources.md` on branch `research/job-sources` (evidence date 2026-11-03).

**Common Crawl**
- Index list: https://index.commoncrawl.org/collinfo.json
- Index server page: https://index.commoncrawl.org/
- Terms of use (last updated 2024-03-07): https://commoncrawl.org/terms-of-use
- Get started: https://commoncrawl.org/get-started
- pywb CDX server API reference: https://pywb.readthedocs.io/en/latest/manual/cdxserver_api.html
- CDX queries (all 504): `CC-MAIN-2026-43-index` with `url=boards.greenhouse.io/*` (two attempts) and `url=jobs.ashbyhq.com/*`; `CC-MAIN-2026-39-index` with `url=jobs.lever.co/leverdemo*`.

**ATS endpoints and docs**
- Greenhouse Job Board docs: https://docs.greenhouse.io/job-board.html
- Greenhouse API used: https://boards-api.greenhouse.io/v1/boards/{token}/jobs (and single job)
- Lever postings API docs: https://github.com/lever/postings-api
- Lever API used: https://api.lever.co/v0/postings/{site}?mode=json
- Ashby public job posting API docs: https://developers.ashbyhq.com/docs/public-job-posting-api
- Ashby API used: https://api.ashbyhq.com/posting-api/job-board/{name}

**Token lists (read as text, not executed; contents not reproduced)**
- https://github.com/Riley-Dorrington/job-board-aggregator (LICENSE, README, `data/README.md`, `data/greenhouse_companies.json`; tree listing)
- https://github.com/Servation/job-search-agent-slugs (`slugs.json`, repo metadata)
- https://github.com/kamerozkan/ats-job-change-feed-sample (`LICENSE`, `DATA_NOTICE.md`, `benchmarks/pilot-500-boards.json`)
- https://github.com/Somitha-git/find-companies-using-ashby-job-boards (`examples/example_verified_ashby_slugs.csv`, `LICENSE`)
- https://github.com/crispchris33/greenhouse_token_collector (metadata)
- https://github.com/AnshumanAtrey/lever-jobs-search and https://github.com/AnshumanAtrey/greenhouse-jobs-search (`LICENSE`, tree)
- Search: `gh search repos` and `gh search code` on the terms "greenhouse tokens", "ashbyhq", "lever jobs scraper", "greenhouse jobs scraper", "job board slugs", "api.lever.co/v0/postings", and "boards-api.greenhouse.io/v1/boards".

**Brave Search API**
- Home page: https://brave.com/search/api/
- Pricing documentation: https://api-dashboard.search.brave.com/documentation/pricing
- Search API Terms of Use (last updated 1 Sep 2026): https://api-dashboard.search.brave.com/documentation/resources/terms-of-service
- Not relevant (browser terms, not the API): https://brave.com/terms-of-use/

**Careers pages (one GET each; robots.txt per host)**
- openai.com/careers/ (403); anthropic.com/careers; mistral.ai/careers (followed to /careers/); perplexity.ai/hub/careers; cohere.com/careers; scale.com/careers; elevenlabs.io/careers; replit.com/careers; stripe.com/jobs (followed to /careers); figma.com/careers/; notion.com/careers; linear.app/careers; ramp.com/careers; datadoghq.com/careers/ (followed to careers.datadoghq.com; robots checked on that host); shopify.com/careers
- Probe misses, one GET each: huggingface.co/careers (302 to apply.workable.com/huggingface); replicate.com/careers (302, not followed); glean.com/careers (200); wandb.ai/site/careers (301, not followed)

**Slug probes (logs in scratch, summarised above)**
- Greenhouse, Ashby and Lever public GET endpoints listed under ATS endpoints above; probes ran 2026-11-04 with the stated User-Agent.
