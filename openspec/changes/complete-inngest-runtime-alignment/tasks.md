# Tasks

## 1. Baseline and contract

- [ ] 1.1 Record the current Inngest reference revision/date and update `docs/inngest-compatibility.md` with the exact supported subset and intentional differences.
- [ ] 1.2 Define the Orchard policy snapshot, cancellation cause, timeout cause, wait predicate, and batch contracts without claiming Inngest protocol compatibility.
- [ ] 1.3 Add regression tests reproducing the verified gaps: policy helpers bypassed by real triggers, active cancellation not aborting WorkerLoop, and timeout recorded as cancelled.

## 2. Policy admission and queue integration

- [ ] 2.1 Route event, cron, manual, and child-workflow creation through one transactional admission service.
- [ ] 2.2 Persist the immutable execution-policy snapshot used by each Run and reject conflicting policy/version input.
- [ ] 2.3 Wire global/workflow/key concurrency and priority into real task admission and claim paths.
- [ ] 2.4 Wire rate limit and throttle into real trigger paths with durable retry times.
- [ ] 2.5 Wire debounce and singleton skip/cancel into real event/manual/cron paths, including replacement fencing.
- [ ] 2.6 Persist and expose every admission decision with a stable command/run identifier.

## 3. Cancellation and timeout

- [ ] 3.1 Add a run-scoped controller registry to the default WorkerLoop and remove controllers when execution ends.
- [ ] 3.2 Connect API cancellation and singleton replacement to the active controller, queued task cancellation, and continuation cancellation.
- [ ] 3.3 Introduce structured cancellation causes for user cancel, `cancelOn`, timeout, and lease loss.
- [ ] 3.4 Make timeout errors retryable according to policy and distinguish timeout/failed terminal states from user cancellation.
- [ ] 3.5 Add event-driven `cancelOn` validation, durable matching, idempotent cancellation, and non-terminal filtering.

## 4. Wait, batching, and runtime semantics

- [ ] 4.1 Validate and persist the supported wait-for-event matching subset; reject unsupported predicates instead of silently ignoring them.
- [ ] 4.2 Ensure event resume commands are enqueued immediately and remain idempotent across restart and duplicate delivery.
- [ ] 4.3 Design the minimal supported batching contract (key, size, window, ordered payload) and obtain database review if schema changes are required.
- [ ] 4.4 Implement batching admission and execution only after database-change approval; otherwise explicitly reject batching configuration.
- [ ] 4.5 Document Orchard-specific operation IDs, retry defaults, wait matching, and unsupported Inngest features.

## 5. Database review and migration safety

- [ ] 5.1 Update `docs/database-change-review.md` with any new tables/columns/indexes and rollback behavior.
- [ ] 5.2 Obtain explicit approval before adding or enabling any migration.
- [ ] 5.3 Test empty databases, existing databases, restart recovery, backup, and legacy history compatibility.

## 6. End-to-end verification

- [ ] 6.1 Add HTTP-to-Worker tests for concurrency, key concurrency, priority, rate limit, throttle, debounce, and singleton.
- [ ] 6.2 Add active cancellation, `cancelOn`, timeout retry/exhaustion, and late-result tests through the real runtime.
- [ ] 6.3 Add wait predicate and duplicate resume tests through the real event endpoint.
- [ ] 6.4 Add batching boundary tests or validation tests proving unsupported batching is rejected.
- [ ] 6.5 Run `pnpm typecheck`, `pnpm test`, all end-to-end tests, and OpenSpec validation; record remaining intentional differences.
