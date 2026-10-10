# Observability and compatibility

## Requirements

### Requirement: Scheduling and lifecycle decisions SHALL be observable

The runtime MUST expose Run history for admission, delay, merge, skip, cancellation, timeout, retry, continuation resume, batch creation, and stale-result fencing. APIs MUST return stable IDs and MUST not expose internal absolute paths or secret payloads.

#### Scenario: Explain a delayed Run

- **WHEN** a Run is delayed by concurrency, rate limit, throttle, debounce, or singleton policy
- **THEN** the Run history/API identifies the policy, reason, key scope, and next eligible time

### Requirement: Compatibility documentation SHALL distinguish alignment from interchangeability

The compatibility document MUST identify implemented behavioral concepts, intentional differences, unsupported features, and the reference upstream revision/date. It MUST continue to state that Orchard workflows and Inngest functions are not source-, protocol-, or storage-compatible.

#### Scenario: Verify a known difference

- **WHEN** a user checks batching, `cancelOn`, wait predicates, retry defaults, or authentication
- **THEN** the documentation states whether Orchard supports it and whether adaptation is required

### Requirement: Conformance tests SHALL use the real runtime path

At least one test for each supported policy and lifecycle behavior MUST pass through the HTTP/API trigger or the default Server + Worker integration, not only direct repository calls.

#### Scenario: Restart preserves a policy decision

- **WHEN** the service restarts with delayed, waiting, debounced, or retried work
- **THEN** the persisted decision is recovered and the resulting Run behavior remains idempotent
