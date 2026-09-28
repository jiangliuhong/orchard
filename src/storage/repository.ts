import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { OrchardDatabase } from "./database.js";
import { assertRunTransition, type RunStatus } from "../core/contracts.js";
import { parseCron } from "../scheduler/cron.js";

export interface WorkflowRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
}

export interface RunRecord {
  readonly id: string;
  readonly workflowVersionId: string;
  readonly status: string;
  readonly inputRef?: string;
  readonly createdAt?: number;
}

export interface WorkflowTaskRecord {
  readonly id: string;
  readonly runId: string;
  readonly workflowVersionId: string;
  readonly stepKey: string;
  readonly status: string;
  readonly maxAttempts: number;
  readonly nextAttemptAt?: number;
}

export interface TaskLeaseRecord {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly leaseVersion: number;
  readonly expiresAt: number;
}

function now(): number { return Date.now(); }
function json(value: unknown): string { return JSON.stringify(value); }

export class WorkflowRepository {
  constructor(private readonly db: OrchardDatabase) {}

  createWorkflow(input: { workspaceId: string; name: string; description?: string }): WorkflowRecord {
    const id = uuidv7();
    const timestamp = now();
    this.db.database.prepare("INSERT INTO workflows (id, workspace_id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)").run(
      id, input.workspaceId, input.name, input.description ?? "", timestamp, timestamp,
    );
    return { id, workspaceId: input.workspaceId, name: input.name, description: input.description ?? "", status: "active" };
  }

  createVersion(input: { id?: string; workflowId: string; contentHash: string; sourcePath: string; bundlePath: string; manifest: unknown; sdkVersion: string; dependencyLockHash?: string }): string {
    const id = input.id ?? uuidv7();
    const timestamp = now();
    this.db.database.exec("BEGIN IMMEDIATE;");
    try {
      const next = this.db.database.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM workflow_versions WHERE workflow_id = ?").get(input.workflowId) as { version_no: number };
      this.db.database.prepare("INSERT INTO workflow_versions (id, workflow_id, version_no, content_hash, source_path, bundle_path, manifest_json, sdk_version, dependency_lock_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, input.workflowId, next.version_no, input.contentHash, input.sourcePath, input.bundlePath, json(input.manifest), input.sdkVersion, input.dependencyLockHash ?? null, timestamp,
      );
      const activated = this.db.database.prepare("UPDATE workflows SET current_version_id = ?, updated_at = ? WHERE id = ?").run(id, timestamp, input.workflowId);
      if (Number(activated.changes) !== 1) throw new Error(`Workflow not found: ${input.workflowId}`);
      this.db.database.exec("COMMIT;");
      return id;
    } catch (error) {
      this.db.database.exec("ROLLBACK;");
      throw error;
    }
  }

  createDraft(input: { workspaceId: string; workflowId?: string; baseVersionId?: string; rootPath: string }): string {
    const id = uuidv7();
    const timestamp = now();
    this.db.database.prepare("INSERT INTO workflow_drafts (id, workspace_id, workflow_id, base_version_id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.workspaceId, input.workflowId ?? null, input.baseVersionId ?? null, input.rootPath, timestamp, timestamp);
    return id;
  }

  updateDraft(draftId: string, input: { contentHash?: string; checkResult?: unknown; status?: string; revision: number }): boolean {
    const result = this.db.database.prepare("UPDATE workflow_drafts SET content_hash = ?, check_result_json = ?, status = COALESCE(?, status), revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?").run(input.contentHash ?? null, input.checkResult === undefined ? null : json(input.checkResult), input.status ?? null, now(), draftId, input.revision);
    return result.changes === 1;
  }

  getCurrentVersionId(workflowId: string): string | undefined {
    const row = this.db.database.prepare("SELECT current_version_id AS currentVersionId FROM workflows WHERE id = ? AND status = 'active'").get(workflowId) as { currentVersionId?: string | null } | undefined;
    return row?.currentVersionId ?? undefined;
  }

  listWorkflows(workspaceId: string, limit = 50, offset = 0): readonly WorkflowRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      throw new Error("Invalid pagination");
    }
    return this.db.database.prepare("SELECT id, workspace_id AS workspaceId, name, description, status FROM workflows WHERE workspace_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?").all(workspaceId, limit, offset) as unknown as WorkflowRecord[];
  }
}

export interface IncomingEventResult { readonly id: string; readonly duplicate: boolean; }

export class WorkflowTaskRepository {
  constructor(private readonly db: OrchardDatabase) {}

  create(input: { runId: string; workflowVersionId: string; stepKey: string; input?: unknown; maxAttempts?: number }): WorkflowTaskRecord {
    const id = uuidv7();
    const timestamp = now();
    this.db.database.prepare("INSERT INTO workflow_tasks (id, run_id, workflow_version_id, step_key, status, input_json, max_attempts, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)").run(id, input.runId, input.workflowVersionId, input.stepKey, input.input === undefined ? null : json(input.input), input.maxAttempts ?? 1, timestamp);
    return { id, runId: input.runId, workflowVersionId: input.workflowVersionId, stepKey: input.stepKey, status: "queued", maxAttempts: input.maxAttempts ?? 1 };
  }

  claim(workerId: string, leaseMs: number, nowMs = now()): { task: WorkflowTaskRecord; lease: TaskLeaseRecord } | undefined {
    this.db.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.db.database.prepare("SELECT id, run_id AS runId, workflow_version_id AS workflowVersionId, step_key AS stepKey, status, max_attempts AS maxAttempts, next_attempt_at AS nextAttemptAt FROM workflow_tasks WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT 1").get(nowMs) as WorkflowTaskRecord | undefined;
      if (!row) { this.db.database.exec("COMMIT;"); return undefined; }
      const attempt = uuidv7();
      const lease = uuidv7();
      const version = 1;
      this.db.database.prepare("INSERT INTO task_attempts (id, task_id, attempt_no, status, worker_id, lease_id, created_at, started_at) VALUES (?, ?, (SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM task_attempts WHERE task_id = ?), 'running', ?, ?, ?, ?)").run(attempt, row.id, row.id, workerId, lease, nowMs, nowMs);
      this.db.database.prepare("INSERT INTO task_leases (id, task_id, attempt_id, worker_id, lease_version, expires_at, heartbeat_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(lease, row.id, attempt, workerId, version, nowMs + leaseMs, nowMs, nowMs);
      this.db.database.prepare("UPDATE workflow_tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(nowMs, row.id);
      this.db.database.exec("COMMIT;");
      return { task: { ...row, status: "running" }, lease: { id: lease, taskId: row.id, attemptId: attempt, workerId, leaseVersion: version, expiresAt: nowMs + leaseMs } };
    } catch (error) { this.db.database.exec("ROLLBACK;"); throw error; }
  }

  heartbeat(leaseId: string, workerId: string, leaseVersion: number, leaseMs: number, nowMs = now()): boolean {
    const result = this.db.database.prepare("UPDATE task_leases SET expires_at = ?, heartbeat_at = ?, lease_version = lease_version + 1 WHERE id = ? AND worker_id = ? AND lease_version = ? AND expires_at > ?").run(nowMs + leaseMs, nowMs, leaseId, workerId, leaseVersion, nowMs);
    return result.changes === 1;
  }

  complete(leaseId: string, workerId: string, leaseVersion: number, status: "succeeded" | "failed" | "cancelled", output?: unknown, error?: unknown, nowMs = now()): boolean {
    this.db.database.exec("BEGIN IMMEDIATE;");
    try {
      const lease = this.db.database.prepare("SELECT task_id AS taskId, attempt_id AS attemptId FROM task_leases WHERE id = ? AND worker_id = ? AND lease_version = ? AND expires_at > ?").get(leaseId, workerId, leaseVersion, nowMs) as { taskId: string; attemptId: string } | undefined;
      if (!lease) { this.db.database.exec("ROLLBACK;"); return false; }
      this.db.database.prepare("UPDATE workflow_tasks SET status = ?, output_json = ?, error_json = ?, ended_at = ? WHERE id = ? AND status = 'running'").run(status, output === undefined ? null : json(output), error === undefined ? null : json(error), nowMs, lease.taskId);
      this.db.database.prepare("UPDATE task_attempts SET status = ?, ended_at = ?, error_json = ? WHERE id = ? AND status = 'running'").run(status, nowMs, error === undefined ? null : json(error), lease.attemptId);
      this.db.database.prepare("DELETE FROM task_leases WHERE id = ?").run(leaseId);
      this.db.database.exec("COMMIT;");
      return true;
    } catch (error) { this.db.database.exec("ROLLBACK;"); throw error; }
  }

  recoverExpired(nowMs = now()): number {
    const result = this.db.database.prepare("UPDATE workflow_tasks SET status = 'queued' WHERE status = 'running' AND id IN (SELECT task_id FROM task_leases WHERE expires_at <= ?)").run(nowMs);
    this.db.database.prepare("DELETE FROM task_leases WHERE expires_at <= ?").run(nowMs);
    return Number(result.changes);
  }
}

export interface ScheduleRecord { readonly id: string; readonly workflowId: string; readonly expression: string; readonly timezone: string; readonly enabled: boolean; readonly misfirePolicy: string; }
export interface AuthoringSessionRecord { readonly id: string; readonly draftId: string; readonly status: string; }

export class ScheduleRepository {
  constructor(private readonly db: OrchardDatabase) {}
  create(input: { workflowId: string; workflowVersionId?: string; expression: string; timezone?: string; misfirePolicy?: string }): ScheduleRecord {
    const id = uuidv7(); const timestamp = now();
    this.db.database.prepare("INSERT INTO schedules (id, workflow_id, workflow_version_id, expression, timezone, enabled, misfire_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)").run(id, input.workflowId, input.workflowVersionId ?? null, input.expression, input.timezone ?? "UTC", input.misfirePolicy ?? "skip", timestamp, timestamp);
    return { id, workflowId: input.workflowId, expression: input.expression, timezone: input.timezone ?? "UTC", enabled: false, misfirePolicy: input.misfirePolicy ?? "skip" };
  }
  setEnabled(id: string, enabled: boolean): boolean { return Number(this.db.database.prepare("UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now(), id).changes) === 1; }
  listEnabled(): readonly ScheduleRecord[] { return this.db.database.prepare("SELECT id, workflow_id AS workflowId, expression, timezone, enabled, misfire_policy AS misfirePolicy FROM schedules WHERE enabled = 1 ORDER BY id").all().map((row) => { const value = row as { id: string; workflowId: string; expression: string; timezone: string; enabled: number; misfirePolicy: string }; return { id: value.id, workflowId: value.workflowId, expression: value.expression, timezone: value.timezone, enabled: true, misfirePolicy: value.misfirePolicy }; }); }
  updateCursor(id: string, cursor: string): boolean { return Number(this.db.database.prepare("UPDATE schedules SET cursor = ?, updated_at = ? WHERE id = ?").run(cursor, now(), id).changes) === 1; }
  planDue(id: string, until: Date, from = new Date()): readonly { occurrenceKey: string; scheduledFor: number; occurrenceId: string }[] {
    const schedule = this.get(id);
    if (!schedule || !schedule.enabled) return [];
    const cron = parseCron(schedule.expression);
    const planned: { occurrenceKey: string; scheduledFor: number; occurrenceId: string }[] = [];
    let cursor = from;
    while (true) {
      const next = cron.next(cursor);
      if (next > until) break;
      const occurrenceKey = next.toISOString();
      const occurrenceId = uuidv7();
      const result = this.db.database.prepare("INSERT OR IGNORE INTO schedule_occurrences (id, schedule_id, occurrence_key, scheduled_for, status) VALUES (?, ?, ?, ?, 'planned')").run(occurrenceId, id, occurrenceKey, next.getTime());
      if (Number(result.changes) === 1) planned.push({ occurrenceKey, scheduledFor: next.getTime(), occurrenceId });
      cursor = next;
    }
    this.updateCursor(id, until.toISOString());
    return planned;
  }
  deliverOccurrence(scheduleId: string, occurrenceKey: string, runId: string): boolean { return Number(this.db.database.prepare("UPDATE schedule_occurrences SET run_id = ?, delivered_at = ?, status = 'delivered' WHERE schedule_id = ? AND occurrence_key = ? AND run_id IS NULL").run(runId, now(), scheduleId, occurrenceKey).changes) === 1; }
  get(id: string): ScheduleRecord | undefined { const row = this.db.database.prepare("SELECT id, workflow_id AS workflowId, expression, timezone, enabled, misfire_policy AS misfirePolicy FROM schedules WHERE id = ?").get(id) as { id: string; workflowId: string; expression: string; timezone: string; enabled: number; misfirePolicy: string } | undefined; return row && { id: row.id, workflowId: row.workflowId, expression: row.expression, timezone: row.timezone, enabled: row.enabled === 1, misfirePolicy: row.misfirePolicy }; }
}

export class AuthoringSessionRepository {
  constructor(private readonly db: OrchardDatabase) {}
  create(input: { workspaceId: string; draftId: string; modelConfigRef?: string }): AuthoringSessionRecord { const id = uuidv7(); const timestamp = now(); this.db.database.prepare("INSERT INTO authoring_sessions (id, workspace_id, draft_id, status, model_config_ref, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)").run(id, input.workspaceId, input.draftId, input.modelConfigRef ?? null, timestamp, timestamp); return { id, draftId: input.draftId, status: "pending" }; }
  appendMessage(input: { sessionId: string; role: "user" | "assistant" | "error"; content: unknown }): string {
    const id = uuidv7();
    const sequence = this.db.database.prepare("SELECT COALESCE(MAX(sequence_no), 0) + 1 AS sequence FROM authoring_messages WHERE session_id = ?").get(input.sessionId) as { sequence: number };
    this.db.database.prepare("INSERT INTO authoring_messages (id, session_id, sequence_no, role, content_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, input.sessionId, sequence.sequence, input.role, json(input.content), now());
    return id;
  }
  transition(id: string, status: "running" | "succeeded" | "failed" | "cancelled"): boolean {
    const current = this.db.database.prepare("SELECT status FROM authoring_sessions WHERE id = ?").get(id) as { status: string } | undefined;
    if (!current) return false;
    const allowed: Record<string, readonly string[]> = { pending: ["running", "cancelled"], running: ["succeeded", "failed", "cancelled"], succeeded: [], failed: [], cancelled: [] };
    if (!allowed[current.status]?.includes(status)) throw new Error(`Invalid authoring session transition: ${current.status} -> ${status}`);
    return Number(this.db.database.prepare("UPDATE authoring_sessions SET status = ?, updated_at = ? WHERE id = ? AND status = ?").run(status, now(), id, current.status).changes) === 1;
  }
}

export class EventRepository {
  constructor(private readonly db: OrchardDatabase) {}

  receive(input: { source: string; eventId: string; name: string; data: unknown }): IncomingEventResult {
    const payload = json(input.data);
    const hash = createHash("sha256").update(payload).digest("hex");
    const existing = this.db.database.prepare("SELECT id, payload_hash AS payloadHash FROM incoming_events WHERE source = ? AND event_id = ?").get(input.source, input.eventId) as { id: string; payloadHash: string } | undefined;
    if (existing) {
      if (existing.payloadHash !== hash) {
        const error = new Error("Incoming event id conflicts with a different payload");
        error.name = "EVENT_CONFLICT";
        throw error;
      }
      return { id: existing.id, duplicate: true };
    }
    const id = uuidv7();
    this.db.database.prepare("INSERT INTO incoming_events (id, source, event_id, event_name, payload_ref, payload_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'received', ?)").run(id, input.source, input.eventId, input.name, payload, hash, now());
    return { id, duplicate: false };
  }

  deliver(input: { eventId: string; triggerId: string; runId?: string }): boolean {
    const event = this.db.database.prepare("SELECT id FROM incoming_events WHERE id = ?").get(input.eventId) as { id: string } | undefined;
    if (!event) throw new Error("Incoming event not found");
    const id = uuidv7();
    const result = this.db.database.prepare("INSERT OR IGNORE INTO incoming_event_deliveries (id, incoming_event_id, trigger_id, run_id, status, created_at) VALUES (?, ?, ?, ?, 'delivered', ?)").run(id, input.eventId, input.triggerId, input.runId ?? null, now());
    return Number(result.changes) === 1;
  }
}

export interface StepAttemptRecord {
  readonly stepRunId: string;
  readonly attemptId: string;
  readonly attemptNo: number;
}

export class StepRepository {
  constructor(private readonly db: OrchardDatabase) {}

  beginStep(input: { runId: string; stepId: string; nodeType: string; nodeVersion: string; config: unknown; value: unknown }): StepAttemptRecord {
    const stepRunId = uuidv7();
    const attemptId = uuidv7();
    const timestamp = now();
    const instance = input.stepId;
    this.db.database.prepare("INSERT INTO step_runs (id, run_id, step_id, step_instance_key, node_type, node_version, config_snapshot_ref, status, input_ref, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)").run(stepRunId, input.runId, input.stepId, instance, input.nodeType, input.nodeVersion, json(input.config), json(input.value), timestamp, timestamp);
    this.db.database.prepare("INSERT INTO step_attempts (id, step_run_id, attempt_no, status, input_ref, created_at, started_at) VALUES (?, ?, 1, 'running', ?, ?, ?)").run(attemptId, stepRunId, json(input.value), timestamp, timestamp);
    return { stepRunId, attemptId, attemptNo: 1 };
  }

  finishStep(input: { stepRunId: string; attemptId: string; status: "succeeded" | "failed" | "cancelled"; output?: unknown; error?: unknown }): void {
    const timestamp = now();
    const output = input.output === undefined ? null : json(input.output);
    const error = input.error === undefined ? null : json(input.error);
    this.db.database.prepare("UPDATE step_attempts SET status = ?, output_ref = ?, error_json = ?, ended_at = ? WHERE id = ? AND status = 'running'").run(input.status, output, error, timestamp, input.attemptId);
    this.db.database.prepare("UPDATE step_runs SET status = ?, output_ref = ?, ended_at = ? WHERE id = ? AND status = 'running'").run(input.status, output, timestamp, input.stepRunId);
  }
}

export class RunRepository {
  constructor(private readonly db: OrchardDatabase) {}

  createRun(input: { workflowVersionId: string; inputRef?: string; retryOfRunId?: string; triggerId?: string; idempotencyKey?: string }): RunRecord {
    const requestHash = createHash("sha256").update(JSON.stringify({ workflowVersionId: input.workflowVersionId, inputRef: input.inputRef ?? null, retryOfRunId: input.retryOfRunId ?? null, triggerId: input.triggerId ?? null })).digest("hex");
    if (input.idempotencyKey) {
      const existing = this.db.database.prepare("SELECT request_hash AS requestHash, resource_id AS resourceId FROM idempotency_keys WHERE key = ? AND operation = 'create-run'").get(input.idempotencyKey) as { requestHash: string; resourceId: string } | undefined;
      if (existing) {
        if (existing.requestHash !== requestHash) { const error = new Error("IDEMPOTENCY_CONFLICT"); error.name = "IDEMPOTENCY_CONFLICT"; throw error; }
        const prior = this.getRun(existing.resourceId);
        if (prior) return prior;
      }
    }
    const id = uuidv7();
    const inputRef = input.inputRef;
    this.db.database.prepare("INSERT INTO runs (id, workflow_version_id, trigger_id, retry_of_run_id, status, input_ref, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)").run(
      id, input.workflowVersionId, input.triggerId ?? null, input.retryOfRunId ?? null, inputRef ?? null, now(),
    );
    if (input.idempotencyKey) this.db.database.prepare("INSERT INTO idempotency_keys (key, operation, request_hash, resource_id, created_at) VALUES (?, 'create-run', ?, ?, ?)").run(input.idempotencyKey, requestHash, id, now());
    return { id, workflowVersionId: input.workflowVersionId, status: "queued", ...(inputRef === undefined ? {} : { inputRef }) };
  }

  claimRun(id: string, owner: string, leaseMs: number, generation: number): RunRecord | undefined {
    const timestamp = now();
    const result = this.db.database.prepare("UPDATE runs SET status = 'running', claim_owner = ?, claim_until = ?, worker_generation = ?, started_at = ? WHERE id = ? AND status = 'queued' AND (claim_until IS NULL OR claim_until < ?)").run(owner, timestamp + leaseMs, generation, timestamp, id, timestamp);
    if (result.changes !== 1) return undefined;
    return this.getRun(id);
  }

  claimQueuedRun(owner: string, leaseMs: number, generation: number): RunRecord | undefined {
    const timestamp = now();
    const claimUntil = timestamp + leaseMs;
    this.db.database.exec("BEGIN IMMEDIATE;");
    try {
      const candidate = this.db.database.prepare("SELECT id FROM runs WHERE status = 'queued' AND (claim_until IS NULL OR claim_until < ?) ORDER BY created_at LIMIT 1").get(timestamp) as { id: string } | undefined;
      if (!candidate) { this.db.database.exec("COMMIT;"); return undefined; }
      const result = this.db.database.prepare("UPDATE runs SET status = 'running', claim_owner = ?, claim_until = ?, worker_generation = ?, started_at = ? WHERE id = ? AND status = 'queued'").run(owner, claimUntil, generation, timestamp, candidate.id);
      if (result.changes !== 1) { this.db.database.exec("ROLLBACK;"); return undefined; }
      const row = this.db.database.prepare("SELECT id, workflow_version_id AS workflowVersionId, status, input_ref AS inputRef FROM runs WHERE id = ?").get(candidate.id) as unknown as RunRecord;
      this.db.database.exec("COMMIT;");
      return row;
    } catch (error) {
      this.db.database.exec("ROLLBACK;");
      throw error;
    }
  }

  recoverExpiredClaims(nowMs = now()): number {
    const result = this.db.database.prepare("UPDATE runs SET status = 'queued', claim_owner = NULL, claim_until = NULL WHERE status = 'running' AND claim_until IS NOT NULL AND claim_until <= ?").run(nowMs);
    return Number(result.changes);
  }

  getRun(id: string): RunRecord | undefined {
    return this.db.database.prepare("SELECT id, workflow_version_id AS workflowVersionId, status, input_ref AS inputRef, created_at AS createdAt FROM runs WHERE id = ?").get(id) as unknown as RunRecord | undefined;
  }

  requestCancel(id: string, reason: string): boolean {
    const row = this.getRun(id);
    if (!row || ["succeeded", "failed", "cancelled", "interrupted", "needs_review"].includes(row.status)) return false;
    const target: RunStatus = row.status === "queued" ? "cancelled" : "cancel_requested";
    assertRunTransition(row.status as RunStatus, target);
    const result = this.db.database.prepare("UPDATE runs SET status = ?, cancel_requested_at = ?, cancel_reason = ? WHERE id = ? AND status = ?").run(target, now(), reason, id, row.status);
    this.appendEvent({ runId: id, type: target === "cancelled" ? "run.cancelled" : "run.cancel_requested", payload: { reason } });
    return result.changes === 1;
  }

  finish(id: string, status: Extract<RunStatus, "succeeded" | "failed" | "cancelled" | "interrupted" | "needs_review">, outputRef?: string): boolean {
    const row = this.getRun(id);
    if (!row || (row.status !== "running" && row.status !== "cancel_requested")) return false;
    const target = row.status === "cancel_requested" ? (status === "succeeded" ? "needs_review" : status) : status;
    assertRunTransition(row.status as RunStatus, target);
    const result = this.db.database.prepare("UPDATE runs SET status = ?, output_ref = ?, claim_owner = NULL, claim_until = NULL, ended_at = ? WHERE id = ? AND status = ?").run(target, outputRef ?? null, now(), id, row.status);
    if (result.changes === 1) this.appendEvent({ runId: id, type: `run.${target}` });
    return result.changes === 1;
  }

  listRuns(limit = 50, offset = 0): readonly RunRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid pagination");
    return this.db.database.prepare("SELECT id, workflow_version_id AS workflowVersionId, status, input_ref AS inputRef, created_at AS createdAt FROM runs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(limit, offset) as unknown as RunRecord[];
  }

  listEvents(runId: string): readonly { id: string; sequenceNo: number; type: string; stepId?: string; attemptId?: string; payload?: unknown; createdAt: number }[] {
    return this.db.database.prepare("SELECT id, sequence_no AS sequenceNo, event_type AS type, step_id AS stepId, attempt_id AS attemptId, payload_json AS payload, created_at AS createdAt FROM run_events WHERE run_id = ? ORDER BY sequence_no").all(runId).map((row) => { const value = row as { id: string; sequenceNo: number; type: string; stepId?: string | null; attemptId?: string | null; payload?: string | null; createdAt: number }; return { id: value.id, sequenceNo: value.sequenceNo, type: value.type, ...(value.stepId ? { stepId: value.stepId } : {}), ...(value.attemptId ? { attemptId: value.attemptId } : {}), ...(value.payload === null || value.payload === undefined ? {} : { payload: JSON.parse(value.payload) }), createdAt: value.createdAt }; });
  }

  appendEvent(input: { runId: string; type: string; stepId?: string; attemptId?: string; payload?: unknown }): number {
    const sequence = this.db.database.prepare("SELECT COALESCE(MAX(sequence_no), 0) + 1 AS sequence_no FROM run_events WHERE run_id = ?").get(input.runId) as { sequence_no: number };
    this.db.database.prepare("INSERT INTO run_events (id, run_id, sequence_no, step_id, attempt_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      uuidv7(), input.runId, sequence.sequence_no, input.stepId ?? null, input.attemptId ?? null, input.type, input.payload === undefined ? null : json(input.payload), now(),
    );
    return sequence.sequence_no;
  }
}
