# Autonomous Job Search & Application Agent
## Product Requirements Document

**Document status:** Initial comprehensive product specification  
**Product stage:** Pre-development / requirements settled  
**Initial deployment target:** Single-user alpha  
**Initial user:** Product creator  
**Long-term target:** General-purpose consumer web application  
**Primary product objective:** Maximize qualified interview opportunities through persistent, autonomous, high-quality job discovery and application execution.

---

# 1. Executive Summary

This product is an autonomous AI-powered job-search and job-application system.

The product should allow a user to front-load their effort once by supplying extensive information about themselves, their work history, education, projects, skills, interests, preferences, and prior application materials. The system converts that information into a durable **Candidate Knowledge Base**.

The user can then create one or more independent **Job Hunts** representing different career directions.

For example, the same user may simultaneously run:

- Software Engineering Hunt
- AI Engineering Hunt
- Mechanical Engineering Hunt
- Video Production Hunt
- Policy / Technical Writing Hunt

Each Hunt has its own:

- desired roles;
- preferred locations;
- acceptable locations;
- excluded locations;
- compensation requirements;
- preferred compensation;
- industries;
- seniority;
- work arrangements;
- company characteristics;
- role keywords;
- exclusion rules;
- fit thresholds;
- autonomy settings;
- application-volume controls;
- AI creative-latitude settings;
- review requirements.

Once activated, a Hunt should operate continuously.

The system should:

1. Discover relevant job postings.
2. Normalize and deduplicate them.
3. Evaluate whether the user should apply.
4. Score the opportunity against the Hunt.
5. Generate a job-specific application strategy.
6. Generate a tailored resume.
7. Generate a tailored cover letter where useful or required.
8. Answer application questions.
9. Navigate the employer's application system.
10. Upload materials.
11. Submit applications autonomously where permitted.
12. Pause high-value applications for review when configured.
13. Escalate applications it cannot complete into a **Needs You** queue.
14. Record exactly what was submitted.
15. Track application outcomes.
16. Eventually learn which strategies actually produce interviews.

The ideal experience is not:

> "Use AI to help me apply for a job."

It is:

> "Tell the system what kinds of careers I am pursuing, give it everything it needs to understand me, turn the Hunts on, and let the system continuously pursue employment opportunities on my behalf."

The product should turn job hunting from an activity the user repeatedly performs into an autonomous process the user supervises.

---

# 2. Product Thesis

Modern job searching has become an adversarial optimization problem.

Candidates face:

- enormous numbers of postings;
- fragmented job boards;
- repetitive applications;
- Applicant Tracking Systems;
- keyword filtering;
- automated screening;
- highly specific job descriptions;
- redundant application questions;
- long application forms;
- employer-specific resume expectations;
- automated ranking;
- substantial time costs;
- poor response rates.

A candidate attempting to manually optimize every application faces an impossible tradeoff:

> **Quality versus volume.**

Generic mass application produces volume but poor relevance.

Hand-crafted applications produce quality but cannot achieve sufficient throughput.

AI makes it possible to collapse that tradeoff.

The product's central thesis is:

> **A sufficiently capable autonomous agent can simultaneously achieve high application throughput and high per-application customization.**

Instead of sending one generic resume to 200 employers, the system can potentially produce 200 different, role-specific application packages from one underlying Candidate Knowledge Base.

The product therefore competes on:

**Volume × Relevance × Autonomy × Persistence**

rather than on any one of those qualities individually.

---

# 3. Primary Product KPI

## 3.1 Long-term North Star

The ultimate KPI is:

**Qualified interviews generated per unit of user effort.**

Possible long-term metrics include:

```text
qualified_interviews / applications
qualified_interviews / week
qualified_interviews / user_hour
offers / applications
offers / hunt
```

However, interview outcomes take time and initially provide sparse data.

## 3.2 Initial Alpha KPI

The initial alpha should optimize primarily for:

**successful qualified application throughput.**

Key early metrics:

```text
Applications discovered
Applications evaluated
Applications attempted
Applications successfully submitted
Applications submitted per day
Applications requiring intervention
Application completion rate
Average autonomous completion time
Estimated cost per application
```

Initial optimization priority:

```text
1. Make the pipeline work.
2. Increase reliable throughput.
3. Improve customization quality.
4. Measure interviews.
5. Optimize toward interview probability.
```

The product must not mistake application count for the permanent North Star.

Raw throughput is an early operational KPI.

**Interviews are the actual outcome.**

---

# 4. Product Principles

## 4.1 Autonomy by Default

The default behavior should favor execution.

Users should not have to approve routine decisions continually.

The system should make progress while the user is:

- asleep;
- working;
- away from their computer;
- traveling;
- otherwise unavailable.

---

## 4.2 User Attention Is Scarce

Human attention should be reserved for:

- unusually valuable opportunities;
- questions the system cannot confidently resolve;
- legal or authoritative information;
- assessments requiring the candidate personally;
- technical failures that cannot be recovered automatically.

The product should minimize unnecessary interruptions.

---

## 4.3 High Volume Does Not Require Generic Applications

Every opportunity may receive its own:

- resume;
- summary;
- ordering of experience;
- selected accomplishments;
- keywords;
- cover letter;
- question responses;
- positioning strategy.

Application volume must not imply a shared generic package.

---

## 4.4 Candidate Knowledge Is More Important Than a Resume

A resume is an output artifact.

It is not the canonical representation of the candidate.

The canonical representation is the **Candidate Knowledge Base**.

---

## 4.5 Unknown Does Not Mean Disqualified

If a posting does not specify:

- salary;
- exact remote rules;
- team structure;
- seniority;
- travel;
- another optional criterion,

the system should generally not reject the opportunity automatically.

Default philosophy:

> **Unknown ≠ unacceptable.**

The system may research missing information where appropriate.

---

## 4.6 Persistent Hunts, Not One-Time Searches

A Hunt is an ongoing autonomous process.

It should continue discovering opportunities until:

- paused;
- completed;
- expired;
- archived;
- manually stopped.

---

## 4.7 Higher-Value Opportunities May Receive More Human Attention

Automation level and fit score are independent.

A user may intentionally choose:

```text
Mediocre-but-acceptable job
→ submit automatically

Dream job
→ prepare everything
→ let me review before submission
```

The system must support this inversion.

---

## 4.8 Aggressive Positioning, Controlled Authority

Users should be able to control how aggressively AI:

- rewrites;
- reframes;
- infers;
- emphasizes;
- interprets;
- maps transferable experience;
- adds relevant terminology;
- optimizes ATS language.

Certain authoritative facts remain separately controlled.

---

# 5. Core Product Objects

The product has four foundational objects:

```text
Candidate
    ↓
Hunts
    ↓
Opportunities
    ↓
Applications
```

Supporting objects include:

```text
Candidate Sources
Candidate Facts
Candidate Stories
Authoritative Answers
Application Packages
Browser Runs
Interventions
Application Outcomes
Generated Documents
```

---

# 6. Candidate

A **Candidate** represents the user and their underlying professional identity.

The Candidate is global across all Hunts.

A Candidate may simultaneously contain evidence relevant to very different careers.

Example:

```text
Candidate
├── Software Engineering
├── Mechanical Engineering
├── Energy Engineering
├── Video Production
├── Management
├── Teaching
├── AI / Automation
└── Policy / Technical Writing
```

The Candidate should not be forced into a single career identity.

---

# 7. Candidate Knowledge Base

## 7.1 Purpose

The Candidate Knowledge Base provides the application agent with far more information than any individual resume could contain.

It becomes the source material from which application-specific positioning is generated.

---

## 7.2 Candidate Source Types

Users should be able to upload or enter:

- resumes;
- CVs;
- past cover letters;
- portfolio documents;
- project writeups;
- transcripts;
- certifications;
- biographies;
- LinkedIn exports;
- GitHub information;
- personal notes;
- professional summaries;
- writing samples;
- references;
- career-history documents;
- project documentation;
- performance reviews;
- miscellaneous files;
- manually typed information.

Initial alpha does not need every connector.

Simple file upload plus conversational ingestion is sufficient.

---

# 8. Candidate Knowledge Categories

The system should extract and organize:

## Identity

- preferred name;
- legal name where needed;
- contact information;
- general location.

## Employment

For each role:

- employer;
- title;
- start/end dates;
- responsibilities;
- accomplishments;
- metrics;
- technologies;
- teams;
- leadership;
- scope;
- stakeholders;
- project examples;
- domain knowledge.

## Education

- institution;
- degree;
- field;
- dates;
- coursework;
- projects;
- academic achievements.

## Projects

- project name;
- problem;
- role;
- technologies;
- implementation;
- outcomes;
- scale;
- lessons;
- relevant skills.

## Skills

- technologies;
- tools;
- methodologies;
- soft skills;
- technical domains;
- domain expertise.

## Career Stories

Examples useful for behavioral questions:

- conflict;
- leadership;
- failure;
- success;
- ambiguity;
- teamwork;
- stakeholder management;
- deadline pressure;
- technical challenge;
- ownership;
- persuasion.

## Career Preferences

- target compensation;
- work arrangement;
- locations;
- industries;
- seniority;
- travel;
- company size;
- interests.

## Administrative Facts

- work authorization;
- sponsorship requirements;
- citizenship answers;
- clearance information;
- availability;
- relocation willingness;
- licenses;
- certifications;
- other frequently requested employment data.

---

# 9. Knowledge Provenance

Candidate knowledge should preserve provenance when doing so is inexpensive and automatic.

Example:

```text
CandidateFact

claim:
"Led seven engineering teams"

sources:
- interview_session_02
- treasury_notes.pdf

confidence:
HIGH

user_verified:
true
```

The user should not have to manage provenance manually.

The purpose is internal reliability, not bureaucracy.

Possible provenance states:

```text
USER_EXPLICIT
DOCUMENT_EXPLICIT
MULTI_SOURCE_SUPPORTED
AI_INFERRED
AI_INTERPRETED
```

Provenance enables the generation agent to distinguish:

- hard evidence;
- user statements;
- inference;
- interpretation.

---

# 10. AI Candidate Interview

## 10.1 Purpose

Uploaded documents will never contain everything needed for high-quality autonomous applications.

Therefore, onboarding should include an AI-led conversational interview.

---

## 10.2 Interview Style

The interview should feel conversational rather than like a 150-field HR form.

The agent should:

1. inspect uploaded materials;
2. identify important gaps;
3. ask high-value questions;
4. drill deeper into useful experiences;
5. extract behavioral stories;
6. clarify career goals;
7. collect administrative answers;
8. discover experiences not represented on resumes.

---

## 10.3 Interview Duration

Suggested ideal:

**approximately 15–30 minutes**

but it must remain optional.

---

## 10.4 Onboarding Requirement

Selected behavior:

**Strongly recommended but not mandatory.**

A user may launch a Hunt immediately.

Example:

```text
Candidate Profile: 54% enriched

You can start applying now.

A 15-minute interview would improve:
• leadership answers
• project examples
• salary questions
• work authorization answers
```

---

## 10.5 Continuous Interviewing

The interview system should not exist only during onboarding.

It may later ask:

> "Several applications are asking whether you've used Kubernetes in production. I know you've used Docker and deployed services, but I don't have enough detail about Kubernetes. Want to clarify?"

The Candidate Knowledge Base therefore improves over time.

---

# 11. Authoritative Facts

Some information requires explicit user authority.

Examples:

- legal name;
- citizenship;
- work authorization;
- sponsorship;
- security clearance;
- criminal-history responses;
- degrees;
- licenses;
- certifications;
- employment dates;
- employer names;
- relocation commitments;
- start-date commitments.

These should be modeled as **Authoritative Candidate Facts**.

AI may use these facts but should not silently modify them.

---

# 12. Creative Latitude

## 12.1 Purpose

Users differ dramatically in how literally they want AI to represent them.

The system should expose a **Creative Latitude** control.

This is configured globally and optionally overridden per Hunt.

---

## 12.2 Suggested Scale

### Level 1 — Literal

Use only explicitly documented language and facts.

AI may:

- reorganize;
- shorten;
- format;
- perform minimal rewriting.

---

### Level 2 — Conservative

AI may:

- paraphrase;
- reorder;
- emphasize;
- translate experience into job-relevant language;
- select appropriate keywords.

---

### Level 3 — Aggressive Positioning

AI may:

- strongly reinterpret experience;
- infer relevant soft skills;
- map transferable skills;
- use job-specific terminology;
- describe the candidate in the strongest defensible framing;
- connect related experience to stated requirements.

Example:

Candidate has repeatedly coordinated technical delivery across teams.

Posting requests:

> collaborative leadership

Resume may explicitly describe collaborative leadership even if that exact phrase never appeared previously.

---

### Level 4 — Maximum Persuasive Latitude

AI may:

- make broad professional inferences from available evidence;
- aggressively reframe adjacent experience;
- optimize wording heavily around stated job requirements;
- maximize alignment with screening terminology;
- synthesize strong persuasive narratives.

Hard authoritative facts remain separately locked.

---

## 12.3 UI

The control should not merely display a number.

It should explain behavior.

Example:

```text
Creative Latitude

○ Literal
○ Conservative
● Aggressive
○ Maximum Persuasive

Aggressive:
Strongly adapts your real experience to each position,
including inferred transferable skills and job-specific language.
```

---

# 13. Job Hunts

A **Job Hunt** is the primary operational unit.

A Candidate may have unlimited Hunts.

Example:

```text
Daniel

ACTIVE HUNTS

AI / Software Engineering
Mechanical Engineering
Video Production
Policy / Technical Writing
```

Each Hunt runs independently.

---

# 14. Hunt Targeting Model

Every targeting dimension should support four preference levels:

```text
IDEAL
GOOD
ACCEPTABLE
UNACCEPTABLE
```

Additionally, the interface should support:

> Anything Else = Unacceptable

where useful.

---

# 15. Example Hunt

```text
Hunt:
AI / Software Engineering

ROLE

Ideal:
AI Engineer
Applied AI Engineer
AI Product Engineer

Good:
Software Engineer
Full Stack Engineer
Solutions Engineer

Acceptable:
Technical Product Engineer
Developer Experience Engineer

Anything Else:
Unacceptable
```

---

## Location

```text
Ideal:
San Francisco

Good:
New York
Washington DC

Acceptable:
Anywhere in United States
Remote US

Unacceptable:
Specific excluded locations
```

---

## Compensation

```text
Ideal:
$200k–$300k

Good:
$160k–$200k

Acceptable:
$100k+

Unacceptable:
Below $100k
```

---

# 16. Targeting Dimensions

Initial dimensions should include:

- job title;
- function;
- seniority;
- compensation;
- location;
- remote/hybrid/onsite;
- company;
- industry;
- company size;
- employment type;
- travel;
- technologies;
- domain;
- experience expectations;
- security/clearance requirements;
- preferred keywords;
- excluded keywords.

Not every dimension must be shown during simple onboarding.

Advanced settings may expose additional dimensions.

---

# 17. Unknown Criteria

If a posting does not specify a criterion, behavior should be configurable.

Options:

```text
TREAT_AS_ACCEPTABLE
RESEARCH_AND_ESTIMATE
REQUIRE_KNOWN
SKIP_IF_UNKNOWN
```

Default:

**Treat unknown as acceptable.**

Where useful, the system should research missing data.

For example:

- compensation estimates;
- work location;
- company size;
- role seniority.

---

# 18. Opportunity

An **Opportunity** is a normalized job posting discovered by one or more Hunts.

Example:

```text
Opportunity

Company:
Anthropic

Role:
Software Engineer

Location:
San Francisco

Source:
Company careers

Canonical URL:
...

Discovered:
2026-11-02

Hunts:
AI Engineering
General Software
```

---

# 19. Opportunity Deduplication

Duplicate prevention should be global.

The same posting discovered through:

- LinkedIn;
- Indeed;
- company careers;
- Google;
- multiple Hunts,

must still represent a single Opportunity.

Possible deduplication inputs:

- company;
- normalized title;
- job ID;
- canonical URL;
- ATS ID;
- location;
- description fingerprint.

---

# 20. Persistent Job Discovery

A Hunt does not run once.

It continuously searches.

Conceptual pipeline:

```text
HUNT
 ↓
Discover Jobs
 ↓
Normalize
 ↓
Deduplicate
 ↓
Extract Metadata
 ↓
Evaluate Eligibility
 ↓
Score
 ↓
Choose Action
 ↓
Apply / Review / Skip
```

This loop runs continuously.

---

# 21. Job Sources

Long-term discovery may include:

- LinkedIn;
- Indeed;
- ZipRecruiter;
- Monster;
- company career sites;
- Greenhouse;
- Lever;
- Ashby;
- Workday;
- iCIMS;
- Taleo;
- search engines;
- industry job boards;
- government job boards;
- niche communities.

The product architecture should not depend on any single source.

---

# 22. Opportunity Evaluation

Three concepts must remain distinct:

## Qualification Threshold

> Should we apply at all?

## Fit Score

> How desirable is this opportunity?

## Submission Policy

> What is the system allowed to do?

These are independent.

---

# 23. Broad Qualification Philosophy

The system should avoid unnecessarily self-rejecting.

A posting stating:

> 5 years required

should not automatically block someone with:

- 4 years;
- strongly adjacent experience;
- equivalent expertise;
- unusual project depth.

The goal is to let employers reject candidates rather than having the candidate's own automation unnecessarily reject them first.

---

# 24. Fit Scoring

Each Opportunity receives a score.

Example:

```text
Overall Fit: 91 / 100

Role              100
Location           100
Compensation        90
Experience          85
Industry            80
Work Arrangement   100
Interest            95
```

Scoring should take into account:

- Ideal;
- Good;
- Acceptable;
- Unacceptable;
- missing/unknown values;
- inferred values;
- hard exclusions.

---

# 25. Fit Score Is Not Qualification

An opportunity might be:

```text
Fit = 58
Qualification = YES
```

because it is acceptable but not desirable.

Another might be:

```text
Fit = 95
Qualification = YES
```

because it closely matches the user's ideal criteria.

---

# 26. Submission Policy

Each Hunt can define policies by fit range.

Example:

```text
0–49
SKIP

50–74
AUTO APPLY

75–89
AUTO APPLY

90–100
REVIEW BEFORE SUBMIT
```

Another user may choose:

```text
50–100
AUTO APPLY
```

The product must not hardcode cautious treatment of high-fit jobs.

It should be user configurable.

---

# 27. Default Autonomy

Default mode:

**Autonomous.**

Meaning:

If:

- the Opportunity passes qualification;
- no authoritative answer is missing;
- no configured review rule applies;
- the browser automation succeeds,

the system should submit without waiting for user approval.

---

# 28. Review Mode

Users may enable Review Mode globally or selectively.

Review may be triggered by:

- fit score;
- company;
- salary;
- job title;
- location;
- specific Hunt;
- application question;
- confidence;
- generated material;
- other rule.

Example:

```text
IF fit_score >= 90
THEN review_before_submit
```

---

# 29. Application Package

Before submission, the system generates an **Application Package**.

Each package represents exactly what is being sent to one employer for one Opportunity.

---

# 30. Application Package Contents

```text
Application Package

Job Snapshot
Fit Analysis
Application Strategy
Tailored Resume
Cover Letter
Generated Question Answers
Uploaded Files
Browser Execution Record
Submission Confirmation
```

---

# 31. Job Snapshot

The system should preserve the job description as it existed when the application was generated.

This is essential because postings disappear or change.

Store:

- title;
- company;
- description;
- location;
- salary;
- requirements;
- URL;
- posting ID;
- discovery date;
- source.

---

# 32. Application Strategy

Before generating documents, the agent should identify:

```text
What does this employer appear to value?

Which candidate experiences are most relevant?

Which keywords matter?

Which accomplishments should be emphasized?

Which requirements need transferable-experience framing?

What should the resume lead with?

What should the cover letter emphasize?
```

This intermediate representation can guide consistent generation.

---

# 33. Resume Generation

Each application may receive a unique resume.

The resume generator may:

- choose relevant experiences;
- reorder bullets;
- rewrite bullets;
- alter summaries;
- emphasize specific skills;
- emphasize relevant projects;
- suppress irrelevant content;
- introduce appropriate terminology;
- optimize keyword alignment;
- change section ordering;
- alter emphasis based on Hunt.

The resume should remain visually professional and machine-readable.

---

# 34. Resume Variants

The Candidate may maintain base resume families.

Example:

```text
Software Base
Mechanical Base
Video Base
Policy Base
```

However, these are starting templates only.

The Application Package receives a bespoke generated version.

---

# 35. Cover Letters

Cover letters should be generated where:

- required;
- strongly beneficial;
- requested by user configuration.

The agent should avoid obviously generic output.

Potential inputs:

- company mission;
- role responsibilities;
- candidate experience;
- company products;
- candidate motivation;
- role fit.

---

# 36. Application Questions

Questions may include:

- years of experience;
- technology experience;
- motivation;
- behavioral prompts;
- compensation;
- work authorization;
- relocation;
- start date;
- sponsorship;
- portfolio links;
- security questions;
- demographic questions.

The system should classify questions before answering.

---

# 37. Question Classes

Possible classes:

```text
AUTHORITATIVE
FACTUAL
INFERABLE
PERSUASIVE
PREFERENCE
OPTIONAL_DISCLOSURE
ASSESSMENT
UNKNOWN
```

---

# 38. Reusable Answer Memory

When the Candidate answers something reusable, save it.

Example:

```text
Question:
Are you willing to relocate?

Answer:
Yes, for San Francisco, New York, or Washington DC.

Save to Candidate Knowledge?
YES
```

Future applications use this information automatically.

---

# 39. Missing Answers

Default behavior should favor progress.

For ordinary inferable questions:

1. infer from Candidate Knowledge;
2. use configured creative latitude;
3. research context where applicable;
4. answer automatically.

Escalation should occur when the system genuinely requires user authority.

---

# 40. Locked Answers

Some responses should use Candidate-controlled policies.

Examples:

```text
Sponsorship
"No sponsorship required"

Relocation
"Yes for Ideal/Good locations"

Veteran status
"Decline to self-identify"

Disability
"Decline to self-identify"
```

These answers can be configured once and reused.

---

# 41. Browser Execution

The application engine should use a hybrid strategy.

## Preferred Path

Known ATS-specific or DOM-aware automation.

Examples:

- Greenhouse;
- Lever;
- Ashby;
- Workday;
- iCIMS.

## Fallback Path

General computer-use/browser agent capable of operating arbitrary sites.

Conceptually:

```text
Application Agent
        ↓
ATS-specific driver available?
     ↙         ↘
   YES         NO
    ↓           ↓
Driver       General browser agent
    ↓           ↓
        Submit
```

---

# 42. Browser Technology

Likely implementation components include:

- Playwright;
- browser sessions;
- DOM inspection;
- screenshots;
- LLM reasoning;
- computer-use models;
- file uploads;
- session persistence.

The PRD does not mandate a specific model provider.

---

# 43. Browser Session Persistence

Where technically feasible, application state should persist so the user can continue from failures.

The system should capture:

- URL;
- current form/page;
- entered values;
- uploaded documents;
- error reason;
- screenshot;
- browser state where possible.

---

# 44. Retry Policy

Selected behavior:

**Retry predictable technical failures, escalate semantic/user-decision failures.**

Retry examples:

- page timeout;
- temporary network problem;
- upload failure;
- transient browser crash;
- stale selector;
- server error.

Escalate examples:

- CAPTCHA that cannot be handled;
- unknown authoritative answer;
- required assessment;
- application requires an action outside agent capability;
- ambiguous irreversible decision.

---

# 45. Needs You Queue

The **Needs You** queue is a first-class product feature.

It is not simply an error log.

Example:

```text
Needs You — 9

Ford
Mechanical Engineer
CAPTCHA encountered
[Continue]

Stripe
Solutions Engineer
Missing authoritative answer:
"When can you start?"
[Answer]

NBC
Video Producer
Application requires portfolio format not available
[Continue]
```

---

# 46. Needs You Resolution

User actions may include:

- continue application;
- answer question;
- upload document;
- skip;
- retry agent;
- mark not interested.

When a user supplies reusable information, the system should offer to add it to the Candidate Knowledge Base.

---

# 47. Assessment Handling

Applications requiring:

- coding assessments;
- personality tests;
- video interviews;
- timed examinations;
- personally completed evaluations,

should generally escalate.

These should appear clearly in Needs You.

---

# 48. Review Queue

High-value opportunities configured for review should appear separately from failures.

Example:

```text
Ready for Review — 4

OpenAI
AI Engineer
Fit: 97
Resume: Ready
Cover Letter: Ready
Questions: Complete
[Review & Submit]
```

---

# 49. Dashboard

The dashboard should answer immediately:

> What has my job-search machine been doing?

Suggested metrics:

```text
ACTIVE HUNTS                 4

TODAY
Jobs discovered            238
Qualified                    91
Applications attempted       72
Applications submitted       61
Needs You                     7
Ready for Review              4

TOTAL
Applications submitted      684
Interviews                    9
Offers                        1
```

---

# 50. Hunt Dashboard

Each Hunt should show:

```text
AI / Software Engineering

STATUS
Active

TODAY
71 discovered
27 qualified
18 submitted
3 review
2 blocked

ALL TIME
301 submitted
8 interviews
2 final rounds

APPLICATION RATE
19.4/day
```

---

# 51. Application History

Users should be able to browse all applications.

Filters:

- Hunt;
- company;
- title;
- fit;
- status;
- date;
- location;
- outcome.

---

# 52. Application Detail Page

Each Application should show:

```text
Company
Role
Fit Score
Hunt
Status
Date

JOB
Original posting

STRATEGY
Why the agent applied

RESUME
Exact submitted file

COVER LETTER
Exact submitted letter

QUESTIONS
Question → answer

EXECUTION
Application timeline

OUTCOME
Unknown / Rejected / Interview / Offer
```

---

# 53. Application Lifecycle

Suggested state machine:

```text
DISCOVERED
    ↓
EVALUATING
    ↓
QUALIFIED
    ↓
PREPARING
    ↓
READY
   ↙  ↘
REVIEW  APPLYING
   ↓       ↓
APPLYING  BLOCKED
   ↓       ↓
SUBMITTED ← RESUME
    ↓
OUTCOME_PENDING
   ↙   ↓   ↘
REJECTED INTERVIEW OFFER
```

Additional terminal states:

```text
SKIPPED
DUPLICATE
EXPIRED
USER_DECLINED
```

---

# 54. Outcome Tracking

Initial V1 behavior:

**Manual outcome updates.**

User may mark:

- interview;
- rejected;
- ghosted;
- assessment;
- offer;
- withdrawn.

---

# 55. Email Integration

Email integration should follow shortly after the first working application system.

This is a high-priority post-V1 capability.

The system should eventually detect:

- submission confirmations;
- rejection emails;
- recruiter outreach;
- interview invitations;
- assessments;
- scheduling messages.

This enables automatic funnel analytics.

---

# 56. Learning Loop

Once outcome information exists, the product can begin answering:

```text
Which resume style produces more interviews?

Which Hunts perform best?

Which titles convert?

Which locations respond?

Which creative-latitude level performs best?

Which industries respond?

Which application sources convert?

Which resume bullets correlate with interviews?
```

Long-term optimization should shift from:

```text
apply to many relevant jobs
```

toward:

```text
maximize interview probability
```

---

# 57. Cold Outreach

Cold outreach belongs in the long-term product vision but not initial V1.

Possible flow:

```text
Opportunity found
    ↓
Application submitted
    ↓
Identify recruiter / manager / leader
    ↓
Research recipient
    ↓
Generate outreach
    ↓
Auto send OR review
```

Potential targets:

- recruiter;
- hiring manager;
- department head;
- engineering manager;
- founder;
- HR leader.

---

# 58. Multi-Hunt Candidate Architecture

Candidate information is shared globally.

Hunt-specific positioning is not.

Example:

```text
Candidate Knowledge

Treasury Engineering Leadership
Mechanical Engineering Education
Video Production Leadership
AI Development
Teaching Experience
```

Software Hunt may prioritize:

```text
AI Development
Engineering Leadership
Software Delivery
```

Mechanical Hunt may prioritize:

```text
Mechanical Degree
Energy Engineering
CAD / Simulation
Engineering Projects
```

The Candidate remains one person while positioning differs.

---

# 59. User Journey: First-Time Setup

```text
Sign up
 ↓
Upload everything
 ↓
AI extracts Candidate Knowledge
 ↓
AI interviews user
 ↓
Candidate profile becomes usable
 ↓
Create first Hunt
 ↓
Configure targets
 ↓
Configure autonomy
 ↓
Activate
 ↓
System begins discovering/applying
```

---

# 60. User Journey: Daily Return

```text
Open dashboard

"Since your last visit"

47 applications submitted
5 applications need you
3 high-fit applications ready for review
2 interviews recorded

User:
→ handles Needs You
→ reviews dream jobs
→ checks results
→ leaves

System continues working
```

This is the core product experience.

---

# 61. User Journey: Expanding the Search

User receives few responses.

They create another Hunt:

```text
Software — Broad

Locations:
Anywhere US

Salary:
$100k+

Titles:
Software
AI
Solutions
Technical Product

Creative Latitude:
Maximum Persuasive

Review:
None

Volume:
Unlimited
```

Both Hunts run simultaneously.

---

# 62. User Journey: High-Value Opportunity

System finds:

```text
Company:
Desired employer

Fit:
97

Policy:
Review jobs ≥ 90
```

System:

1. generates complete package;
2. fills application;
3. stops before final submission;
4. notifies user;
5. user reviews;
6. user edits if desired;
7. user submits.

---

# 63. User Journey: Failed Automation

Agent reaches an unsupported application page.

It attempts recovery.

Recovery fails.

The system stores state and creates:

```text
Needs You

Job:
Mechanical Engineer

Reason:
Application requires external assessment.

[Continue Application]
```

User can decide whether the opportunity is worth finishing.

---

# 64. Application Cost Controls

Because the alpha uses BYO keys, users should be able to configure optional limits.

Potential settings:

```text
Maximum applications/day
Maximum AI spend/day
Maximum browser runs/day
Maximum concurrent agents
```

Default product philosophy should not impose arbitrary volume limits.

The user controls them.

---

# 65. BYO Keys

Initial product uses user-supplied API credentials.

Possible supported providers eventually:

- OpenAI;
- Anthropic;
- Google;
- browser/computer-use providers.

Alpha does not require payment infrastructure.

---

# 66. Billing

Out of scope for initial versions.

Do not build:

- Stripe billing;
- subscriptions;
- usage metering for invoices;
- plan tiers;
- checkout.

Internal usage telemetry may still be useful.

---

# 67. Initial Deployment Strategy

The first version should intentionally optimize for:

```text
1 user
1 VPS
1 persistent deployment
```

The user should be able to close their laptop without interrupting Hunts.

---

# 68. Initial Infrastructure

Suggested alpha topology:

```text
VPS

├── Web App
├── API
├── Background Worker
├── Job Discovery Worker
├── Application Worker
├── Browser Runtime
├── PostgreSQL
├── File/Object Storage
└── Scheduler / Queue
```

The exact decomposition may initially use fewer processes.

---

# 69. Core Architecture

Conceptually:

```text
                    ┌─────────────┐
                    │   Web App   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │     API     │
                    └──────┬──────┘
                           │
              ┌────────────▼────────────┐
              │      PostgreSQL         │
              └────────────┬────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
   Discovery Worker   Application Worker   AI Worker
          │                │                │
          └────────────────┼────────────────┘
                           │
                    Browser Runtime
```

---

# 70. Background Processing

The system needs persistent asynchronous jobs.

Examples:

```text
discover_jobs
normalize_job
score_opportunity
generate_application
launch_browser_application
retry_application
update_application_status
```

A durable queue should eventually manage execution.

---

# 71. Concurrency

The architecture should allow multiple applications to execute concurrently.

However, early alpha may intentionally cap concurrency.

Example:

```text
MAX_DISCOVERY_WORKERS=2
MAX_APPLICATION_WORKERS=3
MAX_BROWSER_SESSIONS=2
```

Limits should be configurable.

---

# 72. Secrets

The alpha will contain valuable secrets:

- LLM API keys;
- job-board credentials;
- candidate data;
- browser sessions.

Even during alpha:

- secrets must not be committed;
- secrets should be encrypted where practical;
- application logs should avoid leaking credentials;
- browser-session storage should be protected.

Full enterprise-grade security is not required for the single-user alpha.

---

# 73. Multi-User Evolution

Schema design should avoid assuming one global Candidate.

Major records should include ownership identifiers from the beginning.

Example:

```text
users
candidates
candidate_sources
candidate_facts
hunts
opportunities
applications
```

This prevents an unnecessarily painful migration later.

---

# 74. Alpha Scope

The alpha exists to answer one question:

> Can this system reliably find relevant jobs and autonomously submit genuinely customized applications while requiring little user attention?

It does not need to answer:

> Can this support 100,000 users?

---

# 75. Alpha Must-Haves

## Candidate

- upload resumes;
- upload cover letters;
- upload miscellaneous background files;
- extract Candidate Knowledge;
- conversational candidate interview;
- basic Candidate profile editing;
- authoritative facts.

## Hunts

- create multiple Hunts;
- configure titles;
- configure locations;
- configure compensation;
- Ideal / Good / Acceptable / Unacceptable;
- anything-else-is-unacceptable option;
- fit thresholds;
- autonomy policy;
- creative-latitude control;
- activate/pause Hunt.

## Discovery

- discover jobs from at least one useful source;
- normalize listings;
- deduplicate;
- score against Hunt.

## Generation

- customized resume;
- cover letter;
- application answers;
- preserve exact generated artifacts.

## Application

- autonomously complete at least one meaningful ATS family;
- browser fallback architecture;
- submit;
- detect success;
- record confirmation.

## Operations

- dashboard;
- submitted applications;
- Needs You;
- Ready for Review;
- application detail view.

---

# 76. First Vertical Tracer Bullet

The first true end-to-end implementation should prove:

```text
1. Candidate uploads background
2. Candidate creates one Hunt
3. System discovers one real job
4. System scores it
5. System generates a custom resume
6. System generates required answers
7. Browser opens employer application
8. Agent fills application
9. Agent uploads custom resume
10. Agent submits
11. Application is recorded
12. Dashboard shows SUBMITTED
```

The initial tracer bullet should deliberately avoid broad source coverage.

One complete loop is more valuable than ten half-built integrations.

---

# 77. Second Vertical Tracer Bullet

Prove human escalation:

```text
Agent starts application
 ↓
Agent encounters unknown/unsupported requirement
 ↓
Agent creates Needs You item
 ↓
User opens it
 ↓
User resolves problem
 ↓
Application continues
 ↓
Submission succeeds
```

---

# 78. Third Vertical Tracer Bullet

Prove high-value review:

```text
Opportunity fit = 96
 ↓
Policy says REVIEW
 ↓
System completes package
 ↓
Stops before submission
 ↓
User reviews
 ↓
User submits
```

---

# 79. Fourth Vertical Tracer Bullet

Prove parallel career Hunts:

```text
Software Hunt ACTIVE
Mechanical Hunt ACTIVE
Video Hunt ACTIVE

All three independently discover,
score and process jobs.
```

---

# 80. Functional Requirements

## FR-001 — Candidate Document Upload

System shall accept multiple candidate documents.

---

## FR-002 — Candidate Extraction

System shall extract structured professional information from uploaded materials.

---

## FR-003 — Candidate Interview

System shall conduct conversational interviews intended to enrich Candidate Knowledge.

---

## FR-004 — Knowledge Editing

User shall be able to review and modify Candidate Knowledge.

---

## FR-005 — Authoritative Facts

System shall support user-controlled authoritative answers.

---

## FR-006 — Multiple Hunts

Candidate shall support multiple simultaneous Hunts.

---

## FR-007 — Hunt Targeting

Each Hunt shall contain independent targeting criteria.

---

## FR-008 — Preference Tiers

Targeting criteria shall support:

```text
Ideal
Good
Acceptable
Unacceptable
```

---

## FR-009 — Catch-All Exclusion

Users shall be able to specify:

```text
Anything else = Unacceptable
```

where relevant.

---

## FR-010 — Creative Latitude

User shall configure AI positioning latitude.

---

## FR-011 — Persistent Hunts

Active Hunts shall continue operating without the user's computer remaining online.

---

## FR-012 — Opportunity Discovery

System shall discover relevant job opportunities.

---

## FR-013 — Opportunity Normalization

System shall normalize postings into a common schema.

---

## FR-014 — Global Deduplication

System shall prevent duplicate applications to the same canonical Opportunity.

---

## FR-015 — Qualification

System shall determine whether an Opportunity qualifies for application.

---

## FR-016 — Fit Score

System shall calculate an explainable fit score.

---

## FR-017 — Submission Policy

System shall determine Skip / Auto Apply / Review using Hunt policy.

---

## FR-018 — Resume Customization

System shall generate a role-specific resume.

---

## FR-019 — Cover Letter Generation

System shall generate a role-specific cover letter where applicable.

---

## FR-020 — Application Questions

System shall answer application questions using Candidate Knowledge.

---

## FR-021 — Browser Execution

System shall navigate application websites.

---

## FR-022 — File Upload

System shall upload generated application materials.

---

## FR-023 — Autonomous Submission

System shall submit eligible applications without user interaction.

---

## FR-024 — Submission Confirmation

System shall detect and record successful submission.

---

## FR-025 — Application Package Retention

System shall retain the exact artifacts submitted.

---

## FR-026 — Retry

System shall retry recoverable technical failures.

---

## FR-027 — Needs You

System shall escalate unresolved applications.

---

## FR-028 — High-Value Review

System shall support policy-triggered user review.

---

## FR-029 — Dashboard

System shall display Hunt and application activity.

---

## FR-030 — Outcomes

System shall allow manual application outcome tracking.

---

# 81. Non-Functional Requirements

## Reliability

Background execution must survive:

- browser closure;
- user disconnection;
- laptop shutdown.

---

## Persistence

No submitted Application Package may disappear after restart.

---

## Observability

Each application attempt should produce enough logs/status information to explain:

- what happened;
- where it failed;
- whether it submitted.

---

## Recoverability

Temporary worker crashes should not cause permanent application loss.

---

## Explainability

The system should be able to explain:

- why an Opportunity qualified;
- why it scored as it did;
- why an application was skipped;
- why user intervention is needed.

---

## Performance

Early optimization favors reliability over raw speed.

However, architecture should permit parallel execution.

---

# 82. Recommended Data Model

Conceptual entities:

```text
User

Candidate
CandidateSource
CandidateFact
CandidateStory
AuthoritativeFact

Hunt
HuntCriterion
HuntPolicy

Opportunity
OpportunitySource
OpportunitySnapshot
OpportunityScore

Application
ApplicationPackage
GeneratedResume
GeneratedCoverLetter
ApplicationAnswer

BrowserRun
BrowserEvent
Intervention

ApplicationOutcome
```

---

# 83. Suggested Relationship Model

```text
User
 └── Candidate
      ├── CandidateSources
      ├── CandidateFacts
      ├── CandidateStories
      ├── AuthoritativeFacts
      └── Hunts
            ├── HuntCriteria
            └── Opportunities
                  └── Applications
                        ├── ApplicationPackage
                        ├── BrowserRuns
                        ├── Interventions
                        └── Outcome
```

---

# 84. Opportunity-to-Hunt Relationship

An Opportunity may match multiple Hunts.

Therefore:

```text
Opportunity
 ↔ Hunt
```

should likely be many-to-many.

The Application should record which Hunt ultimately drove the application.

---

# 85. Product Navigation

Suggested primary navigation:

```text
Dashboard
Hunts
Applications
Needs You
Candidate
Settings
```

---

# 86. Dashboard UX

Dashboard should emphasize activity rather than configuration.

Primary elements:

```text
Applications submitted today
Applications submitted this week
Active Hunts
Applications needing attention
High-fit applications awaiting review
Recent submissions
Outcome funnel
```

---

# 87. Candidate UX

Candidate area:

```text
Profile
Experience
Projects
Skills
Stories
Documents
Administrative Answers
Interview
```

Users should be able to add new information without recreating their profile.

---

# 88. Hunt Creation UX

Creation should initially feel conversational/simple.

Example:

```text
What kinds of jobs are you looking for?

"AI engineering and software roles."

Where?

"San Francisco ideally, NYC and DC are good,
but anywhere in the US is acceptable."

Minimum salary?

"$100k."

Ideal salary?

"$200k+."
```

The application can translate this into structured Hunt criteria.

Advanced users may edit the structure directly.

---

# 89. Hunt Control UX

Each Hunt has prominent controls:

```text
ACTIVE / PAUSED

Autonomy:
Autonomous

Creative Latitude:
Aggressive

Application Policy:
<60 skip
60–89 auto
90+ review

Daily Limit:
Unlimited
```

---

# 90. Notifications

Initial alpha notifications may remain in-app.

Later:

- email;
- push;
- SMS.

Important events:

```text
Needs You
High-fit application ready
Interview detected
Hunt stalled
Provider credentials expired
```

---

# 91. Search Strategy

The system should prioritize newly posted positions where possible.

Potential priority model:

```text
Opportunity Value =
Fit
× freshness
× estimated competitiveness
× candidate relevance
```

Freshness can matter because earlier applicants may receive more attention.

---

# 92. Queue Prioritization

Qualified jobs should normally be processed highest-value first.

Example:

```text
Priority 1:
high fit + recently posted

Priority 2:
high fit + older

Priority 3:
acceptable + recent

Priority 4:
acceptable + older
```

The system continues until the qualifying queue is drained.

---

# 93. Volume Philosophy

No arbitrary product-level daily application cap is required.

The user may configure:

- max applications;
- max cost;
- max concurrency.

Default:

**continue processing qualified Opportunities.**

---

# 94. User Trust Model

The product must make autonomous activity inspectable.

Users should always be able to answer:

```text
Where did this job come from?

Why did the system apply?

What resume did it send?

What answers did it give?

When was it submitted?

Did submission succeed?
```

Autonomy without inspectability will undermine trust.

---

# 95. Application Evidence

Where practical, successful submissions should retain:

- confirmation text;
- confirmation URL;
- timestamp;
- screenshot;
- application ID.

This provides a strong audit trail.

---

# 96. Failure Categories

Suggested categories:

```text
NETWORK
SITE_CHANGED
AUTH_REQUIRED
CAPTCHA
UNKNOWN_QUESTION
AUTHORITATIVE_FACT_REQUIRED
ASSESSMENT_REQUIRED
UPLOAD_FAILURE
BROWSER_FAILURE
UNSUPPORTED_FLOW
JOB_EXPIRED
DUPLICATE_APPLICATION
UNKNOWN
```

---

# 97. System Health

Hunts should display operational health.

Example:

```text
AI Engineering

ACTIVE
Last discovery: 4 min ago
Last application: 11 min ago
Queue: 37
Blocked: 3
```

This prevents silent failure.

---

# 98. Phase 0 — Personal Alpha

Goal:

**Make it work extremely well for one user.**

Includes:

- VPS deployment;
- one Candidate;
- document ingestion;
- candidate interview;
- multiple Hunts;
- persistent discovery;
- scoring;
- customized resume;
- application automation;
- Needs You;
- review queue;
- dashboard;
- manual outcomes.

---

# 99. Phase 1 — Private Multi-User Beta

Target:

approximately 10–20 invited users.

Add:

- proper multi-user authentication;
- stronger secret isolation;
- worker isolation;
- per-user browser state;
- concurrency management;
- improved security;
- reliability monitoring;
- more ATS support;
- better Candidate editing.

---

# 100. Phase 1.5 — Outcome Intelligence

High priority shortly after core application automation.

Add:

- Gmail/email integration;
- automatic confirmation detection;
- rejection detection;
- recruiter-response detection;
- interview detection;
- outcome analytics.

This begins enabling true optimization around the North Star KPI.

---

# 101. Phase 2 — Application Intelligence

Add:

- interview-conversion analytics;
- resume strategy comparison;
- campaign experimentation;
- ranking optimization;
- source-quality measurement;
- adaptive fit thresholds;
- outcome-driven job prioritization.

---

# 102. Phase 3 — Outreach Agent

Add:

- recruiter discovery;
- hiring-manager discovery;
- contact research;
- cold email generation;
- outreach policies;
- review/auto-send controls;
- outreach tracking.

---

# 103. Phase 4 — Scalable SaaS

Only after product effectiveness is proven:

- scalable worker pools;
- managed browser infrastructure;
- billing;
- subscriptions;
- provider abstractions;
- distributed queues;
- formal privacy controls;
- abuse prevention;
- enterprise observability.

---

# 104. Explicit Initial Non-Goals

Initial alpha should NOT prioritize:

- billing;
- subscriptions;
- large-scale infrastructure;
- native mobile application;
- enterprise teams;
- recruiter-side functionality;
- interview coaching;
- offer negotiation;
- networking CRM;
- elaborate social features;
- dozens of job-source integrations;
- perfect analytics;
- perfect security hardening for thousands of users.

These may come later.

---

# 105. Product Risks

## Browser Fragility

Application sites change frequently.

**Response:** hybrid deterministic drivers + general browser agent.

---

## CAPTCHAs

Some applications may resist automation.

**Response:** escalate via Needs You.

---

## ATS Diversity

Thousands of application flows exist.

**Response:** support common ATS families first, then fallback general agent.

---

## Candidate Knowledge Gaps

Documents frequently omit useful information.

**Response:** conversational interview + ongoing enrichment.

---

## Excessive User Interruptions

Too many escalations destroy autonomy.

**Response:** reuse answers, infer aggressively where appropriate, retry technical failures.

---

## Duplicate Applications

Multiple sources/Hunts may discover the same job.

**Response:** global Opportunity identity and deduplication.

---

## Weak Application Quality

High volume can become meaningless if customization is superficial.

**Response:** Application Strategy + bespoke resume + job-specific questions.

---

## Cost

Computer-use agents may be expensive.

**Response:** deterministic ATS flows where possible, BYO keys, optional budgets.

---

# 106. Product Success Definition for Alpha

The personal alpha can be considered successful when the user can:

1. upload their professional history;
2. enrich it through an AI interview;
3. create multiple Hunts;
4. activate those Hunts;
5. leave the application running unattended;
6. return later;
7. see real jobs discovered;
8. see genuinely customized applications submitted;
9. review high-value applications when configured;
10. resolve stuck applications through Needs You;
11. see exactly what each employer received;
12. repeat this continuously without manually searching and applying to every job.

The strongest alpha demonstration would be:

> Start several Hunts, close the laptop, come back the next morning, and discover that dozens of real, targeted, individually customized applications have been completed successfully.

---

# 107. Long-Term Product Vision

The mature system should behave less like a resume tool and more like a persistent employment agent.

A user should be able to say:

> I want senior AI engineering jobs. San Francisco is ideal. New York and DC are good. Anywhere else in the U.S. is acceptable. I want at least $120k, ideally over $200k. Apply broadly. Use aggressive positioning. Don't bother me unless you need authoritative information or the job is an exceptional fit.

The system should then independently:

```text
search
research
rank
decide
position
write
apply
recover
track
learn
```

continuously.

Eventually, it should also:

```text
identify hiring managers
perform outreach
monitor replies
detect interviews
measure conversion
adapt strategy
```

The user's role shifts from:

> job applicant

to:

> supervisor of an autonomous job-acquisition system.

---

# 108. Product Promise

The core promise is:

> **Give us everything you know about yourself, tell us what kinds of jobs you would consider, and let the system relentlessly pursue those opportunities for you.**

It should combine the scale of mass application with the customization of a carefully prepared individual application.

The user should not have to choose between:

**applying broadly**

and

**applying well.**

The product exists to do both.