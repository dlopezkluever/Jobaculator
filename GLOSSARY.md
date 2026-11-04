# Jobaculator

An autonomous agent that discovers job postings for a person and submits individually tailored applications on their behalf.

## People

**User**:
The account that signs in and owns settings such as keys and spend caps. One User has exactly one Candidate.
_Avoid_: Account, customer

**Candidate**:
The person the system represents to employers, whose background it applies with.
_Avoid_: Applicant, profile, user

## Searching

**Hunt**:
A persistent, independently running search for one kind of role, with its own targeting, positioning, and submission policy.
_Avoid_: Search, campaign, job search

**Positioning**:
A Hunt's choice of what to emphasise, prioritise, or leave out when presenting the Candidate. It never holds Candidate Facts of its own, and it never changes a truthful answer to a required question.
_Avoid_: Profile variant, persona, angle

**Opportunity**:
One real job posting, normalized and deduplicated across every source and Hunt that found it. It describes the posting only, never a Hunt's judgement of it.
_Avoid_: Job, posting, listing, lead

**Employer**:
The organisation a posting is for, recognised by reliable evidence such as its own domain or its Boards, never by a similar name alone. A User can exclude an Employer outright.
_Avoid_: Company, organisation, hiring company

**Source**:
A kind of place job postings are discovered from, such as one ATS's public job boards, or a posting link the Candidate pastes in.
_Avoid_: Feed, provider, integration

**Board**:
One employer's list of open postings on one Source. Discovery watches Boards on the User's behalf, and every active Hunt judges what they list.
_Avoid_: Careers page, tenant, company

**Sighting**:
One place an Opportunity is listed: a specific post, with its own link and location. An Opportunity has one or more, and its Application goes through exactly one.
_Avoid_: Listing, post, duplicate

**Match**:
One Hunt's judgement of one Opportunity: whether it qualifies, how well it fits, and what the Hunt's policy decides to do about it.
_Avoid_: Evaluation, score, Hunt-Opportunity

## Applying

**Application**:
The single attempt to apply to one Opportunity, existing only once a Match has decided to apply. An Opportunity never has more than one.
_Avoid_: Submission, attempt

**Driving Hunt**:
The one Hunt, among those whose Matches want an Opportunity, whose positioning shapes its Application. Chosen by highest fit when the Application is created, and fixed after that.
_Avoid_: Owning Hunt, primary Hunt

**Application Package**:
Everything an Application sends to the employer (job snapshot, tailored resume, cover letter, answers, files). It can change until final submission and is frozen at that moment.
_Avoid_: Bundle, materials

**Job Snapshot**:
The posting as it read when its Application was prepared, kept unchanged with the Application even if the posting later changes or disappears.
_Avoid_: Cached posting, job copy

**Browser Run**:
One attempt by the agent at the employer's site on behalf of an Application. An Application may have several.
_Avoid_: Attempt, session, execution

**Dry Run**:
A Browser Run that fills in the whole application exactly as it would for real, then stops before final submission and keeps evidence of what would have been sent. It never submits, and an Application that has passed one is not run again until it is switched to live or a rerun is asked for.
_Avoid_: Test run, simulation, preview

**Submitted**:
An Application whose final submission the employer's site has confirmed. This is the success event that counts.
_Avoid_: Applied, sent, done

**Uncertain Submission**:
An Application where the final submit action may have gone through but no confirmation was seen. It is never retried automatically and does not count as Submitted until the Candidate confirms it.
_Avoid_: Failed submission, unknown

**Abandoned**:
An Application the Candidate chose not to pursue. It is never revived automatically, only by the Candidate.
_Avoid_: Cancelled, skipped, failed

**Expired**:
An Application that ended unsubmitted because its posting closed. It may be reconsidered if the posting reopens.
_Avoid_: Stale, closed

**Outcome**:
A known response from the employer to a Submitted Application, such as an interview. The absence of a response is not an Outcome and never implies rejection.
_Avoid_: Status, result

## Candidate knowledge and answers

**Candidate Knowledge Base**:
Everything the system knows about the Candidate: Entries, Candidate Facts, Answer Policies, and Base Resumes. It is the source of every Application, and nothing the system writes for an Application flows back into it as evidence.
_Avoid_: Profile, memory, resume

**Entry**:
One thing in the Candidate's history (a role, degree, project, story, or certification) that Candidate Facts are grouped under.
_Avoid_: Experience, item, section, record

**Candidate Fact**:
A single claim about the Candidate, carrying where it came from and how strongly it is supported. It comes only from the Candidate's own words or documents, or from an inference that cites them.
_Avoid_: Profile field, memory, saved answer

**Authoritative Fact**:
A Candidate Fact only the Candidate may establish or change (legal name, work authorization, degrees, employment dates). The Candidate's own uploaded documents count as establishing it. The system may use it but never alter, embellish, or choose between conflicting versions of it.
_Avoid_: Locked fact, protected field

**Commitment**:
A promise to an employer that only the Candidate may make, such as relocation, travel, start date, or compensation. It comes from the Driving Hunt, an Answer Policy, or an Authoritative Fact; a Hunt's Commitment can never break a Candidate-wide constraint, and the system never infers or alters one.
_Avoid_: Preference, availability

**Base Resume**:
A reusable resume the Candidate's Applications can start from, shared across Hunts. It is never required, and every Application still gets its own tailored resume.
_Avoid_: Resume family, resume template, master resume

**Answer Policy**:
The Candidate's standing instruction for answering a whole class of application question, such as sponsorship or demographic disclosure. It applies to the Candidate across all Hunts and can never contradict an Authoritative Fact.
_Avoid_: Locked Answer, canned answer, default answer

**Application Answer**:
The exact answer given to one question on one Application, kept unchanged as a record of what was sent.
_Avoid_: Response, generated answer

## Waiting on the Candidate

**Intervention**:
A request for the Candidate to unblock a stuck Application, for example a CAPTCHA, a missing Authoritative Fact, or a required assessment.
_Avoid_: Needs You item, error, blocker, escalation

**Needs You**:
The queue of open Interventions.
_Avoid_: Inbox, error log

**Hold**:
An automatic, temporary pause of only the work that depends on one shared thing that is failing or used up, such as an AI provider key, one employer's site, or a spending cap. It lifts by itself once the cause clears, and it is never an Intervention.
_Avoid_: Block, outage, global error

**Review**:
The Candidate's approval of what the employer will actually receive, just before final submission. It happens only when a Hunt's Review rule explicitly asks for it. An Application is not stuck while it is in Review.
_Avoid_: Approval, Intervention
