# Hosting Phase 0 under $20/month, and ATS datacenter-IP blocking

Issue: [#8](https://github.com/dlopezkluever/Jobaculator/issues/8) · Map: [#1](https://github.com/dlopezkluever/Jobaculator/issues/1) · Research date: 2026-11-03
Status: research only. Nothing here is a decision. Branch `research/hosting-under-20` is never merged.

Citation keys `[n]` are listed at the end. "Verified" means I fetched the primary page or downloaded the primary file in this pass. "Secondary" means a third-party article or aggregator. "Estimate" means my own arithmetic or judgement, to be measured.

---

## Short answer

**Recommendation for the Phase 0 host: one US VPS with 4 GB RAM minimum (8 GB preferred), 2 vCPU, 40–80 GB SSD, roughly $5–15/month.** Put the browser on the same box, run it headful under a virtual display, and keep the takeover UI behind TLS and a private network.

- **Cheapest verified US option with enough RAM:** OVHcloud US "VPS 2027" plans at **$4.54 (4 GB) / $8.50 (8 GB)**, daily backups included [10]. Caveat: the page does not name the US datacenter, and the "starting at" terms are not fully stated. Confirm location, term and tax before ordering.
- **Best-documented US option:** DigitalOcean Basic Droplets. 2 GB / 1 vCPU is **$12**, 4 GB / 2 vCPU is **$24**, which is over budget on RAM [9].
- **Netcup VPS 1000 G12.5** (4 vCPU / 8 GB / 128 GB, US location Manassas only) at about **€14.50–16.68/month** on a 12-month term. The VAT basis is unclear [8].
- **Hetzner is not a current option.** Its cheap plans are EU-only and every cost-optimized and US regular-performance plan showed "currently unavailable" when fetched on 2026-11-03. Hetzner raised prices twice in 2026 [1][2][5][6].
- **Oracle Always Free** (2 OCPU / 12 GB ARM) is the lowest-cost option on paper, but Oracle may reclaim idle instances, and "out of host capacity" errors are documented. Treat as an experiment, not the primary host [12].
- **Object storage and backups:** Backblaze B2 at $6.95/TB-month, first 10 GB free [15]. Cloudflare R2 at $0.015/GB-month with zero egress [16]. Both cost well under $1/month at personal-backup sizes. Add a provider snapshot or daily backup where the plan includes one.
- **Remote takeover:** noVNC behind Caddy, or a CDP screencast in a custom web UI. The CDP methods are verified but flagged experimental [29][30]. Hosted browser services cost $20+/month and do not fit the budget with the rest of the stack [32][33].
- **TLS and proxy:** Caddy with automatic Let's Encrypt/ZeroSSL certificates [31].
- **ATS datacenter-IP blocking:** **Not established by primary evidence.** The ATS public read APIs answered from a residential line. Indeed and Glassdoor served a Cloudflare challenge to a plain request from that same line. A datacenter-IP test requires a real datacenter IP. Run that spike before committing to a host. See the risks section.

Monthly estimate for the recommended shape (OVH 8 GB, if the US terms hold): about **$9/month** before domain, LLM spend, and any proxy. Monitoring can be free [36].

---

## 1. VPS options

Prices are as fetched on 2026-11-03 unless noted. Currency is as shown. I did not convert currencies.

| Provider | Plan (shared CPU unless noted) | vCPU | RAM | Disk | Price shown | US location | Status |
|---|---|---|---|---|---|---|---|
| OVHcloud | VPS-1 ("VPS 2027", US site) | 2 | 4 GB | 40 GB NVMe | from $4.54/mo | Not named on page; "Local Zone" in 15+ cities | Verify location and term [10] |
| OVHcloud | VPS-2 | 4 | 8 GB | 75 GB NVMe | from $8.50/mo | as above | Verify [10] |
| OVHcloud | VPS-3 / VPS-4 | 6 / 8 | 12 / 24 GB | 100 / 200 GB | from $12.32 / $23.37 | as above | [10] |
| DigitalOcean | Basic 1 GB | 1 | 1 GB | 25 GB | $6/mo | Named US: SFO, NYC, Richmond, Kansas City, Atlanta (not mapped to plans) | Verified [9] |
| DigitalOcean | Basic 2 GB | 1 | 2 GB | 50 GB | $12/mo | as above | Verified [9] |
| DigitalOcean | Basic 4 GB | 2 | 4 GB | 80 GB | $24/mo | as above | Verified [9] |
| Netcup | VPS 500 G12.5 | 2 | 4 GB | 64 GB | €8.26–9.50/mo (12-month term) | Manassas, VA only | VAT basis unclear [8] |
| Netcup | VPS 1000 G12.5 | 4 | 8 GB | 128 GB | €14.50–16.68/mo (12-month term) | Manassas, VA only | VAT basis unclear [8] |
| Netcup | VPS 2000 G12.5 | 8 | 16 GB | 256 GB | €26.92–30.96/mo | Manassas, VA only | [8] |
| Hetzner | CX23 / CAX11 / CX33 (cost-optimized) | 2–4 | 4–8 GB | 40–80 GB | €5.99 / €6.49 / €8.99 excl. VAT, incl. IPv4 | **EU only** (NBG1, HEL1) | **All 8 cost-optimized plans "currently unavailable"** [1] |
| Hetzner | CPX11 / CPX21 (regular performance) | 2 / 3 | 2 / 4 GB | 40 / 80 GB | €17.99 / €32.49 excl. VAT | ASH1, HIL1 | **All 12 regular-performance plans "currently unavailable"** [2] |
| Oracle Cloud | Always Free A1 (ARM) | 2 OCPU total | 12 GB total | 200 GB block total | $0 | Home region only | Reclaim policy applies (section 1.1) [12] |
| Oracle Cloud | Always Free E2.1.Micro | 1/8 OCPU | 1 GB | shared 200 GB | $0 | Home region | Too small for this workload [12] |
| Google Cloud | Always Free e2-micro | shared | 1 GB | 30 GB std PD | $0 | us-west1 / us-central1 / us-east1 only | Too small for this workload [14] |
| Akamai (Linode) | Nanode 1 GB / Shared 2 GB / Shared 4 GB | 1–2 | 1–4 GB | — | ~$5 / $12 / $24 | — | **Secondary only**: official page did not list plans [17] |
| Vultr | Cloud Compute | — | — | — | Unresolved | — | **Unverified**: vultr.com returned 403; aggregators disagree on 2 GB/4 GB prices [18] |

### 1.1 Pricing changes that affect planning

- **Hetzner, April 1 2026:** a general increase of roughly 30–37% for cloud, dedicated and storage products, citing energy and hardware costs [7][38]. Secondary sources only; Hetzner's own price-adjustment page returned 404 to my fetch [39].
- **Hetzner, June 15 2026:** a second change. Only new orders and resizes are repriced. CCX and CPX rose about 113–175%, and CAX and CX about 30%, for Germany/Finland [5][6]. The article prices exclude IPv4, while the live page says "Price incl. IPv4". Those two figures match, for example CX23 €5.49 + IPv4 ≈ €5.99. US prices were not reported.
- **DigitalOcean:** billing is per second with a 60-second minimum from 2026-01-01 [9].
- **Oracle, idle reclaim:** an Always Free compute instance can be reclaimed if, over 7 days, CPU p95 < 20%, network < 20%, and memory < 20% (A1 only) [12]. A lightly used single-user host could meet that. The fetched primary page says the A1 free allotment is 2 OCPU / 12 GB [12]. A search snippet claimed 4 OCPU / 24 GB and that Oracle halved the allotment in 2026 [13]. Treat the primary page as authoritative, and re-check before any decision.

### 1.2 Provider notes

- **OVH US:** the "VPS 2027" page says "starting at" and does not state the term or tax basis. It does not name the US datacenters. Local Zone VPSs lack additional IPs, load balancers and some features [10]. The deprecated "VPS-1 US" listing on a third-party benchmark site shows $7.60/month at 4 vCPU / 8 GB in Virginia, which conflicts with the current page [11]. Confirm before buying.
- **Netcup:** the only US location is Manassas (MNZ), and the location cannot be changed after setup. Snapshots and traffic are included [8].
- **DigitalOcean:** backups cost 20% of droplet price (weekly) or 30% (daily). Snapshots are $0.06/GB-month [9]. Adding weekly backups to the 2 GB plan brings it to $14.40/month before storage.
- **Hetzner:** the Storage Box is still cheap. BX11 (1 TB) is €3.20/month, EU-located (Germany or Finland), with BorgBackup, Restic and rsync access [4]. This is an option for offsite backups even if the VPS is elsewhere.

### 1.3 RAM budget for the workload

These are estimates. Measure in the first spike; numbers are not from a benchmark.

| Component | Estimate | Basis |
|---|---|---|
| OS, sshd, systemd, Caddy | ~0.3 GB | Estimate |
| PostgreSQL | ~0.3–0.5 GB | `shared_buffers` default 128 MB; PG docs suggest ~25% of RAM on a dedicated server with 1 GB+ [34]. Remainder is per-connection overhead and cache. Estimate |
| Node web/API | 0.15–0.3 GB | Estimate |
| Node worker(s) | 0.15–0.3 GB | Estimate |
| Headful Chromium, 1 session | 0.3–0.6 GB | Estimate; heavy JS pages are higher |
| Headful Chromium, 2 sessions | 0.6–1.2 GB | Estimate; PRD §71 suggests `MAX_BROWSER_SESSIONS=2` [PRD] |
| Virtual display + VNC + websockify (only while a human is attached) | 0.05–0.15 GB | Estimate |
| **Total, 1 browser** | **~1.3–2.1 GB** | |
| **Total, 2 browsers** | **~1.6–2.7 GB** | |

Conclusion: **2 GB is too tight** for two browsers. It can work with one browser concurrency, swap and careful tuning. **4 GB is the floor**, and 8 GB gives headroom.

---

## 2. Datacenter-IP blocking: evidence

### 2.1 Vantage point and method

I probed public endpoints from this machine on 2026-11-03. The network is a residential Comcast connection (AS7922, Baltimore, MD) [40]. Probes used a desktop Chrome user agent and plain GET requests. This is a **residential control**, not a datacenter test. It tells us what the sites serve to a normal home line, and nothing about datacenter IPs.

| Endpoint | Result (residential line) | Notes |
|---|---|---|
| Greenhouse `boards-api.greenhouse.io/v1/boards/stripe/jobs` | 200 | Public GET needs no auth [19] |
| Greenhouse `job-boards.greenhouse.io/stripe` | 302 to the company careers site | Greenhouse-hosted board redirects [probe] |
| Lever `api.lever.co/v0/postings/lever?mode=json` | 200 | Community-documented public read; see 2.3 [20] |
| Lever `jobs.lever.co/lever` | 200 (Cloudflare) | [probe] |
| Ashby `api.ashbyhq.com/posting-api/job-board/ashby` | 200 (Cloudflare) | Public, no key [21] |
| Workday `nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite` | 200 (Cloudflare) | Tenant URL; no datacenter test [probe] |
| iCIMS `careers-icims.icims.com/` | 405 (CloudFront) | Inconclusive; no known live tenant tested [probe] |
| LinkedIn `/jobs/search/?keywords=engineer&location=United%20States` | 200 (Cloudflare, `__cf_bm` cookie set) | Served a page to a plain request [probe] |
| **Indeed `indeed.com/jobs?q=engineer&l=Remote`** | **403, `cf-mitigated: challenge`** | Cloudflare managed challenge on a residential line [probe] |
| **Glassdoor `glassdoor.com/Job/jobs.htm`** | **403, `cf-mitigated: challenge`** | Same pattern [probe] |

Interpretation: **Indeed and Glassdoor challenge non-browser clients regardless of IP type.** The other sites served content to this residential line. None of this shows a datacenter-IP difference.

### 2.2 Per-site evidence

Confidence key: **High** = primary document or observed behavior. **Medium** = primary document describing the capability, without confirmation of use. **Low** = community or vendor claim. **None** = no evidence found.

| Site | Datacenter-IP evidence | Confidence | Other relevant primary facts |
|---|---|---|---|
| **Greenhouse** | None found. Public GET needs no auth; "Job Board data is publicly available" [19] | None for blocking | Application POST exists but needs a Job Board API key, and Greenhouse recommends the embedded form over custom forms. The embedded form "has built-in spam protection measures" [19] |
| **Lever** | None found | None for blocking | Public postings reads: docs show API-key auth on the Postings API, but the `api.lever.co/v0/postings` public endpoint returned 200 here [20]. Apply endpoint is `POST /postings/:posting/apply` and needs a key from a Super Admin [20] |
| **Ashby** | None found | None for blocking | Public board endpoint, no key, rate limits not stated [21] |
| **Workday** | None from primary sources. Apify vendor pages say datacenter proxies are sufficient [search, low confidence] | None / Low | No primary evidence of Workday's bot vendor found |
| **iCIMS** | None found | None | Nothing usable found in this pass |
| **LinkedIn** | 2014–2016 Stack Overflow posts report HTTP 999 from AWS/Ubuntu IPs that worked from home [37] | Low (old, community) | ToS §8.2 prohibits scraping and bots [22]. robots.txt says robots and automated means without permission are prohibited [23] |
| **Indeed** | Observed challenge on residential line (above) | High that a challenge exists; datacenter-specific: None | ToS A.3 "Limits": automation of Indeed Apply is prohibited "outside of Indeed's official vendors and tooling" [24]. robots.txt disallows `/viewjob` and `/rc/` [25] |

### 2.3 Cloudflare documentation

- Cloudflare's bot score is 1–99. It comes from heuristics, ML ("Adaptive Intelligence") and anomaly detection, plus a JavaScript Detections engine that "identifies headless browsers" [26]. The bot-score page does not mention datacenter, ASN or IP reputation as inputs [26]. So **Cloudflare's documentation does not confirm datacenter-IP pre-scoring.**
- Bot Fight Mode "identifies traffic matching patterns of known bots" and issues computational challenges. It does not mention cloud-provider ASNs [27].
- Site operators can match on ASN with the `ip.src.asnum` field in custom rules. The example in the docs is ASN-based blocking, which means site owners can block cloud ASNs if they choose [28]. This is a documented capability, not evidence that these ATS sites do so.
- **Why it matters:** the JSD engine flags headless browsers [26]. A headful browser under a virtual display avoids that signal. This follows from the docs and is not independently tested.

### 2.4 Budget-fitting mitigations

Ordered by how much they reduce risk for the least cost.

1. **Use the public ATS read APIs for discovery, not the browser.** Greenhouse and Ashby document no-auth public job data [19][21]. Lever's public endpoint answered here, but Lever's docs describe key-based auth for the Postings API [20], so Lever needs a check before it is relied on. This avoids datacenter-IP sensitivity during discovery. Confirm with the spike.
2. **Keep LinkedIn and Indeed out of Phase 0 discovery.** Both ToS forbid bots or automation [22][24]. Indeed challenges plain clients [probe]. This is a product decision for the user; I am flagging it, not making it.
3. **Run a US datacenter, not EU.** Netcup (Manassas), OVH US and DigitalOcean (SFO/NYC etc.) match the user's market. Hetzner EU locations would add a geographic mismatch, which I could not measure.
4. **Run the browser headful under Xvfb.** The JSD engine flags headless browsers [26]. This also gives noVNC a real display to show (section 4).
5. **Only if the spike shows blocks:** a residential egress. Options include a Tailscale exit node on the home line, which needs the home machine online, or a metered residential proxy, which I did not price in this pass. Any proxy budget must be capped under PRD §64.

### 2.5 How to settle the datacenter question (spike)

Run this on a `research/` or `prototype/` branch, never merged [map Notes]:

- Rent a US VPS for a day (the cheapest of the options above).
- Run the same probe list from section 2.1, plus a headless and a headful Chromium loading one live posting from each of Greenhouse, Lever, Ashby, Workday, iCIMS, LinkedIn and Indeed.
- Compare status codes and challenge headers with the residential results above.
- Optional and untested: a GitHub Actions job on a research branch runs from Azure datacenter IPs for free. That is a second datacenter vantage point.

---

## 3. Object storage and backups

| Option | Price | Free tier | Egress | Notes |
|---|---|---|---|---|
| **Backblaze B2** | $6.95/TB-month (~$0.00695/GB) [15] | First 10 GB free | Free up to 3× average stored data, then $0.01/GB [15] | No minimum duration or file size fees [15] |
| **Cloudflare R2 Standard** | $0.015/GB-month [16] | 10 GB-month free; 1M Class A and 10M Class B ops free | **Zero egress** via Workers, S3 API or r2.dev [16] | Infrequent Access: $0.01/GB, 30-day minimum [16] |
| **Hetzner Storage Box BX11** | €3.20/month for 1 TB, excl. VAT [4] | — | Included (SSH/rsync/Borg/Restic access) [4] | Location Germany or Finland only [4] |
| **Provider snapshots/backups** | Varies (see 1.2) | — | — | DigitalOcean 20% (weekly) [9]; OVH daily backups included [10]; Netcup snapshots included [8]; Hetzner snapshots €0.0143/GB-month [1] |

Recommended pattern (estimate): nightly `pg_dump` plus the app's blob directory, encrypted, pushed to B2 or R2, with a weekly copy to the Storage Box if the user wants a second provider. At 10–50 GB stored, this costs well under $1/month on either B2 or R2. Pick one primary backup target and document the restore drill. Restore egress is the main cost difference: R2 has none, B2 charges only above 3× stored. Restic/Borg tool choice was not verified in this pass.

---

## 4. Remote takeover of the headless browser

Goal: the user can see and take over a browser session when the app needs a human ("Continue" in PRD §45, session persistence in §43).

| Approach | What it is | Footprint (estimate unless noted) | Evidence | Notes |
|---|---|---|---|---|
| **noVNC + VNC server + websockify on Xvfb** | Run headful Chromium on an X virtual display; expose the display over VNC; noVNC in the browser connects via websockify | ~50–150 MB RAM while attached; bandwidth proportional to screen changes | noVNC is an HTML VNC client library and application, MPL-2.0, needs a WebSocket-to-TCP proxy (websockify) for most servers. Supported auth: none, classic VNC, RealVNC RSA-AES. No TLS in the README; use Caddy [30] | Mature and simple. Must be behind TLS and an access layer; never exposed raw |
| **CDP screencast in a custom UI** | Chrome DevTools Protocol `Page.startScreencast` sends frames as `Page.screencastFrame` events (base64 JPEG/PNG); the client must send `Page.screencastFrameAck` [29] | Lower than VNC; frame rate and resolution are the cost | Verified in the protocol JSON. Both methods are marked **`experimental: true`** [29] | View is straightforward. Input forwarding (mouse, keyboard) was **not verified** in this pass; it would need CDP Input methods |
| **Hosted live-view browser** (Browserbase, Browserless) | Managed Chromium with a live view | No VPS RAM | Browserbase Developer plan $20/month, 100 browser hours [33]. Browserless Prototyping $25/month, Starter $140 [32]. Neither pricing page lists a live view for the cheapest plans [32][33] | **Exceeds budget** once a VPS is added. Not recommended for Phase 0 |
| **Local-only (user's machine)** | Run the browser on the user's own computer | None on VPS | Not researched in depth | Conflicts with PRD §67 ("close their laptop without interrupting Hunts") |

Recommendation: **noVNC behind Caddy, with an access layer (see section 5)**, plus the CDP screencast as an optional lighter view later. Both are open source or first-party, and neither adds a monthly fee.

---

## 5. TLS, domain, reverse proxy

- **Caddy** provisions and renews TLS certificates automatically and redirects HTTP to HTTPS. Requirements: the domain's A/AAAA record points at the server, and ports 80 and 443 are open [31]. Default CAs are Let's Encrypt and ZeroSSL [31].
- Caddy's docs warn that testing against production ACME rate-limits can block HTTPS for up to a week. Use the staging endpoint while testing [31].
- On-demand TLS must be restricted to prevent abuse [31].
- **Access for the takeover UI:** the noVNC port should not be public. Options:
  - **Tailscale** Personal (free): up to 6 users, unlimited devices, **non-commercial use only** [35]. Fine for a personal alpha. Revisit before any commercial use. Paid Standard is $8/user-month [35].
  - **Cloudflare Tunnel / Access:** not verified. The Zero Trust page did not state free-plan user limits or Tunnel availability in this pass [search, unverified].
- **Monitoring:** Healthchecks.io free plan includes 20 checks; Business is $20/month [36]. Enough for cron heartbeats. Uptime Kuma was not researched.

---

## 6. Open risks and facts downstream decisions depend on

**Facts that are firm:**
- Hetzner's EU cost-optimized plans are the cheapest prices, but they are EU-only and currently unavailable. US Hetzner plans are €17.99+ and also unavailable [1][2].
- Hetzner raised prices twice in 2026 (April and June) [5][6][7].
- Greenhouse and Ashby document no-key public job data [19][21]. Lever's public endpoint answered without a key, but its docs describe key-based auth [20] (unresolved).
- Application submission through Greenhouse's POST API and Lever's apply endpoint requires an employer-issued API key [19][20]. **Browser-based submission is therefore needed for most ATS flows**, unless the key situation changes.
- Indeed and Glassdoor challenge plain requests from a residential line [probe]. Indeed's ToS prohibits automation of Indeed Apply outside official vendors [24].
- LinkedIn's ToS prohibits scraping and bots [22].
- Caddy automatic HTTPS works on a public domain with ports 80/443 open [31].
- CDP `Page.startScreencast` and `Page.screencastFrameAck` exist, marked experimental [29].
- PostgreSQL default `shared_buffers` is 128 MB [34].

**Uncertain, to verify before relying on it:**
- **Datacenter-IP blocking for all seven sites.** No primary source found. Run the spike in section 2.5.
- **OVH US location and terms.** The US page does not name datacenters or the term behind "from $4.54" [10].
- **Netcup VAT basis.** The 12-month price shows €14.50 excl. and €16.68 incl. VAT, but the arithmetic does not match 19%, so the basis is unclear [8].
- **Vultr and Linode/Akamai pricing.** Official pages did not load or did not list plans. Only aggregators [17][18].
- **Oracle A1 allotment.** Primary page says 2 OCPU / 12 GB; a search snippet said 4/24. Re-check on the primary page before any decision [12].
- **Oracle idle reclaim for this workload.** Plausibly triggered by a lightly used single-user host. Not a plan to rely on.
- **Workday and iCIMS.** No ATS-vendor documentation found on their bot defences. Their public tenant pages responded from a residential line (Workday) or inconclusively (iCIMS).
- **Cloudflare ASN blocking on these sites.** Documented capability [28]; no evidence it is used.
- **Greenhouse custom-form spam protection.** The docs say the embedded form has protection; no statement about custom-POST submissions.
- **Hetzner backup pricing for current plans.** Not fetched; the cost-optimized page gave only snapshot pricing.
- **CDP input forwarding for takeover.** Not verified; the screencast is view-only in what I checked.
- **Hosted browser live view.** Not listed on the cheapest plans of Browserless or Browserbase [32][33].
- **Tailscale and Cloudflare Tunnel as access layers for a future commercial product.** Tailscale Personal is non-commercial only [35]. Cloudflare Tunnel was not verified.

**Decisions that depend on these facts (for later):**
1. Host choice (US, 4 GB vs 8 GB, provider) depends on the OVH US terms, the spike result, and whether the user accepts a 12-month commitment (Netcup).
2. Whether Phase 0 discovery uses ATS public APIs first, and whether LinkedIn and Indeed are in scope at all (ToS).
3. Concurrency cap for browsers (`MAX_BROWSER_SESSIONS`) is bounded by RAM: 1 session fits 2 GB, 2 sessions want 4 GB or more.
4. Whether a residential egress or proxy is in the budget, and at what cap.
5. Takeover approach (noVNC vs CDP screencast) and access layer (Tailscale is non-commercial).
6. Backup target (B2 vs R2 vs Storage Box) and restore drill.

---

## Sources

[1] Hetzner Cost-Optimized plans, fetched 2026-11-03: https://www.hetzner.com/cloud/cost-optimized
[2] Hetzner Regular Performance plans, fetched 2026-11-03: https://www.hetzner.com/cloud/regular-performance
[3] Hetzner cloud overview: https://www.hetzner.com/cloud
[4] Hetzner Storage Box: https://www.hetzner.com/storage/storage-box
[5] Hetzner June 2026 price change (secondary): https://privatedevops.com/news/hetzner-june-2026-cloud-price-increase-what-to-do
[6] Hetzner June 2026 price increase (secondary): https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/
[7] Hetzner April 2026 price increase, Tom's Hardware (secondary, search result): https://www.tomshardware.com/tech-industry/hetzner-to-raise-prices-by-up-to-37-percent-from-april-1
[8] Netcup VPS, fetched 2026-11-03: https://www.netcup.com/en/server/vps
[9] DigitalOcean Droplet pricing, fetched 2026-11-03: https://www.digitalocean.com/pricing/droplets
[10] OVHcloud US VPS page, fetched 2026-11-03: https://us.ovhcloud.com/vps/
[11] OVHcloud US VPS-1, third-party benchmark (secondary): https://www.vpsbenchmarks.com/hosters/ovhcloud_us/plans/vps-1
[12] Oracle Always Free resources, fetched 2026-11-03: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
[13] Oracle Always Free search snippet (conflicting allotment, secondary): https://docs.oracle.com/iaas/Content/FreeTier/resourceref.htm
[14] Google Cloud free tier, fetched 2026-11-03: https://docs.cloud.google.com/free/docs/free-cloud-features
[15] Backblaze B2 pricing, fetched 2026-11-03: https://www.backblaze.com/cloud-storage/pricing
[16] Cloudflare R2 pricing, fetched 2026-11-03: https://developers.cloudflare.com/r2/pricing/
[17] Akamai/Linode pricing: https://www.akamai.com/cloud/pricing (did not list plans); plan figures from secondary sources: https://betterstack.com/community/guides/web-servers/linode-akamai-review/
[18] Vultr pricing: https://www.vultr.com/pricing/ (403 to fetch); aggregator: https://vultr-guide.pages.dev/blog/article-20260615.html (secondary, unverified)
[19] Greenhouse Job Board API, fetched 2026-11-03: https://docs.greenhouse.io/job-board.html
[20] Lever developer documentation, fetched 2026-11-03: https://hire.lever.co/developer/documentation
[21] Ashby public job posting API, fetched 2026-11-03: https://developers.ashbyhq.com/docs/public-job-posting-api
[22] LinkedIn User Agreement, fetched 2026-11-03: https://www.linkedin.com/legal/user-agreement
[23] LinkedIn robots.txt, fetched 2026-11-03: https://www.linkedin.com/robots.txt
[24] Indeed legal terms, fetched 2026-11-03: https://www.indeed.com/legal
[25] Indeed robots.txt, fetched 2026-11-03: https://www.indeed.com/robots.txt
[26] Cloudflare bot score concepts, fetched 2026-11-03: https://developers.cloudflare.com/bots/concepts/bot-score/
[27] Cloudflare Bot Fight Mode, fetched 2026-11-03: https://developers.cloudflare.com/bots/get-started/free/
[28] Cloudflare custom rule examples with ASN matching (search result, preview-domain copy): https://developers.cloudflare.com/waf/custom-rules/use-cases/update-rules-customers-partners/index.md
[29] Chrome DevTools Protocol browser_protocol.json, downloaded 2026-11-03: https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json
[30] noVNC README: https://github.com/novnc/noVNC
[31] Caddy automatic HTTPS: https://caddyserver.com/docs/automatic-https
[32] Browserless pricing, fetched 2026-11-03: https://www.browserless.io/pricing
[33] Browserbase pricing, fetched 2026-11-03: https://www.browserbase.com/pricing
[34] PostgreSQL resource configuration: https://www.postgresql.org/docs/current/runtime-config-resource.html
[35] Tailscale pricing, fetched 2026-11-03: https://tailscale.com/pricing
[36] Healthchecks.io pricing, fetched 2026-11-03: https://healthchecks.io/pricing/
[37] LinkedIn 999 response, community (low confidence): https://www.scrapingdog.com/webscraping-problems/web-scraping-blocked/999-response-when-scraping-linkedin-profile
[38] Hetzner April 2026 increase, IgorsLab (secondary, search result): https://www.igorslab.de/en/hetzner-to-significantly-increase-prices-for-cloud-and-dedicated-servers-from-april-2026/
[39] Hetzner official price-adjustment page: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ (404 to fetch)
[40] Vantage point lookup, this machine, 2026-11-03: https://ipinfo.io/json (result: AS7922 Comcast Cable, Baltimore, MD, US)
[PRD] `init-prd.md` §43, §45, §64, §67, §68, §71 in this repository.
[probe] Curl probes run from this repository's machine on 2026-11-03; the raw output is not committed.
