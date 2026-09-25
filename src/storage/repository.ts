import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { OrchardDatabase } from "./database.js";
import { assertRunTransition, type RunStatus } from "../core/contracts.js";

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

  createVersion(input: { workflowId: string; contentHash: string; sourcePath: string; bundlePath: string; manifest: unknown; sdkVersion: string; dependencyLockHash?: string }): string {
    const id = uuidv7();
    const timestamp = now();
    const next = this.db.database.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM workflow_versions WHERE workflow_id = ?").get(input.workflowId) as { version_no: number };
    this.db.database.prepare("INSERT INTO workflow_versions (id, workflow_id, version_no, content_hash, source_path, bundle_path, manifest_json, sdk_version, dependency_lock_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id, input.workflowId, next.version_no, input.contentHash, input.sourcePath, input.bundlePath, json(input.manifest), input.sdkVersion, input.dependencyLockHash ?? null, timestamp,
    );
    this.db.database.prepare("UPDATE workflows SET current_version_id = ?, updated_at = ? WHERE id = ?").run(id, timestamp, input.workflowId);
    return id;
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

  appendEvent(input: { runId: string; type: string; stepId?: string; attemptId?: string; payload?: unknown }): number {
    const sequence = this.db.database.prepare("SELECT COALESCE(MAX(sequence_no), 0) + 1 AS sequence_no FROM run_events WHERE run_id = ?").get(input.runId) as { sequence_no: number };
    this.db.database.prepare("INSERT INTO run_events (id, run_id, sequence_no, step_id, attempt_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      uuidv7(), input.runId, sequence.sequence_no, input.stepId ?? null, input.attemptId ?? null, input.type, input.payload === undefined ? null : json(input.payload), now(),
    );
    return sequence.sequence_no;
  }
}
