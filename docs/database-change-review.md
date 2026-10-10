# Durable workflow database change review

**Change:** `align-inngest-durable-workflows`
**Status:** Approved by user confirmation
**Submitted:** 2025-09-29

This review is required before adding or enabling migrations for durable continuations, wait conditions, resume commands, policy buckets, worker heartbeats, or parent/child runs.

## Proposed additions

- continuation: run, logical step, kind (`sleep`, `wait`, `retry`, `invoke`), resume deadline, event/match key, status, lease/fencing fields, idempotency key
- wait condition: event name/key, timeout, unique active condition per run/step
- resume command: source continuation, command key, payload, consumed timestamp
- policy bucket: policy key, window/token state, next available time
- worker heartbeat: worker identity, instance, heartbeat and expiry timestamps
- parent-child run link: parent run, invoking step, child run, idempotency key, result status

## Constraints and rollback

All new records must be additive, retain foreign-key references to immutable workflow versions, and have unique keys that make recovery idempotent. Migration must run in the existing startup transaction after a backup. Rollback is restore-from-backup plus a migration version rollback procedure; no existing `step_runs`, `workflow_tasks`, or history rows may be deleted or rewritten. Empty databases, existing databases, and legacy history must be tested before enabling the migration.

## Current decision

The user explicitly approved database changes in this conversation. Migrations 004 (continuations, scheduling decisions, buckets, heartbeats and parent-child links) and 005 (task retry configuration) are enabled. This approval concerns the database design; it does not resolve the SDK operation-identity decision described below.

## Verification and rollback

`tests/durable-migrations.test.mjs` verifies upgrading a v3 database, retaining Run/history rows, a complete pre-migration SQLite snapshot, manual backup integrity, and offline restoration to v3. Empty initialization is covered by `tests/storage.test.mjs`. Backups use `VACUUM INTO` so committed WAL contents are included. Stop the service and restore the snapshot together with the matching old runtime; do not merely decrement `user_version` or drop columns.

## Open SDK decision (not a database approval request)

Parallel branches can reach implicit sleep/wait/invoke counters in a different order after memoization. `tests/durable-pauses.test.mjs` reproduces a branch waking at another branch's deadline. Durable operations need explicit stable IDs and a documented compatibility policy for existing no-ID signatures. Do not treat the current implementation as production-ready or mark parallel continuation acceptance complete until this decision and regression are resolved.

**Approval:** approved
**Reviewer:** user confirmation
**Approved at:** 2025-09-29
