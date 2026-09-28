## 1. Persistence Foundation

- [x] 1.1 Add instance-root initialization for `~/.orchard/` (with configurable test root), secure directory permissions, writable/space checks, and `orchard.db` setup.
- [x] 1.2 Add SQLite migrations for apps, workflows, workflow versions, artifacts, runs, steps, attempts, leases, events, schedules, and authoring sessions while preserving existing tables and UUIDv7/WAL/foreign-key conventions.
- [ ] 1.3 Implement repository models and transaction-safe state transitions for drafts, immutable versions, artifacts, runs, steps, attempts, leases, events, schedules, and authoring sessions.
- [ ] 1.4 Add repository tests for uniqueness, legal lifecycle transitions, rollback behavior, and restart-readable state.

## 2. Artifact Storage and Workflow Compilation

- [ ] 2.1 Implement normalized relative-path validation that rejects absolute paths, `..` traversal, symlink escape, undeclared files, and unsafe artifact locations.
- [ ] 2.2 Implement the controlled artifact store with temporary operation directories, per-file SHA-256 hashes, source-tree/bundle digests, manifest generation, atomic rename, and orphan-candidate tracking.
- [ ] 2.3 Implement workflow source validation for the `worker.ts` entry point, SDK contract, input/output contract, imports, dependency allowlist, capability allowlist, and compiler configuration.
- [x] 2.4 Integrate the existing compiler to emit the runtime-only `bundle/worker.mjs` and record compiler metadata and complete source/bundle manifests.
- [x] 2.5 Implement immutable workflow version creation and activation transactions so failed compilation or publication never changes the active version.
- [ ] 2.6 Add startup reconciliation and delayed artifact garbage collection for missing, unreferenced, and candidate-orphan directories, preserving referenced artifacts.
- [ ] 2.7 Add compiler, path-safety, digest, atomic-publication, failed-publication, and artifact-GC tests.

## 3. Workflow Authoring and Pi Adapter

- [x] 3.1 Implement workflow draft create/update/compile/publish services using controlled source directories and validation results.
- [x] 3.2 Implement Pi authoring sessions with workflow context, permitted file scope, bounded output, timeout/cancellation, and persisted request/response/error states.
- [x] 3.3 Adapt configured Pi responses into constrained patches or file contents and reject path escapes, unsupported files, malformed responses, and unapproved capabilities before compilation.
- [x] 3.4 Expose actionable configuration, timeout, cancellation, and validation errors without creating a version on Pi failure or invalid output.
- [ ] 3.5 Add tests for successful authoring, diff/summary generation, unavailable Pi, failed calls, cancellation, invalid output, and publish gating.

## 4. Server/Worker Execution Protocol

- [x] 4.1 Implement persistent task creation from workflow step requests, including stable run/step keys, version/artifact references, retry policy, and queued state.
- [x] 4.2 Implement atomic task lease acquisition, worker identity, lease expiry, heartbeat, completion, failure, cancellation, and lease-version checks.
- [ ] 4.3 Implement the TypeScript/Node.js Worker loop and internal server-worker interface with bounded concurrency and per-workflow/run limits.
- [ ] 4.4 Implement runtime artifact loading that resolves only database-registered paths under the instance root and revalidates manifest, version, app/workflow identity, and SHA-256 digests before import.
- [ ] 4.5 Execute only compiled `bundle/worker.mjs` through the controlled SDK, CLI tool registry, and run context; reject task-provided paths or direct source imports.
- [ ] 4.6 Implement lease expiry recovery, worker error isolation, attempt history, and restart re-claim behavior.
- [ ] 4.7 Add protocol tests for exclusive claims, heartbeats, stale results, expiry takeover, concurrency limits, artifact mismatch, worker crashes, and recovery.

## 5. Run Coordination and Durable Semantics

- [ ] 5.1 Implement run creation against an explicit or active immutable workflow version and persist input, artifact identity, lifecycle state, and traceable IDs.
- [ ] 5.2 Implement event-driven sequence/DAG progression for `ctx.step` calls with stable step keys and persisted successful outputs.
- [ ] 5.3 Implement retry scheduling with persisted attempts, retryable error classification, backoff, maximum attempts, and terminal failure transitions.
- [ ] 5.4 Implement cancellation markers and AbortSignal propagation that stop future scheduling, cancel current local work, and classify late results as non-success.
- [ ] 5.5 Implement idempotent successful-step lookup and run finalization with durable output, step history, errors, timestamps, and version/artifact references.
- [ ] 5.6 Implement startup recovery of queued, leased, retryable, and incomplete runs without executing user code inside database transactions.
- [ ] 5.7 Add end-to-end execution tests for completion, retry, cancellation, duplicate step requests, stale completions, restart recovery, and history queries.

## 6. Schedules and Event Triggers

- [ ] 6.1 Implement schedule CRUD, validation, enable/disable state, timezone/cron calculation, occurrence keys, cursors, and compensation policy.
- [ ] 6.2 Implement the scheduler loop that scans missed occurrences, records planned/actual delivery, and submits idempotent run commands rather than executing workflows directly.
- [ ] 6.3 Implement event receipt persistence with `(source, event_id)` uniqueness, payload digest comparison, subscription matching, and conflict errors.
- [ ] 6.4 Submit event-triggered runs through the common idempotent run command and preserve delivery/run traceability.
- [ ] 6.5 Add schedule and event tests for due delivery, restart compensation, duplicate events, payload conflicts, disabled schedules, and duplicate run prevention.

## 7. Import and Export

- [x] 7.1 Define and implement the versioned portable export package containing app/workflow metadata, contracts, triggers, manifests, source files, compiled artifacts, digests, and dependency metadata.
- [x] 7.2 Implement export validation and streaming/file handling without exposing arbitrary local paths.
- [x] 7.3 Implement import staging under `~/.orchard/tmp/`, archive/path/digest validation, contract and capability validation, and dependency checks before persistence.
- [ ] 7.4 Implement atomic import publication and transactionally create/activate the imported version, retaining the previous active version if activation fails.
- [ ] 7.5 Add import/export tests for round trips, malformed packages, path traversal, digest mismatch, unsafe capabilities, missing dependencies, and all-or-nothing behavior.

## 8. API, CLI, and Observability

- [ ] 8.1 Add API endpoints for drafts, compile/publish, versions, run creation/details/cancellation, task/run observation, schedules, and events using existing Host/Origin and error-format boundaries.
- [ ] 8.2 Add API endpoints and CLI commands for workflow import/export and Pi authoring sessions, including validation status, diffs, errors, and traceable operation IDs.
- [ ] 8.3 Update existing runs/events interfaces to delegate to the persistent coordinator while preserving compatible query behavior.
- [ ] 8.4 Add CLI/workbench data contracts for workflow list, source edit/preview, publish, manual run, import/export, and run detail views.
- [ ] 8.5 Add API/CLI integration tests for authorization boundaries, state-machine errors, long-operation polling, and observable run/task history.

## 9. Migration, Operations, and Verification

- [ ] 9.1 Migrate existing registered workflows into draft/version records where recoverable, keep unrecoverable history read-only, and avoid activating unknown artifacts.
- [ ] 9.2 Add startup backup, migration diagnostics, downgrade/rollback procedures, and explicit activation-pointer rollback support.
- [x] 9.3 Add operational logging under `~/.orchard/logs/` with correlation IDs for publication, import, scheduling, leasing, worker execution, and recovery failures.
- [ ] 9.4 Run the complete typecheck, build, migration, unit, integration, restart, and security test suites and fix issues until all requirements and scenarios are covered.
