# Phase 0 job sources: which can discover postings

- **Resolves:** issue [#2](https://github.com/dlopezkluever/Jobaculator/issues/2) under map [#1](https://github.com/dlopezkluever/Jobaculator/issues/1)
- **Evidence date:** 2026-11-03. Every live check and page read below was done that day. Quoted docs are the versions served that day.
- **PRD anchors:** §19 dedup inputs, §20 persistent discovery loop, §21 source list, §31 job snapshot (posting ID, discovery date), §76 tracer bullet 1 ("deliberately avoid broad source coverage"), §91 freshness, §104 non-goal ("dozens of job-source integrations").
- **Map constraints:** fixed infra ≤ $20/month. Metered APIs are optional and capped, never required. One VPS. AI agents write the code.
- **Status:** facts and a recommendation. Final architecture decisions are made later with the user.

---

## Answer

**Recommendation for Phase 0: discover directly from ATS public job-board APIs, starting with one ATS.** Aggregators are not needed for Phase 0. Exclude LinkedIn, Indeed and iCIMS. Defer Workday until a legal read.

1. **Primary (free, no key, structured JSON, documented or observed as public):**
   - **Greenhouse Job Board API.** Recommended first adapter. Docs state GET endpoints need no auth. Richest fields: `internal_job_id` for cross-board identity, `updated_at`, `first_published`, optional pay ranges.
   - **Lever Postings API.** Structured `salaryRange` and `workplaceType`. Docs say published postings "may be scraped by third parties," and the site's robots.txt is explicit (see Open risks).
   - **Ashby public job-board API.** `publishedAt`, `isRemote`, `workplaceType`, optional compensation. Docs say it is intended for organisations that host their own careers page (see Open risks).
2. **Later candidates (the "second ATS family" is unspecified on the map):**
   - **SmartRecruiters Posting API.** Documented and worked unauthenticated in a live test. Structured `location.remote`, `refNumber`.
   - **Workday CXS endpoints.** Work unauthenticated but are undocumented. Workday's Website Terms prohibit data-mining and scraping. Do not build on it without a legal read.
3. **Optional, capped, metered (never required):**
   - **USAJobs.** Free key. Federal jobs only. Niche.
   - **Adzuna.** Free key. Snippets only. Pricing and terms not verified.
   - **SerpAPI Google Jobs.** Metered. Starter is $25/month for 1,000 searches. Google's terms restrict automated access, and results are aggregated from other boards.
4. **Exclude:**
   - **LinkedIn.** User Agreement §8.2 prohibits scraping and bots. The official Job Posting API is partner-only, built for posting jobs, and "not accepting new partnerships."
   - **Indeed.** No open API or publisher program found. robots.txt disallows `/viewjob` and `/rc/`.
   - **iCIMS.** Official XML feed is limited to iCIMS-approved vendors. No public API.
   - **Google Custom Search JSON API.** Closed to new customers. Existing customers must move off by 2027-01-01.
   - **Bing Search API.** Retired 2025-08-11.

**Cost:** ATS APIs are $0 at Phase 0 volume. Every aggregator is metered and optional. No aggregator is required, so the $20/month ceiling is not at risk from discovery.

**Coverage is the real bottleneck.** Each ATS source covers only companies whose board token, site name or tenant we already know. No official directory exists for any of them, and the search APIs that could find them are closed or retired. See "Finding which companies use which ATS".

---

## Comparison

| Source | Access | Freshness field | Salary | Remote / location | Native ID | Rate limit (documented) | Cost | ToS risk |
|---|---|---|---|---|---|---|---|---|
| Greenhouse Job Board | GET, no key | `updated_at` (list), `first_published` (single) | `pay_input_ranges` via `pay_transparency=true`, single-job call only | Location text only in list | `id` (= `gh_jid` in `absolute_url`), `internal_job_id` | None documented | $0 | Low-moderate (no ToS text; "publicly available") |
| Lever Postings | GET, no key | `createdAt` (observed; not in doc text) | `salaryRange` (optional) | `workplaceType`, `categories.location` | `id` (UUID), `hostedUrl` | GET: none documented. POST: >2/s per site → 429 | $0 | Moderate (docs: "may be scraped by third parties"; robots: `ai-train=no`) |
| Ashby public posting | GET, no key | `publishedAt` (last publication) | `compensation` with `includeCompensation=true` | `isRemote`, `workplaceType`, `address` | `id` (UUID), `jobUrl` | None documented | $0 | Moderate (docs: intended for orgs hosting their own careers page) |
| SmartRecruiters Posting | GET (no key in live test; docs mention key/OAuth) | `releasedDate` | Not seen in list; detail not checked | `location.remote`, `location.city/region/country` | `id`, `uuid`, `refNumber` | None documented | $0 | Unknown (no ToS found) |
| Workday CXS (undocumented) | POST, no key in live test | `postedOn` is relative ("Posted Today"); `startDate` in detail | Not seen in detail | Location text; no remote flag seen | `jobReqId`, `externalPath` | None known | $0 | High (site terms prohibit scraping; tenant terms unchecked) |
| USAJobs | GET, free `Authorization-Key` | `PublicationStartDate`, `ApplicationCloseDate` | `PositionRemuneration` | `PositionLocation`, `RemoteIndicator` filter | `PositionID` | 10,000 rows/query, 500/page. No per-second limit documented | $0 | Terms not retrieved |
| Adzuna | GET, free `app_id`/`app_key` | `created` | `salary_min/max` plus `salary_is_predicted` flag | `location` | `id` (`redirect_url` is tracking, not canonical) | Not retrieved | Not verified | Terms not retrieved |
| SerpAPI Google Jobs | GET, paid key | Relative `posted_at` in `detected_extensions` | `detected_extensions.salary` | `location`, `schedule_type` | `job_id` (undefined in doc) | Plan throughput (e.g., Starter 200/hr) | Free 250/mo; Starter $25/mo for 1,000 | High for direct use (Google terms prohibit automated access) |
| JSearch (OpenWeb Ninja) | Paid key | Not retrieved | Not retrieved | Not retrieved | Not retrieved | Not retrieved | Not verified | Not assessed |
| LinkedIn | Partner-only API; scraping prohibited | n/a | n/a | n/a | n/a | n/a | n/a | Excluded |
| Indeed | No open API found | n/a | n/a | n/a | n/a | n/a | n/a | Excluded (robots and terms) |
| iCIMS | Approved-vendor XML feed only | `datePosted` | Not in feed | City/state/country | `referenceId` | Not documented | Vendor agreement | Not available to us |

---

## Per-source detail

### Greenhouse Job Board API

- **Endpoints:** `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs` (add `?content=true` for description, departments, offices). Single job: `GET .../jobs/{job_id}` (add `?pay_transparency=true` for pay ranges). Source: [Greenhouse Job Board docs](https://docs.greenhouse.io/job-board.html), redirected from `developers.greenhouse.io/job-board.html`.
- **Auth:** "Job Board data is publicly available, so authentication is not required for any GET endpoints." Only application POST needs a key. Same source.
- **Coverage (live):** `boards-api.greenhouse.io/v1/boards/stripe/jobs` returned 739 jobs on 2026-11-03.
- **List fields (live):** `id`, `internal_job_id`, `title`, `updated_at`, `requisition_id`, `location.name`, `absolute_url`, `language`, `metadata`. With `content=true`: `content`, `departments`, `offices`. Single job adds `first_published`, `application_deadline`, `company_name`, `pay_input_ranges`, `questions`, `data_compliance`.
- **Key semantics (docs):** `id` is the job post ID used to target applications. `internal_job_id` identifies the underlying job, and is `null` for prospect posts.
- **Live identity check:** Stripe job `id` 8172487 has `absolute_url` `https://stripe.com/jobs/search?gh_jid=8172487` and `internal_job_id` 3537052. So the canonical link can be on the company's own domain, not `boards.greenhouse.io`.
- **Pay:** `pay_input_ranges` (`min_cents`, `max_cents`, `currency_type`, `title`, `blurb`) only with `pay_transparency=true` on the single-job endpoint. Costs one extra request per job.
- **Rate limits and caching:** not documented ("Not documented" for both, per the docs fetch).
- **Cost:** free.
- **ToS:** no ToS or license text on the docs page. robots.txt on `boards.greenhouse.io` disallows only `/embed/` ([robots](https://boards.greenhouse.io/robots.txt)).
- **Board token:** the company's slug. Unknown tokens return HTTP 404 (live: `zz-no-such-board-xyz` → 404). Real tokens return 200.

### Lever Postings API

- **Endpoints:** `GET https://api.lever.co/v0/postings/{site}?mode=json` (paging via `skip`/`limit`; EU host `api.eu.lever.co`). Single: `GET .../postings/{site}/{POSTING-ID}`. Source: [Lever postings API docs](https://github.com/lever/postings-api), as served 2026-11-03.
- **Auth:** none for GET. API key only for applying (POST).
- **Fields (docs):** `id`, `text`, `categories` (`location`, `commitment`, `team`, `department`, `allLocations`), `country` (ISO alpha-2), `workplaceType` (`unspecified`/`on-site`/`remote`/`hybrid`), `description`/`descriptionPlain`, `salaryRange` (optional: `currency`, `interval`, `min`, `max`), `hostedUrl`, `applyUrl`.
- **Fields (live, `leverdemo`):** all of the above, plus `createdAt` (epoch milliseconds). `createdAt` is not described in the docs text I read. No update timestamp was seen in the list response.
- **Visibility:** "Only `published` postings are 'publicly viewable,' and 'These jobs may be scraped by third parties.'" Same docs.
- **Rate limits:** documented only for applications. "Lever returns 429 if a custom site issues 'more than 2 application POST requests per second.'" The docs say the limit "may also be changed without warning." No GET limit documented.
- **Cost:** free.
- **ToS:** the "may be scraped by third parties" line above. [jobs.lever.co/robots.txt](https://jobs.lever.co/robots.txt) carries Content-Signal `search=yes, ai-train=no, use=reference`, and says "ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS ARE EXPRESS RESERVATIONS OF RIGHTS UNDER ARTICLE 4 OF THE EUROPEAN UNION DIRECTIVE 2019/790." It does not express `ai-input`, so the signal neither grants nor restricts AI input. Treat AI training as disallowed.
- **Site name:** the company slug. Unknown sites return 404 (live: `zz-no-such-site-xyz` → 404; one probe returned no response, retry gave 404).

### Ashby public posting API

- **Endpoint:** `GET https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}?includeCompensation={true|false}`. Source: [Ashby public job posting API](https://developers.ashbyhq.com/docs/public-job-posting-api).
- **Auth:** none documented or observed.
- **Fields (docs and live):** `id` (UUID; live, not in the docs field table), `title`, `department`, `team`, `employmentType`, `location`, `secondaryLocations[]`, `address.postalAddress`, `isRemote`, `workplaceType` (`OnSite`/`Remote`/`Hybrid`), `publishedAt`, `isListed`, `jobUrl` (`https://jobs.ashbyhq.com/{board}/{id}`, live-verified), `applyUrl` (`.../application`), `descriptionHtml`/`descriptionPlain`, `compensation` (with `includeCompensation=true`: `compensationTierSummary`, `scrapeableCompensationSalarySummary`, `compensationTiers[]`, `summaryComponents[]`). The docs put `compensation` at top level in one example and under `jobs[]` in the table. The live response has it on each job.
- **Freshness:** `publishedAt` is "ISO datetime of last publication." A live job showed `publishedAt` 2024-03-04, so it is not a discovery date.
- **Coverage (live):** the `ashby` board returned a list. Only published postings are returned, and `isListed` controls board visibility.
- **Rate limits:** "The page does not document any rate limits."
- **Cost:** free.
- **ToS:** the docs say the API "is intended for organizations that host their own careers page and want to populate it with this data." No ToS text. [jobs.ashbyhq.com/robots.txt](https://jobs.ashbyhq.com/robots.txt) disallows `/api/`, `/b/`, `/meeting/`, but that file is on the jobs host, not `api.ashbyhq.com`.
- **Board name:** last path segment of the company's hosted board URL. Unknown names return 404 (live).

### SmartRecruiters Posting API

- **Endpoints:** `GET https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings` with optional `q`, `limit`, `offset`, `country`, `region`, `city`, `department`, `language`. Detail: `GET .../postings/{postingId}`. Sources: [Posting API overview](https://developers.smartrecruiters.com/docs/posting-api), [endpoints](https://developers.smartrecruiters.com/docs/endpoints).
- **Auth:** the docs say the Public Posting API supports "API Key and OAuth 2.0 Client Credentials." A live GET for the public `smartrecruiters` company succeeded with no key. Confirm before relying on that.
- **Fields (live list):** `id` (numeric string), `uuid`, `name`, `jobAdId`, `refNumber`, `company.identifier`/`name`, `releasedDate`, `location` (`city`, `region`, `country`, `remote`, `hybrid`, `fullLocation`, lat/long), `industry`, `department`, `function`, `typeOfEmployment`, `experienceLevel`. `jobAd` appears only in the detail response.
- **Unknown company:** `api.smartrecruiters.com/v1/companies/zz-no-such-company-xyz/postings` returned HTTP 200 with `totalFound: 0`. Existence checks must read `totalFound`, not status.
- **Rate limits and ToS:** neither documented in the pages I could read.
- **Cost:** free.
- **Salary:** not seen in the list. Detail not checked.

### Workday CXS endpoints (undocumented)

- **List:** `POST https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with body `{"appliedFacets":{},"limit":N,"offset":N,"searchText":""}`.
- **Detail:** `GET https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/{externalPath}`.
- **Live check (NVIDIA, `nvidia.wd5`, site `NVIDIAExternalCareerSite`):** the list returned `total: 2000` and postings with `title`, `externalPath`, `locationsText`, relative `postedOn` ("Posted Today"), and `bulletFields` holding the requisition ID (e.g., `JR2028076`). Detail returned `startDate` (ISO), `postedOn`, `externalUrl`, `jobReqId`, `jobPostingId`, `location`, `timeType`, `canApply`. No salary or remote-type field appeared in the detail keys I printed.
- **Official docs:** none found. Treat as an internal interface that can change without notice.
- **Robots:** the tenant's robots.txt allows `/NVIDIAExternalCareerSite/`, declares a sitemap, and disallows `/refreshFacet/` and others ([robots](https://nvidia.wd5.myworkdayjobs.com/robots.txt)).
- **ToS:** Workday's [Website Terms (last updated 08/13/2026)](https://www.workday.com/en-us/legal/site-terms.html) under Section 2 prohibit "any data mining, robots or similar data gathering or extraction methods designed to scrape or extract data from our Sites" and "bypass or ignore instructions contained in our robots.txt file." "Sites" is defined as www.workday.com and associated pages. Tenant career sites are not named. Tenant-level terms were not checked.
- **Risk:** high. Requires a legal read before any use.

### USAJobs (federal)

- **Endpoint:** `GET https://data.usajobs.gov/api/Search`. Headers: `Host: data.usajobs.gov`, `User-Agent: <email you registered>`, `Authorization-Key: <key>`. Key request at `developer.usajobs.gov/apirequest/`. Sources: [authentication guide](https://developer.usajobs.gov/guides/authentication), [search API reference](https://developer.usajobs.gov/api-reference/get-api-search).
- **Params:** `Keyword`, `LocationName` (semicolon-separated), `RemoteIndicator`, `DatePosted` (0 to 60 days), `ResultsPerPage` (up to 500), `Page`, `WhoMayApply`. Salary filters are `RemunerationMinimumAmount`/`RemunerationMaximumAmount`.
- **Result fields:** `PositionID` (announcement number), `PositionURI`, `ApplyURI[]`, `PositionTitle`, `PositionLocation`, `PositionRemuneration` (min, max, rate interval), `PublicationStartDate`, `ApplicationCloseDate`, `OrganizationName`, `PositionSchedule`.
- **Limits:** "Maximum of 10,000 rows per query" and "Maximum of 500 rows per page." No requests-per-time-window limit is documented ([rate-limiting guide](https://developer.usajobs.gov/guides/rate-limiting)).
- **Cost:** free. **ToS:** the terms page was not retrievable this session.
- **Coverage:** US federal postings only.

### Adzuna

- **Endpoint:** `GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}?app_id=…&app_key=…` with `what`, `where`, `salary_min`, `full_time`, `permanent`, `sort_by`, `results_per_page`, `content-type`. Source: [search docs](https://developer.adzuna.com/docs/search).
- **Fields:** `id`, `title`, `description` (snippet only: "we currently only provide a snipped of the job description"), `redirect_url`, `created`, `location` (`area`, `display_name`), `salary_min`, `salary_max`, `salary_is_predicted`, `contract_type`, `contract_time`, `company.display_name`, `category`, `latitude`, `longitude`.
- **Predicted salaries:** `salary_is_predicted` marks estimates. These are not employer-stated, which matters for the PRD's "research and estimate" category (§17).
- **Rate limits, pricing, ToS:** not retrieved. The overview and terms pages gave no numbers and the terms URL returned 403/404. Check at signup before any use.

### SerpAPI (Google Jobs) and JSearch

- **SerpAPI pricing** ([pricing](https://serpapi.com/pricing), fetched 2026-11-03): Free $0 for 250 searches/month, 50/hour. Starter $25 for 1,000/month, 200/hour. Developer $75 for 5,000. Production $150 for 15,000 (includes Legal Shield). Only successful, uncached searches count.
- **Google Jobs engine** ([docs](https://serpapi.com/google-jobs-api)): parameters `q`, `location`, `engine=google_jobs`. Result fields: `title`, `company_name`, `location`, `via` (source board, e.g., "Indeed"), `description`, `job_id`, `detected_extensions` (`posted_at`, `salary`, `schedule_type`), `apply_options[]` (`title`, `link`), `share_link`. Cache expires after 1h.
- **ToS:** [Google's Terms](https://policies.google.com/terms) prohibit "using automated means to access content from any of our services" and access "in violation of the machine-readable instructions on our web pages." SerpAPI's Legal Shield addresses the vendor's exposure, not the ToS.
- **Dedup note:** `via` means Google Jobs results include LinkedIn and Indeed postings, so this source reintroduces the sources we exclude.
- **JSearch (OpenWeb Ninja):** the product page says it provides "real-time job postings and salary data" via Google for Jobs ([product page](https://www.openwebninja.com/api/jsearch)). Its pricing and fields could not be retrieved, and secondary sources conflict. Do not rely on it until pricing is confirmed. Do not confuse it with the separate Real-Time Web Search product.

### LinkedIn

- **User Agreement** (effective 2025-11-03, [page](https://www.linkedin.com/legal/user-agreement)) §8.2 prohibits: developing or using "software, devices, scripts, robots or any other means or processes" to scrape or copy the Services (item 2); bypassing access controls (item 3); copying or displaying information obtained from the Services (item 4); "unauthorized automated methods" (item 13); framing or mirroring (item 14); and placing "an unreasonable load" on the Services (item 16). §3.4 lets LinkedIn restrict or terminate accounts.
- **robots.txt** ([robots](https://www.linkedin.com/robots.txt)): "The use of robots or other automated means to access LinkedIn without the express permission of LinkedIn is strictly prohibited."
- **Official API:** the [Job Posting API overview](https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/overview) says "We are currently not accepting new partnerships for LinkedIn's Job Posting API." It is for ATS and distribution partners to post jobs. Use requires an API agreement "with data restrictions."
- **Verdict:** exclude.

### Indeed

- **Official API / publisher:** no open API or publisher program found on a primary source. Secondary sources say the Publisher program has been closed to new applicants since 2022. Unverified against Indeed.
- **Terms** ([legal](https://www.indeed.com/legal), last updated 2026-09-29): Section A 3.5 prohibits automation of Indeed Apply "outside of Indeed's official vendors and tooling." Terms for Job Seekers limit use to "your personal, non-commercial purpose of seeking employment." API use is governed by "Indeed API Terms," which I could not retrieve.
- **robots.txt** ([robots](https://www.indeed.com/robots.txt)): disallows `/viewjob`, `/m/viewjob`, `/rc/`, and `/api/getrecjobs`.
- **Verdict:** exclude.

### iCIMS

- **Official:** a standard XML feed for "Third-party job boards" that iCIMS has approved, with OAuth 2.0 onboarding and delivery "3x daily beginning at 8am ET" ([developer community](https://developer-community.icims.com/platform/services/standard-xml-feed-job-boards)).
- **Fields:** `referenceId`, `url`, `title`, `description`, `datePosted`, `validThrough`, `jobType`, `hiringOrganization`, `city`/`state`/`country`/`postalCode`/`streetAddress`, `other`. No salary field.
- **Public API:** none documented. A sample tenant URL returned a "gone" page.
- **Verdict:** not available for Phase 0 without an iCIMS vendor agreement.

### Google Custom Search JSON API and Bing Search API

- **Google Custom Search JSON API** ([overview](https://developers.google.com/custom-search/v1/overview)): "closed to new customers." Existing customers have "until January 1, 2027 to transition." 100 free queries/day, then $5 per 1,000 up to 10k/day.
- **Bing Search APIs:** retired August 11, 2025. "[T]he product will no longer be available to be used or new customer signup" ([Microsoft Lifecycle](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement)).
- **Effect:** no free programmatic web search exists for ATS discovery.

---

## Finding which companies use which ATS

No source surveyed publishes a directory of companies per ATS. Options:

| Method | Status | Evidence |
|---|---|---|
| Probe known or guessed slugs (Greenhouse token, Lever site, Ashby board name, SmartRecruiters company ID) | Works | Greenhouse, Lever and Ashby return 404 for unknown names, 200 for real ones (live). SmartRecruiters returns 200 with `totalFound: 0`, so check the count. |
| Workday tenant discovery | No directory found | Tenant host embeds a `wdN` number and a site name. A tenant's robots.txt declares a sitemap (live, NVIDIA). |
| Common Crawl URL index | Partially verified | [collinfo.json](https://index.commoncrawl.org/collinfo.json) lists crawl indexes (latest seen: CC-MAIN-2026-43). Two CDX query attempts returned HTTP 504 on 2026-11-03. Usability unverified. Terms (last updated 2024-03-07) grant a "limited license" and require respecting third-party rights ([terms](https://commoncrawl.org/terms-of-use)). The index page asks users "Please do not overload the URL index server." |
| Search APIs | Closed or retired | Google CSE closed to new customers; Bing retired. Brave Search API lists $5 per 1,000 Search requests and "$5 in free credits every month" (pricing conflicts within the same page). Storage rights only on certain plans. |
| SerpAPI Google search | Metered | $25/month for 1,000 searches (Starter). Same Google ToS caveat. |

**Practical path:** Phase 0 needs a seed list of ATS tokens. Build it by hand or from a company list, then probe. Use Common Crawl or Brave as an optional expansion, and verify before depending on either.

---

## Dedup and freshness facts (feeds PRD §19, §31, §91)

**Canonical URLs differ by source:**

- Greenhouse `absolute_url` can be the company's own domain (live: `stripe.com/jobs/search?gh_jid=…`).
- Lever `hostedUrl`: `jobs.lever.co/{site}/{id}`.
- Ashby `jobUrl`: `jobs.ashbyhq.com/{board}/{id}`.
- Workday `externalUrl`: the tenant URL. Includes a title slug and requisition ID.
- USAJobs `PositionURI`.
- Adzuna `redirect_url` is a tracking link, not canonical.
- Google Jobs `share_link` is Google's, and `apply_options` points to other boards.

**Native IDs observed:**

- Greenhouse `id` (equals `gh_jid`), plus `internal_job_id` (cross-board).
- Lever `id` (UUID).
- Ashby `id` (UUID).
- SmartRecruiters `id`, `uuid`, `refNumber`.
- Workday `jobReqId` (e.g., `JR2028076`).
- USAJobs `PositionID`.

**Not verified:** whether any native ID survives a re-post, edit or re-publish. For PRD §19, key on `(source, board, native_id)` and add a fallback fingerprint on normalized company, title, location and description.

**Freshness fields by source:**

- Greenhouse: `updated_at` (list); `first_published` (single job only).
- Lever: `createdAt` only (observed). No update field seen.
- Ashby: `publishedAt` is last publication, not first seen.
- SmartRecruiters: `releasedDate`.
- Workday: relative `postedOn` text. Use detail `startDate`.
- USAJobs: `PublicationStartDate`.
- Implication: our own `discovered_at` is the only uniform freshness signal, and PRD §31 already requires it.

**Structured salary available:** Greenhouse (single-job call with `pay_transparency`), Lever (optional `salaryRange`), Ashby (`compensation`, with `includeCompensation=true`), USAJobs (`PositionRemuneration`), Adzuna (`salary_min`/`max`, plus a predicted flag), SerpAPI (`detected_extensions.salary`). Not seen for Workday or the SmartRecruiters list.

**Structured remote flag available:** Lever (`workplaceType`), Ashby (`isRemote`, `workplaceType`), SmartRecruiters (`location.remote`), USAJobs (`RemoteIndicator` search filter). Greenhouse and Workday show location text only.

---

## Open risks

1. **Rate limits are undocumented** for Greenhouse, Ashby, SmartRecruiters and Workday. Plan for self-throttling, backoff, and monitoring of 403 and 429 responses. Lever's only documented limit is for POST.
2. **ToS posture of the free ATS APIs is unsettled.** Greenhouse has no ToS text and calls data "publicly available." Lever says postings "may be scraped by third parties," and its robots.txt sets `ai-train=no`. Ashby says the API is for organisations hosting their own careers page. None explicitly bans personal, single-user aggregation. Get a legal read before any commercial or multi-user use. The PRD alpha is single-user.
3. **Workday's terms prohibit scraping** and its CXS API is undocumented. Defer until the second-ATS decision, with a legal read.
4. **Undocumented or unofficial endpoints can change without notice:** Workday CXS, and Google Jobs via SerpAPI.
5. **Coverage is per company, and seed lists are a manual dependency.** No official directory exists for any ATS. The search APIs that could fill the gap are closed or retired.
6. **Predicted vs stated salary:** Adzuna flags predictions. Google Jobs output may also be estimated. PRD §17 needs to distinguish these.
7. **Unverified pricing and terms:** Adzuna, JSearch, USAJobs terms, Brave's free tier (page conflicts), and Common Crawl CDX reliability.
8. **Google Jobs via SerpAPI carries LinkedIn and Indeed postings** through the `via` field. Using it would pull excluded sources back in and complicate dedup.
9. **ID stability is unverified** across re-posts and edits, for all sources.
10. **Greenhouse `internal_job_id` is `null` for prospect posts.** Dedup logic must handle that.

---

## Facts downstream decisions depend on

- **Tracer bullet 1 (§76) needs one real discovered job.** Greenhouse, Lever and Ashby each returned live structured data with no key on 2026-11-03. Any one of them is enough.
- **Normalized Opportunity fields available from ATS sources:** source, board, native ID, canonical URL, title, company, location, remote flag, employer-stated salary (where present), source `posted_at`, our `discovered_at`, description.
- **Budget:** ATS APIs cost $0 at Phase 0 volume. Any aggregator is metered and optional. SerpAPI Starter is $25/month for 1,000 searches, which alone exceeds the $20 fixed ceiling if it were treated as infra. It must stay in the capped, optional LLM-style spend bucket.
- **A seed list of ATS tokens is a required input.** It needs a manual or semi-automated build. This is a fog item on the map.
- **Workday and any second ATS** should wait for a legal read and the adapter-order decision.

---

## Sources

All retrieved 2026-11-03 unless noted.

- Greenhouse Job Board API: https://docs.greenhouse.io/job-board.html (redirected from https://developers.greenhouse.io/job-board.html)
- Greenhouse live list: https://boards-api.greenhouse.io/v1/boards/stripe/jobs
- Lever postings API: https://github.com/lever/postings-api
- Lever live: https://api.lever.co/v0/postings/leverdemo?mode=json
- Lever robots: https://jobs.lever.co/robots.txt
- Ashby public job posting API: https://developers.ashbyhq.com/docs/public-job-posting-api
- Ashby live: https://api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true
- Ashby robots: https://jobs.ashbyhq.com/robots.txt
- SmartRecruiters posting API: https://developers.smartrecruiters.com/docs/posting-api
- SmartRecruiters endpoints: https://developers.smartrecruiters.com/docs/endpoints
- SmartRecruiters live: https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings
- Workday CXS (live, NVIDIA): https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs
- Workday robots: https://nvidia.wd5.myworkdayjobs.com/robots.txt
- Workday Website Terms: https://www.workday.com/en-us/legal/site-terms.html
- iCIMS standard XML feed: https://developer-community.icims.com/platform/services/standard-xml-feed-job-boards
- USAJobs authentication: https://developer.usajobs.gov/guides/authentication
- USAJobs search API: https://developer.usajobs.gov/api-reference/get-api-search
- USAJobs rate limiting: https://developer.usajobs.gov/guides/rate-limiting
- Adzuna search docs: https://developer.adzuna.com/docs/search
- SerpAPI pricing: https://serpapi.com/pricing
- SerpAPI Google Jobs: https://serpapi.com/google-jobs-api
- JSearch product page: https://www.openwebninja.com/api/jsearch
- LinkedIn User Agreement (effective 2025-11-03): https://www.linkedin.com/legal/user-agreement
- LinkedIn Job Posting API overview: https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/overview
- Indeed legal (last updated 2026-09-29): https://www.indeed.com/legal
- Indeed robots: https://www.indeed.com/robots.txt
- Google JobPosting structured data (relevant to schema.org ingestion, not a source here): https://developers.google.com/search/docs/appearance/structured-data/job-posting
- Google Terms of Service: https://policies.google.com/terms
- Google Custom Search JSON API: https://developers.google.com/custom-search/v1/overview
- Bing Search API retirement: https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- Common Crawl terms (last updated 2024-03-07): https://commoncrawl.org/terms-of-use
- Common Crawl index list: https://index.commoncrawl.org/collinfo.json
- Brave Search API: https://brave.com/search/api/

**Not verified in this research:** Adzuna terms and pricing; JSearch pricing and fields; USAJobs terms of service; Indeed API terms; Workday tenant-level terms; Common Crawl CDX query behaviour; whether SmartRecruiters requires a key; any live check of LinkedIn. Secondary-source claims about the Indeed Publisher program and the Bing post-retirement behaviour are labelled as such above.
