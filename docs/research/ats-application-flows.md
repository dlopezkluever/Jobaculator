# ATS application flows: Greenhouse, Lever, Ashby, Workday, iCIMS

Research for issue [#3](https://github.com/dlopezkluever/Jobaculation/issues/3), part of the Phase 0 architecture map [#1](https://github.com/dlopezkluever/Jobaculation/issues/1). Date of research: 2026-11-03. No application was submitted to any employer. Facts are presented with their sources; the final first-family decision is made later with the user.

Blocks: #17 (browser execution: drivers, ATS adapters vs general agent, dry-run) and #26 (Phase 0 spec assembly).

## Evidence tags

- **[V]** Verified by us on 2026-11-03 with unauthenticated GET requests to public pages or public listing APIs. No form was submitted.
- **[D]** Official vendor documentation (URL cited).
- **[E]** Employer help-center or support page describing that employer's own Workday or iCIMS setup.
- **[P]** Practitioner or open-source code, self-reported, not independently verified by us.
- **[T]** Third-party, vendor-marketing, or aggregator claim. Treat as unverified.

## Short answer

**Ranked recommendation for the first ATS family: 1. Greenhouse.** Then 2. Ashby, 3. Lever, 4. Workday, 5. iCIMS. Greenhouse has the best combination of: no account wall on the sampled hosted forms, a machine-readable question schema that can serve as dry-run fixtures, a visible-challenge-free invisible reCAPTCHA in the normal case, a confirmation URL, and a meaningful share of companies (roughly 19-22% in two datasets). Its main risks are the score-based reCAPTCHA, email-code verification on some submissions, and driver gaps such as EEO dropdowns (see Greenhouse below).

Key facts behind the ranking:

- **None of the five families offers an applicant-side submission API.** Each vendor's submit endpoint is keyed to the employer (a Greenhouse Job Board key, a Lever Super-Admin key, an Ashby `candidatesWrite` key, Workday integration-user credentials, iCIMS partner credentials). Submission for an autonomous agent therefore goes through the hosted application form in a browser, which is the PRD section 41 preferred path. The employer-keyed endpoints must not be used with keys we do not hold.
- **Anti-bot gates exist on the hosted forms of Greenhouse (reCAPTCHA), Ashby (reCAPTCHA plus an admin-set spam threshold), and Lever (hCaptcha on submit).** Workday and iCIMS are unverified on this point.
- **Workday and iCIMS require a candidate account** on the employer's tenant before applying. Workday's account requirement changes in early calendar 2027 (see Workday).
- **Share numbers conflict widely** between datasets. Use them as order-of-magnitude only (see Market share).

## Method and coverage

- **Greenhouse:** 11 public job-detail responses (`questions=true`) from 8 public boards (stripe, airbnb, coinbase, cloudflare, databricks, figma, discord, dropbox). 1 hosted application page (figma) read as HTML. Official Job Board API docs read.
- **Lever:** 2 hosted apply pages (Palantir and Spotify) read as HTML. Public postings list read for both companies. Official postings-API README read.
- **Ashby:** 6 hosted application pages (openai x2, ramp x2, linear x2) read as HTML. The form-field definitions load client-side and were not extracted. Official docs and API reference read.
- **Workday:** public job-search endpoint of one tenant (NVIDIA) queried. No application page was reached (it requires a session). Employer help pages, the Workday newsroom, and one open-source practitioner repo read.
- **iCIMS:** one tenant search page (Rambus) fetched; its job pages are JavaScript-rendered and were not inspected. Official iCIMS candidate guide read. Vendor claims read and marked [T].

Open-source projects consulted: `privacydied/job-application-skill` (practitioner notes on Greenhouse, Workday, captcha policy, and the ATS submit surface) and `isobed18/tapsubmit` (adapter code for Greenhouse, Lever, Ashby confirmation and form selectors). Both are small projects with self-reported live runs, so their claims are tagged [P].

## Summary table

| | Greenhouse | Ashby | Lever | Workday | iCIMS |
|---|---|---|---|---|---|
| Hosted form shape | Single page [V] | Single page form in a posting tab [P] | Single page [V] | Multi-step wizard [P] | Multi-step, profile first [D] |
| Account required | No (sampled boards) [V] | No (markup) [V] | No (markup) [V] | **Yes**, per employer [E] | **Yes**, profile [D] |
| Anti-bot on hosted form | reCAPTCHA (invisible, Enterprise script) [D][V] | reCAPTCHA (badge and universal key, version not stated), admin spam threshold [V][D] | hCaptcha on submit [V] | Unknown; one practitioner saw none [P] | Unknown; vendor claims only [T] |
| Confirmation signal | `/confirmation` URL, "Thanks for applying!" [P] | Success container; API `success: true` [P][D] | `/thanks` URL [P] | Not verified | Confirmation page [D] |
| Applicant-side submit API | No (board-owner key) [D] | No (`candidatesWrite` key) [D] | No (Super-Admin key) [D] | No (integration user) [T] | No (partner-gated) [T] |
| Share of companies (rough) | 19-22% in 2 datasets [T] | 2-5% overall; ~22% of tech employers in 1 dataset [T] | 3-17% depending on dataset [T] | 15-75% depending on dataset [T] | 2-15% depending on dataset [T] |

## Greenhouse

**Form structure.** The hosted form is served at `job-boards.greenhouse.io/{board}/jobs/{id}`. The markup has one `<form id="application-form">` containing all fields, so it is single-page (figma sample) [V]. The form is constructed from the job's `questions` array, which Greenhouse's Job Board API exposes on the job-detail endpoint [D].

**Public question schema (dry-run fixture source).** `GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}?questions=true` returns the form definition with no authentication [V]. Across the 11 sampled jobs there were 172 questions, 134 required. Field types observed:

- `input_text` (76), `textarea` (27), `input_file` (21), `multi_value_single_select` (64), `multi_value_multi_select` (5) [V].
- Standard fields: `first_name`, `last_name`, `email`, `phone`, `resume` (required on the stripe sample), `cover_letter` (optional), plus location and country questions.
- Custom questions are keyed `question_<id>` [D]. Multi-select fields are named with `[]` (for example `question_68935297[]`) [V].
- GDPR-style consent objects appeared on 5 of the 11 jobs (`data_compliance`) [V].

The `demographic_questions` key was absent from all 11 public responses [V]. The hosted markup for figma contains EEOC, gender, and veteran text [V].

**Single vs multi-step.** Single page on the sampled hosted form [V]. No multi-step flow observed.

**Account or login.** No sign-in was present in the sampled hosted markup [V]. The MyGreenhouse FAQ says "Accounts are never created automatically" and that an account can be created when setting up a job alert or autofilling an application [D] (MyGreenhouse FAQ for candidates). The official article does not state explicitly that an account is never required to apply.

**Field and question types.** See the schema above. Two practitioner-reported driver issues: react-select combobox values need to be read from the container, not the input's `.value` [P]; and the EEO dropdowns on some Remix-based boards did not fill through the helper, leaving submit blocked on "This field is required" [P].

**EEO / demographic blocks.** Per the official API doc, demographic answers are sent as `demographic_answers` and apply only "if your organization has Greenhouse Inclusion." "These questions are always optional" [D]. Hosted markup contains EEO-type text [V]. Whether the hosted form presents them as optional depends on the employer's setting.

**File uploads.** Accepted types for resume and cover letter: `pdf, doc, docx, txt, rtf`, file size greater than 0 bytes [D]. The hosted file input has `accept=".pdf,.doc,.docx,.txt,.rtf"` [V]. A practitioner reports the resume attach working via file upload [P].

**Anti-bot measures.** Greenhouse's help article: reCAPTCHA is used "to help keep robots and spammers from easily applying." Candidates see either an invisible check (reCAPTCHA "analyzes activity on a job post, like mouse movements and typing patterns") with a brief "protected by reCAPTCHA" graphic, or are asked to submit a code from their email [D] (Greenhouse support article "Invisible reCAPTCHA", 115005448066). Admins set spam sensitivity per board under Configure > Job boards & posts > Boards settings; stricter settings "will add more friction" and may trigger email verification [D]. Our hosted-markup check found a reCAPTCHA Enterprise script (`recaptcha.net/recaptcha/enterprise.js`) with an invisible site key on the figma page [V]. Frequency of challenges: unknown. A practitioner reports an ambient reCAPTCHA v3 badge that did not block submit, and a v2 challenge on other runs [P].

**Confirmation signals.** `/confirmation` URL and "Thanks for applying!" text [P] (privacydied `greenhouse-ats-quirks` and `ats-apply-surface`; tapsubmit Greenhouse adapter, which checks for the `/confirmation` path). The official Job Board docs do not document success or error responses for the POST endpoint [D].

**Applicant-side submission API.** `POST https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}` with HTTP Basic auth, where "the Basic Auth username is your API key" and "Any form posts should be proxied by your own servers" [D] (developers doc at docs.greenhouse.io/job-board.html). Greenhouse says it "will not confirm the inclusion of required fields," so the client must validate. Required: `first_name`, `last_name`, `email`. The key is created by a Greenhouse admin with "Basic and above who manage job board related API credentials" permission, in Dev Center > API Credential Management > Job board [D] (support article 13446638483355). **Not usable by an applicant agent.** The key belongs to the employer's board.

**Share.** About 19-22% of companies in two datasets (see Market share) [T].

## Lever

**Form structure.** Single hosted apply page at `jobs.lever.co/{company}/{posting-id}/apply` [V]. Custom questions render as `cards[<uuid>][fieldN]` [V]. Link fields `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]` [V]. The Spotify page also has a "Demographic" block (gender, veteran, pronouns) and a `consent[marketing]` checkbox [V]. A location autocomplete keeps the real answer in a hidden `selectedLocation` field that populates only when a suggestion is chosen [P] (privacydied `ats-apply-surface`).

**Account or login.** No sign-in in the markup [V]. A LinkedIn prefill option exists (`linkedin-login-success` class) [V]. A practitioner's fill runs without an account [P].

**Anti-bot.** hCaptcha is loaded (`js.hcaptcha.com/1/secure-api.js`) with `hcaptcha.execute` wired to a hidden submit button (`hcaptchaSubmitBtn`), and a Cloudflare `challenge-platform` script is present [V]. The site key is public markup. A practitioner reports that clicking submit renders a visible hCaptcha challenge, which their policy treats as a halt [P]. Frequency unknown. We did not find a Lever help-center article on hCaptcha.

**Confirmation.** `/thanks` URL [P] (tapsubmit Lever adapter).

**Applicant-side submission API.** `POST https://api.lever.co/v0/postings/{site}/{posting-id}?key=APIKEY`. The key is generated by "a Super Admin of your account" from the integrations settings page [D] (github.com/lever/postings-api). Accepts JSON or multipart; resume only as multipart. Success returns `{ok:true, applicationId}`; errors return `{ok:false, error}`. Application-create requests are rate limited: more than 2 POSTs per second returns 429 [D]. Required: name and email. **Not usable by an applicant agent.** The key belongs to the employer's Lever account.

**Share.** About 15-17% of companies in two broad datasets, 3.4% in one top-employer set [T].

## Ashby

**Form structure.** Hosted application at `jobs.ashbyhq.com/{org}/{posting-id}/application` [V]. The page embeds `window.__appData` with posting metadata, the organization, and a reCAPTCHA universal public site key [V]. Form-field definitions are loaded by client-side code and were not extracted. Practitioner code expects fields under `.ashby-application-form-field-entry` and a system field `#_systemfield_name`, and reaches the form via an "Apply for this job" or "Application" tab [P] (tapsubmit Ashby adapter). Single vs multi-step not verified.

**Account or login.** No sign-in in the markup [V]. The tapsubmit adapter does not mark Ashby as login-gated [P].

**EEO / demographic blocks.** "disability" text appears in all 6 hosted pages, "veteran" in 4, and "gender" in 2 [V]. Official Ashby EEO behavior not checked.

**Anti-bot.** Hosted pages reference reCAPTCHA (universal site key, `recaptcha-badge`, `recaptcha/` script) [V]. Ashby's spam-protection doc: admins choose from four levels, "Strict" ("Only use this level as a last resort"), "Permissive (Recommended)", "Less Permissive" (where "Candidates might experience problems submitting their applications from time to time"), and "No Protection." The setting "lets you adjust the threshold at which Ashby rejects applications" [D] (docs.ashbyhq.com/job-board-application-spam-protection). The doc does not name the technology. A practitioner reports a fully valid form returning "Your application submission was flagged as possible spam," reproduced twice in 2026 [P] (privacydied `ats-apply-surface`). This is the main reported Ashby risk. Frequency unknown.

**Confirmation.** Success container `.ashby-application-form-success-container` [P] (tapsubmit). The API response shape (`success: true`, `submittedFormInstance`, `formMessages.blocked`) is documented for the employer-keyed endpoint [D].

**Applicant-side submission API.** `POST https://api.ashbyhq.com/applicationForm.submit`, BasicAuth, "Requires the candidatesWrite permission" [D] (developers.ashbyhq.com/reference/applicationformsubmit). Custom careers pages use `jobPosting.info` for the form spec and then `applicationForm.submit` [D] (developers.ashbyhq.com/docs/creating-a-custom-careers-page). File uploads use `file.createFileUploadHandle` with a presigned URL that expires after 10 minutes [D]. Public posting list is available without a key: `GET https://api.ashbyhq.com/posting-api/job-board/{name}` returned jobs for openai, ramp, and linear [V]. **Not usable by an applicant agent** for submission.

**Share.** 2-5% overall in the top-employer and recruiting datasets; about 22% of 124 tech employers in one dataset [T].

## Workday

**Form structure.** Multi-step wizard. A practitioner reports a 5-step flow ("My Information (step 1/5)", "My Experience (step 2/5)", and so on), with `data-automation-id` attributes as stable selectors [P] (privacydied `workday-create-account-flow`). A required "How Did You Hear About Us?" prompt is hierarchical (categories drilled into sub-options) [P].

**Public listing.** `POST https://{tenant}.wd5.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` returned postings without authentication (NVIDIA tenant; total 2000) [V]. This is a search endpoint, not an application endpoint.

**Account or login.** Required per employer. Examples: University of Wisconsin says outside applicants "must set up a Workday candidate home account when they submit their first application," reusable across that employer's external career sites [E] (kb.wisconsin.edu/workday/152462). Roche's careers site: "Workday Candidate Home Account" creation and an account email that must match the application [E] (careers.roche.com/global/en/candidate-account-creation). A practitioner: "Apply Manually" leads to a create-account form, not a forced sign-in, and creates a tenant-specific account (email, password) [P]. A refer.me guide says some portals require MFA or block password managers [T].

**Coming change.** Workday says its Candidate Profile sign-in (email plus one-time code, no password) is "expected to be generally available to Workday Recruiting customers in early calendar year 2027," and that applicants can apply "without creating a new account" [D] (newsroom.workday.com, 2026-10-13). Expectation, not commitment. This could change the account requirement during the Phase 0 build window.

**EEO / demographic blocks.** Not verified.

**File uploads.** The resume input is `input[data-automation-id="file-upload-input-ref"]` [P]. One practitioner's hidden input would not bind through their browser tool, and they logged the application as Blocked rather than submitting [P]. This is a driver-level finding, not a Workday-wide fact.

**Anti-bot measures.** No official Workday statement found. One practitioner saw no CAPTCHA iframes in a Workday apply flow and identified a "captcha" text match as a false positive [P]. The same practitioner documented a "silent Save and Continue" wall where the submit button did nothing and no validation error appeared [P] (privacydied `workday-silent-submit-wall`). Vendor claims that Workday applies anti-bot checks, rapid-submission detection, or CAPTCHA are unverified [T] (scale.jobs; JobWizard). Frequency: unknown.

**Confirmation signal.** Not verified. The practitioner reports above did not reach a confirmation page.

**Applicant-side submission API.** None public. Workday recruiting web services need an Integration System User (ISU) and security-group setup by the tenant admin [T] (Merge help; RippleMatch guide). The official Workday Recruiting web services reference was not retrieved. **Not usable by an applicant agent.**

**Share.** 29.4% of one top-employer set (235 employers), 75.4% of one 743-company set, and 15.9-17.5% in two broad datasets [T]. The sources disagree widely.

## iCIMS

**Form structure.** Multi-step, with a profile first. Official candidate guide: click "Apply for This Job Online"; a new applicant completes the profile section and selects "Submit Profile"; then "Update Profile"; then screening questions, EEO information, and job-specific questions; then submit [D] (community.icims.com, Candidate Guide to the iCIMS Talent Platform). Some steps offer "Finish Later." Steps vary by portal.

**Account or login.** A profile is required. New applicants create a login (name, email, password), sign in with Facebook, Google, LinkedIn, or Microsoft where the employer offers it, or upload a resume [D]. Accounts are employer-specific per the guide's instruction to log in with the credentials created for that company [D] (partial). Also [T]: a vendor guide claims cross-employer SSO works, which is unverified.

**Field types, EEO, uploads.** The official guide mentions required fields (asterisk), EEO information in a later step, and resume upload from computer, Google Drive, Dropbox, or OneDrive, which may be required. It does not list accepted file types [D]. Custom questions, conditional questions, and custom dropdowns are described in a vendor article [T] (scale.jobs).

**Anti-bot.** Only vendor claims: "iCIMS uses CAPTCHA challenges," tracking of IP and submission timestamps, and "strict session timeouts" [T] (scale.jobs, vendor-authored, promotes a human-assisted service). A tenant's static search page returned no CAPTCHA markers [V], but job pages are JavaScript-rendered and were not inspected. Frequency: unknown.

**Confirmation.** Confirmation page per the official guide [D]. Confirmation emails per a vendor FAQ [T].

**Applicant-side submission API.** The Talent Cloud API at developer.icims.com is partner-gated; a third-party directory says access is "gated behind the iCIMS Partner Program" and "credentials are issued per customer" [T]. An "Apply Framework API" is described in a third-party directory without verified endpoints [T]. An Indeed integration guide shows that a customer's iCIMS administrator supplies the Customer ID, API username, and password [T] (search snippet only). **Not usable by an applicant agent.**

**Share.** 2.2% of one top-employer set, 4.5% of a 337-company sample, and about 14-15% of companies in two broad datasets [T].

## Market share

The datasets conflict heavily. Use them as order of magnitude only, and note that they measure share of companies in each sample, not share of postings. No source we found measured postings share.

| Dataset (source) | Workday | Greenhouse | Lever | iCIMS | Ashby |
|---|---|---|---|---|---|
| ~800 top employers (resumegeni.com/research/ats-market-share-2026) [T] | 29.4% | 22.0% | 3.4% | 2.2% | 5.1% |
| 743 companies, large employers (resumegeni dataset) [T] | 75.4% | 16.7% | n/a | n/a | n/a |
| 12,000+ companies (Jobscan, as cited in search snippets) [T] | 15.9% | 19.3% | 16.6% | 15.3% | n/a |
| 13,000+ companies (Jobscan, as cited in search snippets) [T] | 17.5% | 19.0% | 15.6% | 14.4% | n/a |
| 124 tech employers (resumegeni) [T] | n/a | n/a | n/a | n/a | 21.8% |

The Jobscan figures came from search snippets, not from the page itself. The resumegeni "743" and "800" datasets conflict with each other on Workday.

## Ranking and rationale

Criteria, from the ticket and PRD sections 41, 44, and 75: (a) no account wall; (b) anti-bot that would not halt autonomous flows by default; (c) machine-readable form definition for fixtures and dry-run; (d) breadth of share; (e) observable confirmation.

1. **Greenhouse.** Wins on (a), (c), and (e). (b) is a score-based reCAPTCHA with email-code fallback, not a visible challenge in the normal case. Breadth is good (about 19-22% in two datasets). PRD section 75 asks for "at least one meaningful ATS family," and Greenhouse meets that.
2. **Ashby.** No account, reCAPTCHA plus an admin-set spam threshold, and a reported "flagged as spam" rejection on a valid form [P]. Form definitions are not public the way Greenhouse's are. Good in tech companies. Strong candidate for the second family, but the spam rejection must be understood before it is relied on.
3. **Lever.** No account, but hCaptcha on submit. Under a policy that halts on hCaptcha (PRD section 44 escalates unhandled CAPTCHAs), Lever would be escalation-heavy. Share is decent in broad datasets.
4. **Workday.** Highest share among large employers, but a per-employer account, multi-step wizard, a reported silent-submit wall [P], and a 2027 change to the sign-in model. Revisit once Workday Candidate Profile is generally available.
5. **iCIMS.** Profile required, multi-step, anti-bot unverified, partner-gated APIs. Lowest priority based on current evidence.

## Open risks

1. **No applicant-side submission API exists for any of the five families.** Every submission goes through a browser driver against the hosted form (PRD section 41). Using an employer's key to submit on their behalf would be use of a credential we do not hold; we recommend against it.
2. **Terms of service for automated applications were not researched.** Before autonomous submission ships on any family, each employer's platform terms and each ATS's terms need checking. This is a gap in this research.
3. **Anti-bot policy is a product decision.** PRD section 44 escalates "CAPTCHA that cannot be handled." Whether to attempt reCAPTCHA or hCaptcha solving is not decided here. Practitioner repos solve reCAPTCHA v2 under their own policy [P]; that is not a recommendation.
4. **Submit paths cannot be verified without real submissions.** The dry-run mode (fill, never submit) can exercise Greenhouse's public question schema against real postings. It cannot prove the submit step or spam acceptance (Ashby) on a live form. Adapter verification strategy (map "Not yet specified") must address this.
5. **Driver-level gaps are real.** Practitioner reports include EEO comboboxes that did not fill through a helper [P], react-select values that do not show in the input's `.value` [P], and a Workday hidden upload input that did not bind [P]. These are tool-specific, but they will recur in any driver.
6. **Market share disagrees across datasets.** Any volume plan that depends on a family's share needs its own sample, not these numbers.
7. **Workday's account model may change in early 2027** (expected, not committed) [D].
8. **Greenhouse's invisible reCAPTCHA is score-based.** Its behavior under high-volume or automated traffic is unknown, and we did not measure it.

## Facts downstream decisions depend on

- Greenhouse hosted forms are fillable without an account on sampled boards [V]. The question schema is publicly readable at `boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}?questions=true` [V].
- Greenhouse resume and cover-letter types: `pdf, doc, docx, txt, rtf` [D].
- Hosted forms carry these anti-bot scripts: Greenhouse reCAPTCHA Enterprise invisible [V]; Ashby reCAPTCHA universal key [V]; Lever hCaptcha on submit [V].
- None of the five families has an applicant-side submission API. The employer-keyed APIs are: Greenhouse Job Board POST, Lever postings POST (2 per second), Ashby `applicationForm.submit` (`candidatesWrite`) [D].
- Workday and iCIMS require a candidate account on the employer's tenant [E][D]. Workday's Candidate Profile is expected to drop the password requirement in early 2027 [D].
- Ashby's spam threshold is admin-set, and a reported rejection exists [D][P].

## Not verified

- No live submission was attempted, per the project constraint.
- Ashby form definitions were not extracted (client-side). Ashby single vs multi-step not confirmed.
- Lever's EEO optionality and Greenhouse's EEO optionality on hosted pages were not checked beyond markup.
- Workday application pages were not reached. The Workday anti-bot picture rests on one practitioner.
- iCIMS hosted job pages were not inspected.
- The `feder-cr/Jobs_Applier_AI_Agent_AIHawk` repository resolved to an unrelated project description during lookup, so it was not used.
- Jobscan percentages are from search snippets, not the source page.

## Sources

Official docs:
- Greenhouse Job Board API: https://docs.greenhouse.io/job-board.html (fetched; the older developers.greenhouse.io URL redirects here). Source file: https://github.com/grnhse/greenhouse-api-docs/blob/master/source/includes/job-board/_applications.md
- Greenhouse "Invisible reCAPTCHA": https://support.greenhouse.io/hc/en-us/articles/115005448066
- Greenhouse "Create a job board API key for an integration": https://support.greenhouse.io/hc/en-us/articles/13446638483355-Create-a-job-board-API-key-for-an-integration
- Greenhouse MyGreenhouse FAQ for candidates: https://support.greenhouse.io/hc/en-us/articles/43418495049499-MyGreenhouse-FAQ-for-Candidates
- Lever postings API README: https://github.com/lever/postings-api
- Ashby custom careers page: https://developers.ashbyhq.com/docs/creating-a-custom-careers-page
- Ashby `applicationForm.submit` reference: https://developers.ashbyhq.com/reference/applicationformsubmit
- Ashby job board application spam protection: https://docs.ashbyhq.com/job-board-application-spam-protection
- Workday newsroom, Candidate Profile (2026-10-13): https://newsroom.workday.com/2026-10-13-New-Workday-Candidate-Profile-Lets-Job-Seekers-Save-Their-Information-Once-and-Use-It-Every-Time-They-Apply-Through-Workday
- iCIMS community candidate guide: https://community.icims.com/articles/HowTo/Candidate-Guide-to-the-iCIMS-Talent-Platform

Employer help pages:
- University of Wisconsin Workday external candidate accounts: https://kb.wisconsin.edu/workday/152462
- Roche candidate account creation: https://careers.roche.com/global/en/candidate-account-creation

Live public endpoints and pages checked (2026-11-03, GET only):
- `https://boards-api.greenhouse.io/v1/boards/{stripe,airbnb,coinbase,cloudflare,databricks,figma,discord,dropbox}/jobs` and `/jobs/{id}?questions=true`
- `https://job-boards.greenhouse.io/figma/jobs/5426468004`
- `https://api.lever.co/v0/postings/{palantir,spotify}?mode=json`; `https://jobs.lever.co/palantir/{id}/apply`, `https://jobs.lever.co/spotify/{id}/apply`
- `https://api.ashbyhq.com/posting-api/job-board/{openai,ramp,linear}`; `https://jobs.ashbyhq.com/{openai,ramp,linear}/{id}/application`
- `https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs`
- `https://careers-rambus.icims.com/jobs/search?ss=1`

Practitioner and open-source (self-reported):
- privacydied/job-application-skill: `references/greenhouse-ats-quirks.md`, `references/ats-apply-surface.md`, `references/workday-create-account-flow.md`, `references/workday-silent-submit-wall.md`, `references/captcha-policy.md`. https://github.com/privacydied/job-application-skill
- isobed18/tapsubmit: `applyburst/adapters.py` (Greenhouse, Lever, Ashby adapters). https://github.com/isobed18/tapsubmit

Vendor-authored or third-party (unverified):
- Scale.jobs, iCIMS and Workday articles: https://scale.jobs/blog/icims-applications-break-most-automation-tools and https://scale.jobs/blog/cheap-ai-apply-tools-fail-workday-applications
- Merge help, Workday ISU: https://help.merge.dev/articles/8400765-creating-a-candidate-and-application-within-workday
- Market share: https://resumegeni.com/research/ats-market-share-2026
- Recruiting data (Pin, June 2026): https://www.pin.com/blog/ats-market-share-report (search snippet only)
