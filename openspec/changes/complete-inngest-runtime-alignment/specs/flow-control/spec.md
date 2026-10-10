# Flow control

## Requirements

### Requirement: Flow control SHALL be applied atomically at admission

The runtime MUST apply global/workflow concurrency, key concurrency, priority, rate limit, throttle, debounce, and singleton policies through one transactional admission boundary. A policy helper that is not called by the trigger paths does not satisfy this requirement.

#### Scenario: Concurrent admission cannot exceed a limit

- **WHEN** multiple workers accept commands for the same workflow or key concurrently
- **THEN** the persisted decision admits no more than the configured limit
- **AND** delayed commands remain durable and claimable after restart

### Requirement: Debounce SHALL merge pending commands

A debounce policy MUST merge events for the same policy key during the configured window, retain the documented payload semantics, and create at most one Run after the window expires.

#### Scenario: Repeated events in one debounce window

- **WHEN** multiple matching events arrive before the debounce deadline
- **THEN** they produce one pending command and one eventual Run
- **AND** the merge decision and selected payload are visible in history

### Requirement: Singleton replacement SHALL be durable

Singleton skip and cancel modes MUST be applied atomically with the new command. Replacement cancellation MUST propagate to the old active Run and stale results MUST be fenced.

#### Scenario: Singleton cancel replacement

- **WHEN** a new command arrives while a singleton Run is active in cancel mode
- **THEN** the old Run is cancelled or cancel-requested
- **AND** the new command is not lost
- **AND** a late old result cannot overwrite either Run

### Requirement: Supported batching SHALL be explicit

A workflow that declares batching MUST persist a batch key, maximum size, window, ordered event payloads, and batch lifecycle. Unsupported batching configuration MUST be rejected during validation.

#### Scenario: Batch reaches maximum size

- **WHEN** the pending batch reaches its configured maximum size
- **THEN** one Run is created with the ordered batch payload
- **AND** duplicate event delivery does not add a second copy
