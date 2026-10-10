# Runtime conformance

## Requirements

### Requirement: Workflow policy SHALL be effective in the production execution path

The runtime MUST snapshot validated WorkflowVersion execution policy when creating a Run and MUST apply that snapshot to event, cron, manual, and child-workflow admission and task claim. Repository-only policy helpers are insufficient.

#### Scenario: Policy limits an event-triggered run

- **WHEN** an event creates multiple Runs for a workflow with a concurrency or rate limit
- **THEN** the real Server + Worker path admits and executes them according to the persisted policy without exceeding the limit
- **AND** each delay or rejection is observable as a scheduling decision

### Requirement: Active cancellation SHALL reach user execution

The default WorkerLoop MUST maintain a run-scoped cancellation path. Cancelling a queued, running, sleeping, waiting, or retrying Run MUST prevent future work, cancel pending continuations, and abort active cancellable execution.

#### Scenario: Cancel an active Run

- **WHEN** the API cancels a running Run
- **THEN** the active workflow receives an abort signal
- **AND** no later step is started
- **AND** a late result cannot change the cancelled terminal state

### Requirement: Timeout SHALL be distinct from cancellation

The runtime MUST record timeout as a structured timeout error and MUST apply the configured retry policy. Exhausted timeout retries MUST end in a timeout/failed terminal state rather than being reported as user cancellation.

#### Scenario: Step timeout retries

- **WHEN** a step exceeds its configured timeout and retries remain
- **THEN** the failed attempt records a timeout cause and the next attempt is scheduled using the configured backoff
- **WHEN** retries are exhausted
- **THEN** the Run is failed or timed out and the timeout is visible in history

### Requirement: Cancellation events SHALL support `cancelOn`

A workflow MAY declare supported event cancellation conditions. The event intake path MUST durably match those conditions and cancel only non-terminal matching Runs idempotently.

#### Scenario: Matching cancellation event

- **WHEN** an event matches a Run's `cancelOn` condition
- **THEN** the Run is cancelled or marked cancel-requested according to its current state
- **AND** duplicate delivery does not create another cancellation transition
- **AND** non-matching events do not affect the Run

### Requirement: Durable waits SHALL use validated matching conditions

Wait-for-event conditions MUST persist event name and a validated matching key/predicate. A matching event MUST resume each continuation at most once, and an expired wait MUST resume with its timeout result exactly once.

#### Scenario: Non-matching event does not resume a wait

- **WHEN** a waiting Run has a condition that does not match an incoming event
- **THEN** the Run remains waiting
- **WHEN** a matching event arrives
- **THEN** exactly one resume command is persisted and the Run becomes claimable
