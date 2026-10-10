# Workflow state ownership and transitions

Repository-backed SQLite state is authoritative. In-memory queues and timers are only wake-up mechanisms.

| Record | Authoritative state | Allowed terminal/continuation transitions |
| --- | --- | --- |
| Run | `runs.status` updated by `RunRepository` | `queued -> running`; `running -> succeeded/failed/cancel_requested`; `cancel_requested -> cancelled/needs_review`; expired running claim -> queued |
| Logical Step | `step_runs.status` updated by `StepRepository` | `running -> succeeded/failed/cancelled`; a successful row is immutable memoization for its run lineage |
| Worker Task | `workflow_tasks.status` updated by `WorkflowTaskRepository` | `queued -> running`; `running -> succeeded/failed/cancelled`; retryable failure -> queued |
| Attempt | `task_attempts` / `step_attempts` | `running -> succeeded/failed/cancelled/expired`; attempts are append-only history |
| Lease | `task_leases` and run claim columns | claim, heartbeat with fencing, completion or expiry; stale completion is rejected |

Every claim and completion checks the current status plus lease identity/version. A successful step is looked up by `(run_id, step_instance_key)` and never by lexical ordering of step IDs. New workflow versions affect only newly-created Runs; an existing Run keeps its original `workflow_version_id`.

The legacy `step_runs` model is the user-visible logical execution/history model. `workflow_tasks` is the worker-facing queue model. They must not be treated as interchangeable until an approved migration establishes their relationship.
