# Orchard / Inngest compatibility

Orchard aligns with the **behavioral** concepts that are publicly documented by Inngest: trigger-driven runs, stable step identities, memoized successful steps, durable scheduling, retries, cancellation, and worker leases. Reference checked: Inngest open-source repository `inngest/inngest`, public `master` revision as of 2026-09-29. This is a semantic alignment, not a protocol implementation.

## Compatibility matrix

| Concept | Orchard behavior | Inngest SDK compatibility |
| --- | --- | --- |
| Event/manual/Cron/invoke trigger | Converted to a version-bound, idempotent Run command | Not wire-compatible |
| `step.run` | Orchard `WorkflowContext.step.run` persists step attempts and successful outputs | Source is not interchangeable |
| Sleep/wait | Requires an Orchard durable runtime adapter; plain SDK context uses an in-process fallback only | Inngest continuation records cannot be imported |
| Retry | Workflow policy is mapped to attempts and backoff at the Orchard repository boundary | Configuration names are similar, semantics are Orchard-owned |
| Flow control | Queue decisions are Orchard history events and are not Inngest queue records | No shared limits or buckets |
| Cancellation | User cancellation reaches active local workers; `cancelOn` supports only validated event-name/field-equality conditions | Adaptation required; no Inngest cancellation protocol |
| Batching | Explicitly rejected until the reviewed durable batch contract is implemented; debounce is not batching | Unsupported |
| Wait predicates | Event name plus an optional top-level key/equality snapshot; duplicate resume is idempotent | Adaptation required for richer predicates |
| Timeout/retry | Timeout is a structured retryable failure, distinct from user cancellation; retry defaults are Orchard-owned | Defaults and error taxonomy differ |
| History/trace | Stored in Orchard `run_events` and repository projections | No Inngest API compatibility |
| Worker lease | SQLite-backed Orchard task lease and fencing | No Inngest worker protocol |

A workflow written for `@jiangliuhong/orchard/workflow` must be adapted before it can run elsewhere. An Inngest function cannot be loaded directly as an Orchard workflow because the context, persistence boundary, artifact manifest, authentication, and event transport differ. Orchard does not claim compatibility with Inngest Cloud protocols, authentication, deployment, or storage.
