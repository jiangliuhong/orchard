# Proposal: complete Inngest runtime alignment

## Why

The `implement-task-scheduling-and-workflows` and `align-inngest-durable-workflows` changes provide a durable Orchard execution core, but verification against the current Inngest repository found gaps in the real Server + Worker path. Flow-control implementations are not wired into Run admission, active cancellation does not abort the default worker execution, timeout is recorded as cancellation, and `cancelOn`/batching are absent.

This change closes those gaps while preserving Orchard's documented boundary: behavioral alignment with public Inngest concepts, not Inngest Cloud protocol, authentication, storage, or SDK source compatibility.

## Scope

- Wire workflow execution policy into event, cron, manual, and child-run admission.
- Make concurrency, key concurrency, rate limiting, throttling, debounce, singleton, and priority observable and effective in the production path.
- Add run-scoped cancellation propagation to the default WorkerLoop and event-driven `cancelOn` cancellation.
- Distinguish timeout from user cancellation and apply retry policy consistently.
- Improve durable event-wait matching and add an explicit, bounded batching model where supported.
- Add end-to-end conformance tests against the Orchard behavioral contract and update the compatibility matrix.

## Non-goals

- No Inngest wire/API/authentication compatibility.
- No import of Inngest continuation records or execution history.
- No guarantee that Orchard and Inngest have identical defaults unless explicitly documented.
- No rollback of already-created external side effects.
- No database schema migration before the required database-change review is approved.

## Acceptance summary

The change is complete only when a real Server + Worker test proves that policy configuration changes admission and execution behavior, cancellation reaches active user code, timeout follows the retry/failure state machine, and duplicate/replayed events remain idempotent across restart.
