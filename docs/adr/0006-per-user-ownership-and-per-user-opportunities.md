# Per-user ownership from the start, and per-user Opportunities

Phase 0 has one User, but Phase 1 adds invited users, and adding ownership to data that already exists is a painful migration. So from the first migration every user-owned record carries a non-null `user_id`: Candidate data, Hunts, Opportunities, Matches, Applications, Packages, Browser Runs, Interventions, credentials, and their child records. Module interfaces take the owner as an explicit argument, and composite foreign keys keep the main parent-child links consistent (an Application cannot point at another User's Opportunity, a Match cannot join another User's Hunt to another User's Opportunity). Opportunities are **per-user**, unique on `(user_id, dedup_key)`, rather than one shared row per public posting. That keeps one Application per Opportunity a simple per-User rule, keeps deduplication and the submit-intent journal's recovery (ADR 0005) inside one User's data, and means no User's Opportunity, Match or Application can be reached through someone else's. The trade-off: when several users find the same posting, its public data is stored more than once. That is acceptable for Phase 0 and early Phase 1.

## Considered options

- **Globally shared Opportunities, with only Matches and Applications per-user.** This stores less, but "one Application per Opportunity" becomes `(user, opportunity)` everywhere, recovery has to reason across users, and a shared row's lifecycle could be changed by activity from another User.
- **`user_id` only on root tables, with children inheriting through foreign keys.** This duplicates less, but every scoped query needs joins, and a later move to row-level security has nothing to filter on directly.

## Consequences

- Global by design, and never given an owner: the User identity table, content-addressed blobs (reached only through a user-owned domain reference), shared configuration (prices, routes, ATS adapters, discovery seed lists), and queue infrastructure. Holds have a nullable owner: per-user for keys and budget, global for an employer site, disk, and the journal.
- A future shared posting or discovery cache can sit *underneath* discovery without making Opportunities globally owned.
- Postgres row-level security is deliberately not built in Phase 0. The `user_id` column on every owned table is what lets Phase 1 add it.
