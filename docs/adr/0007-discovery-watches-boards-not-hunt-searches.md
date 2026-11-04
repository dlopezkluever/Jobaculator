# Discovery watches employer Boards, not Hunt searches

PRD §20 draws discovery as something each Hunt runs. But the Phase 0 Sources (the Greenhouse, Lever and Ashby public job-board APIs) have no search: one call returns every open posting for one employer. So discovery polls each Board a User watches, once per User and independently of Hunts, and every publicly listed posting it returns becomes an Opportunity. Hunts filter afterwards, at Match evaluation, starting with a cheap deterministic prefilter and spending on the LLM only after that. Coverage comes from growing the watched Board set (a global seed list, Boards the User adds, and Boards suggested for each Hunt and added automatically), not from query terms.

## Considered options

- **Per-Hunt polling (`discover(hunt, source)`):** fetches the same Board once per Hunt and still has to filter client-side, because the APIs cannot search.
- **Store only postings that pass some Hunt's prefilter:** fewer rows, but a new or re-targeted Hunt could not backfill over postings already seen, and the filtered-out postings would still need a separate "seen" index.

## Consequences

- Pausing a Hunt stops its evaluations and new Applications, not polling. A User's Boards stop being polled only when none of their Hunts is active.
- Opportunity volume grows with the number of watched Boards (tens of thousands of rows at a few hundred Boards), not with Hunt relevance. That is why there is a per-User watched-Board limit and why closed, never-applied Opportunities have their descriptions pruned.
- Deduplication uses exact identity only (source posting, then same-employer requisition, then canonical URL). It never uses fuzzy similarity.
