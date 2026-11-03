# Pipeline progress lives in domain rows, and the submit boundary is an app-level guard

No queue or workflow engine gives exactly-once side effects, and pg-boss re-delivers jobs after a crash or expiry. So an Application's progress lives in its own Postgres row, and pg-boss jobs are only disposable nudges ("advance this record from state X"). Every handler re-reads the state, so a duplicate job does nothing. Final submission is guarded in the app itself: one transaction does a compare-and-set APPLYING → SUBMITTING for the run that owns the Application, checks Stop and the daily caps, freezes the Package, and writes a submit-intent row. From that point, anything other than seen confirmation leads to Uncertain Submission, which is never retried automatically. We rejected keeping progress in a durable-workflow engine (DBOS, Temporal) or in pg-boss `flow()`. Neither removes the need for this guard, and pg-boss's 24 h expiry cap and 14-day retention cannot hold multi-day waits.

## Consequences

- Do not "simplify" by giving the Browser Run job automatic engine retries, or by letting any path retry from SUBMITTING or SUBMIT_UNKNOWN. A new submission becomes possible only after the Candidate states explicitly that the earlier one did not go through.
- A sweeper repairs stranded records. A Browser Run is reclaimed only when its owner has ended explicitly or its heartbeat ownership has expired, never just because a newer worker started.
- Expensive stages (preparation, Browser Runs) are pulled by a dispatcher, which picks by priority at dispatch time from records waiting in the database. Cheap stages are pushed.
