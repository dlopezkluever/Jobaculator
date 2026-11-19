PROTOTYPE, throwaway, never merged. Answers wayfinder ticket #30 (Dashboard information architecture and resume visual templates).

## dashboard-ia/

Open `dashboard-ia/index.html` in a browser (no build, no dependencies, fake in-memory data).

- `?variant=A|B|C` or the bottom bar / ← → keys:
  - **A, Scoreboard + sidebar:** PRD §85 navigation; home leads with confirmed Submitted (today / week / all time) and in-flight counts, four attention tiles (Needs You, Ready for Review, Uncertain Submissions, Holds), a Hunt health table and recent submissions.
  - **B, Inbox-first + top bar:** home is one action list (Uncertain Submissions, then Needs You, then Review) with inline actions; throughput and Hunts in a narrow right column; Needs You and Review merge into "Inbox".
  - **C, Hunt lanes + Hunt rail:** Hunts are the navigation; home shows one pipeline lane per Hunt (discovered → qualified → queued → preparing → in browser → submitted) plus an event feed.
- `?scenario=steady|firstday|badday`: steady state; first day (Dry Run mode, contact-identity Hold, Getting started checklist); bad day (AI-provider Hold, site Hold, STALLED Hunt, two Uncertain Submissions).
- Shared inner screens (hash routes): `#/needs-you`, `#/review`, `#/hunts`, `#/hunt/ai`, `#/hunt-new`, `#/applications`, `#/app/a1` (tabs Why / Job Snapshot / Resume / Cover letter / Answers / Execution), `#/app/a1/review`, `#/candidate`, `#/settings`.

## resume-templates/

`./render.sh` (needs `typst` ≥ 0.14 and poppler-utils) renders `resume.json` (a `ResumeContent`-shaped sample) through three single-column templates into `out/` as tagged PDF/UA-1 plus PNG previews, and checks page count, tagging, size and text extraction.

- `a-classic.typ`: Libertinus Serif (embedded in Typst), centred name, ruled upper-case headings.
- `b-modern.typ`: IBM Plex Sans (vendored in `fonts/`, OFL), left-aligned, one accent colour, Skills before Experience.
- `c-compact.typ`: New Computer Modern (embedded), one-line role headers, tighter margins.
