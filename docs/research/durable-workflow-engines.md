# Durable workflow engine for a Postgres-backed TypeScript VPS

- Ticket: [#5](https://github.com/dlopezkluever/Jobaculation/issues/5) (map: #1)
- As of: 2026-11-03. Versions and licences were read from GitHub, npm and the official docs on that date.
- Scope: planning only. No product code. Final decision is made later with the user.
- Source key `[Sn]` is listed at the end. Claims without a source are marked "not verified".

## Short answer

**Recommendation: pg-boss (MIT, 12.38.0) as the durable queue and scheduler, with the product's own Postgres tables as the source of truth for application state, waits, Needs You and submission.** No general workflow engine is needed in Phase 0.

Why:
- pg-boss runs on Postgres alone. It adds no service to the single 4 GB VPS. [S1][S5]
- It covers the queue features the PRD needs: retries with exponential backoff, cron, per-queue concurrency that can also be capped across nodes, and job dependencies. [S1][S3]
- It has no pause or wait-for-event primitive. Human waits are therefore modelled as explicit states in the app's tables, which the PRD already requires (Needs You is a first-class product queue, PRD §45). That avoids a second copy of the waiting state. [S2][S4][S49]

**Runner-up: DBOS Transact (MIT core).** It gives step checkpointing and durable `sleep`/`recv` on Postgres alone. Two caveats: (1) a multi-day wait held in memory is fine, but parking it out of memory (suspend mode) is a proprietary enterprise feature; (2) it moves workflow state into DBOS's system tables. [S14][S15][S16]

**Rule that applies to every option: nothing here gives exactly-once external side effects.** All engines re-run work after a crash or timeout. The "submit application" step needs an application-level guard (intent row, idempotency key, and no automatic re-run of an unknown-outcome submit). Details in the section "Submit-once design". [S2][S15][S4]

## Hard requirements checked

| Requirement (source) | Result |
|---|---|
| ≤ $20/month, single ~4 GB VPS with Postgres (map #1 Notes) | Trigger.dev self-host is ruled out by its own minimums (webapp 3 vCPU / 6 GB, worker 4 vCPU / 8 GB, plus Redis, ClickHouse, object storage). [S26] |
| Pause for days on a human, then resume (ticket, PRD §28, §45) | Native in Temporal, Inngest, Trigger.dev and DBOS (`sleep`, `recv`/`send`). pg-boss and Graphile Worker have no wait primitive; the app state machine does it. [S15][S23][S29][S42] |
| Submit must never happen twice (ticket) | Not provided by any engine. Every engine here is at-least-once. [S2][S15][S17][S39] |
| Retry classification (PRD §44) | Temporal and DBOS have it natively. Inngest exports `NonRetriableError`. Trigger.dev has `AbortTaskRunError`. pg-boss and Graphile retry every throw; classification is app code. [S17][S25][S30][S39] |
| Recurring discovery per Hunt (ticket #5; PRD §20 persistent discovery) | Native in all candidates except Hatchet and Restate (not checked). [S1][S12][S15][S36][S42] |
| Per-queue concurrency (PRD §71) | pg-boss: per-node and cross-node group limits. DBOS: queue `concurrency`, `workerConcurrency`, rate limits. Graphile: serial named queues only. Temporal: per-worker SDK limits. [S1][S12][S18][S40] |
| TypeScript, AI-agent friendly | Each candidate is TypeScript-first. Temporal has the strictest authoring rules (determinism). [S38] |

## Comparison

| Engine | Latest (2026-11-03) | Licence | Extra services on the VPS | Multi-day human wait | Retry classification | Dedupe / idempotency | Verdict |
|---|---|---|---|---|---|---|---|
| **pg-boss** | 12.38.0 (2026-10-13) [S6] | MIT [S6] | None (Postgres) [S5] | Not native. Model as app state + re-enqueue. [S2][S4] | Not native; app code [S1] | `singletonKey`, `key_strict_fifo`, `upsert` [S1][S3] | **Recommended** |
| **Graphile Worker** | 0.18.0 (2026-09-08) [S13] | MIT [S13] | None (Postgres 12+, Node 22.18+) [S11] | Not native. [S7] | Not native; throw → retry [S7] | `job_key` with replace / preserve_run_at / unsafe_dedupe [S8] | Viable alternative. Fewer concurrency options; no group limits. |
| **DBOS Transact** (TS) | sdk 5.4.0 (2026-10-28) [S14] | MIT core; enterprise package proprietary [S19][S16] | None (Postgres system DB) [S14] | Native `sleep`, `recv`, `send`, `setEvent`. Parking out of memory needs suspend mode (enterprise). [S15][S16] | Native per-step `retriesAllowed`, `maxAttempts`, `backoffRate`, predicate [S17] | Workflow ID reuse policy (default `return-existing`); queue `deduplicationID`; `send` idempotency key [S15] | **Runner-up** |
| **Inngest** (self-host) | v1.49.0 (2026-10-23) [S20] | SSPL v1 with delayed Apache-2.0 grant [S20][S21] | Go server; SQLite default, Postgres optional, Redis optional [S22] | Native `waitForEvent` (`timeout` e.g. "7d"); process not kept running [S23] | `NonRetriableError` [S25] | Event idempotency; step memoisation [not verified] | Viable, but a separate service and licence to review |
| **Trigger.dev** (self-host) | v4.8.3 (2026-10-30) [S28] | Apache-2.0 [S28] | Webapp + worker + Postgres + Redis + ClickHouse (recommended) + object storage + registry + s2-lite + socket proxy [S26][S27] | `wait.forToken` (timeout optional) [S29] | `AbortTaskRunError`; `catchError` `skipRetrying` [S30] | Not checked | **Ruled out** (hardware minimums) |
| **Temporal** (self-host) | server v1.32.2 (2026-11-02) [S32]; TS SDK 1.25.0 (2026-10-27) [S43] | MIT [S32][S43] | Temporal server (4 services in one process by default) + Postgres (or MySQL/SQLite/Cassandra) [S33][S35][S36] | Native durable timers, `condition(fn, timeout)`, signals [S42] | Native `nonRetryableErrorTypes`, `maximumAttempts`, backoff [S39] | Workflow ID conflict policy [S41] | Strong, but heavier and stricter for agents. Not chosen for Phase 0. |
| **Hatchet** (self-host) | v0.114.2 (2026-10-26) [S44] | MIT [S44] | Postgres 15.6 + engine + dashboard + migrations; RabbitMQ optional; Postgres-only queue option [S45] | Durable sleep and event waits stated in docs; limits not checked [S46] | Not checked | Not checked | Possible. Not evaluated in depth. |
| **Restate** | v1.8.1 (2026-10-21) [S47] | BSL 1.1 (Change Licence Apache-2.0 after 4 years; no public hosted-platform use) [S47] | Single binary, embedded RocksDB, no Postgres [S48] | Not checked | Not checked | Not checked | Possible. BSL and unclear fit. Not evaluated in depth. |

## Per-engine notes

### pg-boss

- Runs on stock Postgres, MIT, Node ≥ 22.12. [S1][S5][S6]
- Retries: `retryLimit` (default 2), `retryDelay`, `retryBackoff` (exponential with jitter), `retryDelayMax`. [S1]
- Dedupe: `singletonKey` with queue policies `short`, `singleton`, `stately`, `exclusive`, `key_strict_fifo`. [S1]
- Delivery: "Jobs are delivered at least once. If a worker crashes, or a job runs past its expiration, the job is retried." [S2]
- Expiry: `expireInSeconds` defaults to 900 and may not exceed 24 hours. An active job cannot be held for days. [S1][S4]
- Retention: a job in `created` or `retry` state is deleted after `retentionSeconds`, default 14 days. [S1]
- Dependencies: `flow()` creates `blocked` children that unblock when parents complete; they are not an external-event wait. [S3]
- Cron: `schedule(name, cron, data, options)` with missed-run policies. [S1]
- Concurrency: `localConcurrency`, `localGroupConcurrency` (in-memory, per node), `groupConcurrency` (DB-tracked, across nodes). [S1]
- Pause: no queue-level pause found; `cancel`, `resume`, `retry` exist for job ids. [S3]
- Transactions: send and complete can share an application transaction (ORM adapters documented). [S2]
- Not verified: pg-boss's minimum Postgres version.

### Graphile Worker

- MIT. Requires Postgres 12+ and Node 22.18+. [S11][S13]
- Retries: a failed job is retried with `exp(least(10, attempt))` back-off. `max_attempts` defaults to 25. [S9][S10]
- Crash: a job whose worker dies stays locked for at least 4 hours before it is re-run. [S7]
- Dedupe: `job_key` with modes `replace`, `preserve_run_at`, `unsafe_dedupe` (warned against). [S8]
- Cron: crontab with optional backfill (`fill=`). [S12]
- Concurrency: `concurrency` per worker process. Named `queue_name` runs jobs serially; there is no N-way per-queue limit. [S9][S12]
- No wait-for-event or pause primitive found in docs. [S7][S9]

### DBOS Transact (TypeScript)

- Core is MIT and runs on Postgres. The README states "there's no additional infrastructure". [S14][S19]
- Durable `DBOS.sleep` is recorded in the system DB and resumes after restart; recovery runs at launch. [S15][dbos-executor.ts:460]
- Non-suspend `sleep` loops on in-process timers until the wake time (`durableSleepms`). The `recv` docs say suspend mode avoids holding a waiting workflow in memory, and suspend mode requires Transact Enterprise. [S15][S16]
- Enterprise features are `AUTO_UPGRADE`, `SHARDING`, `SUSPEND` and `EXTERNAL_STORAGE`. They are enabled only by config flags. Queues, cron (`createSchedule`), retries and dedupe are not gated. [S16][S15]
- Steps: "at least once" execution, with a checkpoint after each step. [S15]
- Step retries: `retriesAllowed`, `maxAttempts` (default 3), `backoffRate` (default 2), and a predicate deciding whether an error is retried. [S17]
- Workflow IDs: `workflowIDReusePolicy` defaults to `return-existing`; queue `deduplicationID` with `duplicationPolicy`. [S15]
- Queues: `concurrency`, `workerConcurrency`, `rateLimit`, and partition limits. [S18]
- Not verified: the Postgres version DBOS requires; whether non-suspend `recv` polls the DB.

### Inngest (self-hosted)

- Self-hosting supported since 1.0. A single binary runs everything. SQLite is the default, Postgres optional, Redis optional. [S22]
- Waits: `step.waitForEvent` pauses the run until an event arrives or the timeout expires (e.g. "7d"). The function process does not keep running during the wait. [S23]
- Sleep: up to one year per `step.sleep`, within the run-length limit. Those limits are stated for Inngest Cloud; self-host limits are not stated. [S24]
- Restart durability of waits: not stated in the fetched docs. [not verified]
- Licence: the server is SSPL v1 with a grant to Apache-2.0 effective on the third anniversary of release. The SDKs are Apache-2.0. [S20][S21] SSPL's network-use clause needs a legal read before any hosted offering (PRD §103). [not verified]

### Trigger.dev (self-hosted)

- Apache-2.0 at the repo root. No separate webapp licence file. [S28]
- Hardware minimums: webapp 3+ vCPU / 6+ GB, worker 4+ vCPU / 8+ GB. Both can share one machine only for testing. [S26]
- Required and bundled services: Postgres, Redis, object storage, container registry, supervisor, s2-lite, Docker socket proxy. ClickHouse is optional but recommended. [S26]
- Checkpointing for self-hosting was removed in v4 and was not recommended. [S26]
- Concurrency: queue `concurrencyLimit` is deprecated in favour of `concurrency`; per-key pools are available. [S31]
- Ruled out for this box on hardware alone.

### Temporal (self-hosted)

- Server is MIT. The TypeScript SDK is MIT, Node ≥ 20.3, and bundles a native Rust core bridge. [S32][S43]
- Persistence: schema directories for PostgreSQL, MySQL, SQLite and Cassandra. Advanced visibility runs on Postgres 12+; Cassandra is not supported. [S35][S34]
- Services: frontend, history, matching and worker, all started by default in one process. [S36]
- No official hardware sizing found in the deployment docs. [S33] [not verified for footprint]
- Workflows are deterministic. Replay compares emitted commands with history; code changes to running workflows need versioning or patching. [S38]
- Default history limits (per namespace, as shipped): 51,200 events or 50 MB as errors; 10 MB and 10,240 events as warnings. [S37]
- Retry: `RetryPolicy` with `nonRetryableErrorTypes`, `backoffCoefficient`, `maximumInterval`, `maximumAttempts`. [S39]
- Dedupe: `workflowIdConflictPolicy` is required for `executeUpdateWithStart`. [S41]
- Waits: `condition(fn, timeout)` and `sleep`, plus signals. [S42]
- Concurrency: `maxConcurrentActivityTaskExecutions` and workflow-task limits per worker process. [S40]
- Excluded for Phase 0 because it adds a stateful server and the determinism rules to every workflow an agent writes. Revisit if the Phase 1 scope needs multi-worker coordination.

### Hatchet (self-hosted) and Restate

- Hatchet is MIT and uses Postgres as its durability layer. Docs list Postgres 15.6, an engine, a dashboard, and an optional RabbitMQ. A Postgres-only message queue and a lite image are documented. It states it has been load-tested to 10k tasks/s. [S44][S45]
- Hatchet durable sleep and event waits are described in docs, but limits and retry details were not checked. [S46]
- Restate is a single binary with an embedded log and RocksDB and needs no Postgres. Its licence is BSL 1.1. Its docs do not state a licence. [S47][S48]
- Neither was evaluated in depth; both are listed for completeness.

## Submit-once design (applies to any engine)

The "submit application" step must never happen twice. None of the candidates gives this for free, so the app enforces it:

1. Before any browser action that can submit, write an intent row in the same transaction that moves the application to `submitting`. Give it a unique idempotency key per application and attempt. A partial unique index allows at most one active submit intent per application.
2. Run the submit as its own job or step with no automatic engine retries (pg-boss `retryLimit: 0`; Graphile `max_attempts: 1`; DBOS `retriesAllowed: false`; Temporal `maximumAttempts: 1`). Retries are then explicit in the app.
3. Note the default lease: pg-boss expires an active job after 900 s by default, and an expired job is re-run. Graphile holds a crashed job's lock for 4 hours. Either can re-run a submit that already went through. [S1][S2][S7]
4. If the process dies after the submit click but before confirmation is recorded, move the application to `submit_unknown`. Never retry from that state. Route it to Needs You to verify on the employer site. [PRD §44 "ambiguous irreversible decision"][S49]
5. Record confirmation (the employer's receipt or page evidence) as a separate state change, so the audit trail shows what was submitted (PRD §95, §81). [S49]

## Facts downstream decisions depend on

- **Postgres-only is achievable.** pg-boss, Graphile Worker and DBOS need no service beyond Postgres. Temporal and Hatchet need their own server. Trigger.dev is too heavy for this box. [S1][S11][S14][S26][S33][S45]
- **No option provides exactly-once external side effects.** pg-boss, DBOS and Temporal all document at-least-once execution. The submit guard is an app responsibility under every option. [S2][S15][S39]
- **Multi-day waits:** pg-boss and Graphile have no wait primitive; app state is required. DBOS waits are durable across restart, but out-of-memory parking needs enterprise suspend mode. Temporal and Inngest park natively. [S2][S7][S15][S16][S23][S42]
- **Concurrency (PRD §71):** pg-boss gives per-node `localConcurrency` and cross-node `groupConcurrency`. That covers MAX_APPLICATION_WORKERS-style caps. [S1]
- **Licences:** pg-boss, Graphile Worker, DBOS core, Temporal server and SDK, and Hatchet are MIT. Trigger.dev is Apache-2.0. Inngest is SSPL with a delayed Apache grant. Restate is BSL 1.1. [S6][S13][S19][S28][S32][S20][S47][S44]
- **Retry classification must be designed in app code under pg-boss and Graphile.** Temporal, DBOS, Inngest and Trigger.dev provide it natively. [S17][S25][S30][S39]

## Open risks

- **Footprint of pg-boss under load is not measured.** No primary source gives a memory figure for any candidate. A 4 GB box test is needed before Tracer Bullet 1. [not verified]
- **DBOS suspend mode is proprietary.** If the team later wants out-of-memory waits, the choice is an enterprise licence or the app's state machine. [S16]
- **pg-boss release churn.** The library shipped 12.38.0 in October 2026 with a large option surface. Pin the version and keep the app's use narrow. [S6]
- **Inngest licence.** SSPL's network-use clause could matter for the Phase 4 hosted SaaS (PRD §103). Legal review needed before any hosted offering. [S20] [not verified]
- **Temporal footprint and agent authoring.** Adds a stateful server and determinism rules. Only worth it if Phase 1 needs multi-worker orchestration that the app state machine cannot cover. [S33][S38]
- **Hatchet and Restate were not evaluated in depth.** A second research pass is needed if the runner-up list is reopened. [not verified]
- **Recovery of waits after restart** under Inngest and Trigger.dev self-host was not confirmed from docs. [not verified]

## Sources

- [S1] pg-boss types (`src/types.ts`): https://github.com/timgit/pg-boss/blob/main/src/types.ts
- [S2] pg-boss introduction (at-least-once delivery): https://github.com/timgit/pg-boss/blob/main/docs/introduction.md
- [S3] pg-boss jobs API (`flow`, `cancel`, `resume`, `retry`): https://github.com/timgit/pg-boss/blob/main/docs/api/jobs.md
- [S4] pg-boss attorney (24-hour expiry cap): https://github.com/timgit/pg-boss/blob/main/src/attorney.ts
- [S5] pg-boss npm metadata (licence, Node engine, deps): https://registry.npmjs.org/pg-boss
- [S6] pg-boss repo and release 12.38.0: https://github.com/timgit/pg-boss/releases/tag/12.38.0
- [S7] Graphile Worker error handling: https://github.com/graphile/worker/blob/main/website/docs/error-handling.md
- [S8] Graphile Worker job keys: https://github.com/graphile/worker/blob/main/website/docs/job-key.md
- [S9] Graphile Worker `add_job` (`max_attempts`, `queue_name`): https://github.com/graphile/worker/blob/main/website/docs/sql-add-job.md
- [S10] Graphile Worker exponential back-off: https://github.com/graphile/worker/blob/main/website/docs/exponential-backoff.md
- [S11] Graphile Worker requirements: https://github.com/graphile/worker/blob/main/website/docs/requirements.md
- [S12] Graphile Worker cron: https://github.com/graphile/worker/blob/main/website/docs/cron.md
- [S13] Graphile Worker package metadata (MIT): https://github.com/graphile/worker/blob/main/package.json
- [S14] DBOS Transact README: https://github.com/dbos-inc/dbos-transact/blob/main/README.md
- [S15] DBOS Transact core (`src/dbos.ts`, `src/system_database.ts`, `src/dbos-executor.ts`): https://github.com/dbos-inc/dbos-transact/blob/main/src/dbos.ts
- [S16] DBOS enterprise gate (`src/enterprise.ts`): https://github.com/dbos-inc/dbos-transact/blob/main/src/enterprise.ts
- [S17] DBOS step options (`src/step.ts`): https://github.com/dbos-inc/dbos-transact/blob/main/src/step.ts
- [S18] DBOS queue options (`src/wfqueue.ts`): https://github.com/dbos-inc/dbos-transact/blob/main/src/wfqueue.ts
- [S19] DBOS Transact licence (MIT): https://github.com/dbos-inc/dbos-transact/blob/main/LICENSE
- [S20] Inngest server licence (SSPL v1 with Apache 2.0 future grant): https://github.com/inngest/inngest/blob/main/LICENSE.md
- [S21] Inngest README licence section: https://github.com/inngest/inngest/blob/main/README.md
- [S22] Inngest self-hosting: https://www.inngest.com/docs/self-hosting
- [S23] Inngest `step.waitForEvent`: https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event
- [S24] Inngest usage limits: https://www.inngest.com/docs/usage-limits/inngest
- [S25] Inngest SDK exports `NonRetriableError`: https://github.com/inngest/inngest-js/blob/main/packages/inngest/src/index.ts
- [S26] Trigger.dev self-hosting with Docker: https://trigger.dev/docs/self-hosting/docker
- [S27] Trigger.dev self-hosting overview: https://trigger.dev/docs/self-hosting/overview
- [S28] Trigger.dev licence (Apache-2.0): https://github.com/triggerdotdev/trigger.dev/blob/main/LICENSE
- [S29] Trigger.dev `wait.forToken`: https://trigger.dev/docs/wait-for-token
- [S30] Trigger.dev retries: https://trigger.dev/docs/errors-retrying
- [S31] Trigger.dev queue concurrency: https://trigger.dev/docs/queue-concurrency
- [S32] Temporal server licence (MIT): https://github.com/temporalio/temporal/blob/main/LICENSE
- [S33] Temporal self-hosted deployment: https://docs.temporal.io/self-hosted-guide/deployment
- [S34] Temporal visibility stores: https://docs.temporal.io/self-hosted-guide/visibility
- [S35] Temporal persistence schemas: https://github.com/temporalio/temporal/tree/main/schema
- [S36] Temporal default services (`temporal/server.go`): https://github.com/temporalio/temporal/blob/main/temporal/server.go
- [S37] Temporal history limit defaults (`common/dynamicconfig/constants.go`): https://github.com/temporalio/temporal/blob/main/common/dynamicconfig/constants.go
- [S38] Temporal workflow definition (determinism, versioning): https://docs.temporal.io/workflow-definition
- [S39] Temporal TS SDK retry policy (`packages/common/src/retry-policy.ts`): https://github.com/temporalio/sdk-typescript/blob/main/packages/common/src/retry-policy.ts
- [S40] Temporal TS SDK worker options (`packages/worker/src/worker-options.ts`): https://github.com/temporalio/sdk-typescript/blob/main/packages/worker/src/worker-options.ts
- [S41] Temporal TS SDK workflow client (`packages/client/src/workflow-client.ts`): https://github.com/temporalio/sdk-typescript/blob/main/packages/client/src/workflow-client.ts
- [S42] Temporal TS SDK workflow timers (`packages/workflow/src/workflow.ts`): https://github.com/temporalio/sdk-typescript/blob/main/packages/workflow/src/workflow.ts
- [S43] Temporal TS SDK npm metadata: https://registry.npmjs.org/@temporalio/worker
- [S44] Hatchet README (MIT, Postgres durability): https://github.com/hatchet-dev/hatchet/blob/main/README.md
- [S45] Hatchet Docker Compose self-hosting: https://docs.hatchet.run/self-hosting/docker-compose
- [S46] Hatchet durable execution: https://docs.hatchet.run/home/durable-execution
- [S47] Restate licence (BSL 1.1): https://github.com/restatedev/restate/blob/main/LICENSE
- [S48] Restate server overview: https://docs.restate.dev/server/overview.md
- [S49] Project PRD (local): `init-prd.md` §20, §28, §44, §45, §70, §71, §81, §95, §96, §103 (repo root)
- [dbos-executor.ts:460] DBOS recovery at launch: https://github.com/dbos-inc/dbos-transact/blob/main/src/dbos-executor.ts
