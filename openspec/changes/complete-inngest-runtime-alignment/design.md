# Design

## Compatibility boundary

Use the current public Inngest concepts as the reference model: trigger-driven runs, stable step identities, memoized step results, durable sleep/wait/invoke, retries, cancellation, and queue flow control. Orchard remains an independent runtime with its own SDK and persistence format.

## Admission and policy snapshot

Introduce one admission path for event, cron, manual, and child workflow commands. It resolves the immutable WorkflowVersion and stores a validated execution-policy snapshot with the Run/command. Admission must atomically apply idempotency and flow-control decisions before a task becomes claimable.

The queue must enforce:

- global and workflow concurrency;
- evaluated key concurrency with a persisted key snapshot;
- priority ordering without starvation of older eligible work;
- rate-limit windows and throttle spacing;
- debounce merge windows;
- singleton skip/cancel replacement.

Every delay, merge, skip, cancel, or reject decision must produce a history record with policy key, reason, retry/resume time, and source command.

## Cancellation and timeout

Maintain a run-scoped controller registry in the WorkerLoop. Cancellation must atomically mark the Run and queued tasks, cancel waiting continuations, and abort the active controller if present. Lease fencing remains authoritative for late results.

Use separate internal causes for user cancellation, `cancelOn`, timeout, and lease loss. Timeout is not user cancellation: it records a timeout error and enters the configured retry/exhaustion path. A late success after cancellation or timeout cannot overwrite the terminal state.

`cancelOn` is evaluated when an event is durably accepted. Matching must be idempotent and must not cancel completed runs. The first release may support the documented event-name and field-equality subset; unsupported expressions must be rejected rather than silently ignored.

## Wait and batching

Wait conditions use event name plus a validated matching predicate/key snapshot. A single event may resume each matching continuation at most once. The implementation must retain event payload needed by the resumed workflow without exposing secrets in list APIs.

Batching is an explicit capability, not an accidental debounce alias. A batch policy has a key, maximum size, and window. Intake appends events to one pending batch atomically; expiration or max size creates one Run with the ordered batch payload. If batching is not supported for a workflow, validation rejects the policy.

## Persistence and migrations

Prefer existing tables and additive fields. If a new table, column, index, or status is required, first update the database-change review and wait for approval. Do not enable an unreviewed migration. Existing Runs and immutable Workflow Versions must remain readable and replayable.

## Verification strategy

Add unit tests for policy decisions and state transitions, then end-to-end tests through the real HTTP/API + default WorkerLoop path. Include restart, duplicate intake, concurrent admission, active cancellation, timeout retry, stale result, `cancelOn`, wait matching, and batch boundary cases. Keep the compatibility document explicit about remaining intentional differences.
