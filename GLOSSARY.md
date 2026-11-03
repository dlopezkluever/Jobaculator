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

**Opportunity**:
One real job posting, normalized and deduplicated across every source and Hunt that found it. It describes the posting only, never a Hunt's judgement of it.
_Avoid_: Job, posting, listing, lead

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

**Browser Run**:
One attempt by the agent at the employer's site on behalf of an Application. An Application may have several.
_Avoid_: Attempt, session, execution

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

**Candidate Fact**:
A single claim about the Candidate, carrying where it came from and how strongly it is supported.
_Avoid_: Profile field, memory, saved answer

**Authoritative Fact**:
A Candidate Fact only the Candidate may establish or change (legal name, work authorization, degrees, employment dates). The system may use it but never alter or embellish it.
_Avoid_: Locked fact, protected field

**Answer Policy**:
The Candidate's standing instruction for answering a whole class of application question, such as sponsorship or demographic disclosure.
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

**Review**:
The Candidate's approval of what the employer will actually receive, just before final submission. It happens only when a Hunt's Review rule explicitly asks for it. An Application is not stuck while it is in Review.
_Avoid_: Approval, Intervention
