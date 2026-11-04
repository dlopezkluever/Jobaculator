# Point-in-time backups and conservative disaster recovery

A restore that loses recent data is not just lost work here. Applications submitted after the recovery point would come back as READY or APPLYING, and the pipeline would submit them again. So even this single-user deployment backs up Postgres continuously (pgBackRest WAL archiving to an encrypted, S3-compatible offsite repository), backs up the immutable file store separately (restic, encrypted, every 10 minutes), and writes a small offsite **submit-intent journal** before every final submit. A restored system starts stopped and reconciles before any automation resumes. We rejected nightly `pg_dump` and relying only on provider VPS backups: both can lose up to a day, which turns a disk failure into duplicate applications to real employers.

## Recovery point limits

Archiving targets about a minute of data loss (`archive_timeout=60s`), but that is a target, not a guarantee. A broken or backlogged archive widens the window, and the file backup can trail the database by its 10-minute interval. A restore therefore checks every database reference against the restored files and reports any that are missing. A missing file is never treated as recovered.

## The submit-intent journal

- Before the #12 submit-boundary transaction, the worker writes one immutable, create-only record (`If-None-Match: *`) to a separate, bucket-locked offsite bucket. The record holds the intent id, Application, Opportunity and Browser Run ids, the stable posting identity and dedup key, the mode, and a timestamp. It holds no Candidate answers or documents. Only after that write succeeds does the transaction run, using the same intent id, and only after the transaction commits may the final click happen.
- A failed journal write stays before the boundary. It retries, and repeated failures raise a journal Hold that uses up no attempt. It never produces an Intervention or Uncertain Submission. An ambiguous write is retried with the same intent id and checked, never given a new one.
- A journal entry means "may have been clicked". When the journal's coverage is active and complete, the absence of an entry means "was not clicked". An entry left behind by a transaction that refused is acceptable and is treated conservatively.
- Coverage starts at a written activation record, and only once no submit-capable worker that predates the journal is still running.
- Normal operation never reads the journal. Only recovery does, apart from checking an ambiguous write.

## Recovery

- A recovery marker kept outside Postgres blocks dispatch and the final-submit boundary, whatever the restored database says. Blob garbage collection is off, and only an explicit recovery-complete command clears the marker.
- Every journal intent whose outcome the restored records do not establish reliably, including entries written before the recovery point, puts its Application into Uncertain Submission with an Intervention. Recovery rebuilds a missing Opportunity or Application from the journal's posting identity, so the one-Application-per-Opportunity rule blocks any second submission.
- Confirmed Submitted Applications, and attempts with durable evidence that they ended before the boundary or were resolved as not submitted, are kept as they are. A restored SUBMITTING Application with no journal record is an invariant violation and is quarantined.
- If journal coverage is incomplete or unreadable, every Application that could have crossed the boundary (APPLYING, SUBMITTING, or READY and eligible for live submission) becomes an Uncertain Submission. In that case an Application created and submitted entirely inside an unjournaled lost window cannot be detected, and the recovery report says so.

## Consequences

- Do not "simplify" the journal away, move its write after the boundary transaction, or let recovery trust the restored database alone. Each of these brings back duplicate submissions after a restore.
- Backup failures raise notices and operational urgency but do not pause submissions. Low disk is a separate, disk-scoped Hold.
- A restore drill is required before the first live submission, then quarterly and after backup configuration changes.
