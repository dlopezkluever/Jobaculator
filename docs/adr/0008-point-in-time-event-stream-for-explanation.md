# Explanations come from a point-in-time event stream, not reconstruction

"Why did this qualify, score, skip, escalate, or submit?" is answered from an append-only, Zod-typed event stream whose records are written when the decision is made. Each event carries `user_id`, its actual subject (Match, Application, Hunt, Board, Intervention and so on), an event code, a timestamp and a minimal typed payload of reason codes and input ids. Skipped Matches never create Applications (ADR 0001), so decisions are recorded against the subject that made them, never against a phantom Application, and there is no second decision-history subsystem. The owning module writes the event in the same transaction as the state change it describes. Events hold ids and codes only, never content, prompts or free-text LLM rationale (an LLM summary may be generated for display, but it is never the record).

Reconstruction was rejected because the inputs move: postings are edited or closed, Hunts retargeted, Candidate Facts corrected and thresholds changed, so re-running the logic later explains a different decision than the one taken. Deriving timelines from state rows alone was rejected for the same reason, since it loses transitions such as a Hold that lifted or a SUBMIT_UNKNOWN that was reconciled.

## Consequences

- Events are small and kept permanently, alongside the Packages and evidence retained under ADR 0005. Run-level diagnostics (step logs, traces) are separate and expire after 14 days.
- Transactional events cover state changes the database accepts. Error reporting is best effort: a database outage, crash or failed transaction may leave only a redacted log line, and logging must never block recovery or add pipeline failures.
- Event payload schemas are a contract: a new kind is added with its Zod schema, and old kinds stay readable.
