# PROTOTYPE, throwaway: Greenhouse dry-run spike

Spike for [Spike: dry-run one real ATS application from the VPS](https://github.com/dlopezkluever/Jobaculator/issues/19). Never merged.

`spike.mjs` opens a live Greenhouse hosted form, discovers fields from the DOM, fills them with an obviously fake candidate (`dryrun.spiketest@example.com`), uploads a generated test resume, verifies the observed values, and **stops before submit**. It never clicks the submit button. It also cancels every `submit` event, disables `form.submit()` and `form.requestSubmit()`, and aborts any non-GET request to Greenhouse application paths. Each run writes `out/<board>-<job>-<mode>-<ts>/report.json` plus screenshots.

## Run on the VPS (Ubuntu)

```sh
git clone -b prototype/greenhouse-dry-run https://github.com/dlopezkluever/Jobaculator.git
cd Jobaculator/prototypes/greenhouse-dry-run
# needs Node 22+ (e.g. `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs`)
npm ci || npm install
sudo npx playwright install-deps chromium && npx playwright install chromium
sudo apt-get install -y xvfb

node spike.mjs figma 5426468004                       # headless
xvfb-run -a node spike.mjs figma 5426468004 --headful # headful, as a Takeover browser would run
node spike.mjs discord 8927168002
node spike.mjs cloudflare 7695702
```

Optional LLM answers for questions the rules cannot answer (measures LLM cost): set `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`, and `LLM_IN_PER_MTOK` / `LLM_OUT_PER_MTOK` if the model is not priced at $3 / $15 per million tokens.

Job ids go stale as postings close. Pick a fresh one with
`curl -s https://boards-api.greenhouse.io/v1/boards/figma/jobs | jq '.jobs[0].id'`.

## Results from the Amp orb (2026-11-18)

Host: E2B sandbox on a Google Cloud US IP, 2 vCPU / 3.9 GB RAM, roughly the CX23 shape. Not the VPS.

| Run | Fields | Result | Time | Memory used (MemAvailable drop) |
|---|---|---|---|---|
| figma 5426468004 headless | 19 | all filled, verified, stopped before submit | 24 s | 351 MB |
| figma 5426468004 headful (Xvfb) ×4 | 19 | same | 25 s | 490–580 MB |
| discord 8927168002 headless | 26 | same (3 required selects answered by first-option fallback; needs LLM) | 30 s | – |
| cloudflare 7695702 headless | 16 | same | 20 s | – |
| stripe 8172510 | – | **not a Greenhouse page**: 302 to `stripe.com/jobs/search?gh_jid=…`, an employer-hosted embed | – | – |

- **No blocking and no visible challenge** on any Greenhouse page from a datacenter IP. Every form loads reCAPTCHA Enterprise (invisible, `render=` site key). Its score is only evaluated at submit, so a dry run **cannot measure whether submission would be challenged or diverted to an emailed code**.
- **The DOM is the truth, not the schema.** The DOM has fields the `questions=true` schema lacks (Country, Location (City) with async geocoder search, the phone country picker), and EEO fields come from the schema's `compliance` block. The DOM does *not* mark the resume input required while the schema does; required-ness must merge both.
- **Widgets:** react-select comboboxes (options under `react-select-<id>-option-N`; value read from `.select__single-value`); the intl-tel-input country list is always in the DOM and pollutes a naive `[role=option]` query; the resume input is replaced by a file chip after upload.
- **A dry run is not side-effect free.** Uploading the resume POSTs it to Greenhouse's S3 bucket (`grnhse-prod-jben-us-west-2`) and analytics beacons fire (Snowplow). No application is created.
- LLM cost: $0 in these runs (no key in the orb; rules plus canned text answered everything).
