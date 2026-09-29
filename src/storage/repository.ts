import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { OrchardDatabase } from "./database.js";
import { assertRunTransition, type RunStatus } from "../core/contracts.js";
import { parseCron } from "../scheduler/cron.js";

export interface AppRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string;
}

export interface AgentProfileRecord {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly config: unknown;
  readonly allowedTools: readonly string[];
  readonly secretRef?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorkflowRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly currentVersionId?: string;
}

export interface WorkflowVersionRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly versionNo: number;
  readonly contentHash: string;
  readonly sourcePath: string;
  readonly bundlePath: string;
  readonly manifest: unknown;
  readonly sdkVersion: string;
  readonly createdAt: number;
}

export interface ArtifactRecord {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly hash: string;
  readonly mime: string;
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

export class AgentProfileRepository {
  constructor(private readonly db: OrchardDatabase) {}

  list(): readonly AgentProfileRecord[] {
    const rows = this.db.database.prepare("SELECT id, name, provider, model, config_json AS configJson, allowed_tools_json AS allowedToolsJson, secret_ref AS secretRef, created_at AS createdAt, updated_at AS updatedAt FROM agent_profiles ORDER BY created_at, id").all() as { id: string; name: string; provider: string; model: string; configJson: string; allowedToolsJson: string; secretRef?: string | null; createdAt: number; updatedAt: number }[];
    return rows.map((row) => ({ id: row.id, name: row.name, provider: row.provider, model: row.model, config: JSON.parse(row.configJson), allowedTools: JSON.parse(row.allowedToolsJson), ...(row.secretRef ? { secretRef: row.secretRef } : {}), createdAt: row.createdAt, updatedAt: row.updatedAt }));
  }

  create(input: { name: string; provider: string; model: string; config?: unknown; allowedTools?: readonly string[]; secretRef?: string }): AgentProfileRecord {
    const id = uuidv7(); const timestamp = now();
    const config = input.config ?? {}; const allowedTools = input.allowedTools ?? [];
    this.db.database.prepare("INSERT INTO agent_profiles (id, name, provider, model, config_json, allowed_tools_json, secret_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.name, input.provider, input.model, json(config), json(allowedTools), input.secretRef ?? null, timestamp, timestamp);
    return { id, name: input.name, provider: input.provider, model: input.model, config, allowedTools, ...(input.secretRef ? { secretRef: input.secretRef } : {}), createdAt: timestamp, updatedAt: timestamp };
  }
}

export class WorkflowRepository {
  constructor(private readonly db: OrchardDatabase) {}

  createApp(input: { workspaceId: string; name: string; description?: string }): AppRecord {
    const id = uuidv7();
    const description = input.description ?? "";
    const timestamp = now();
    this.db.database.prepare("INSERT INTO apps (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, input.workspaceId, input.name, description, timestamp, timestamp);
    return { id, workspaceId: input.workspaceId, name: input.name, description };
  }

  createWorkflow(input: { id?: string; workspaceId: string; name: string; description?: string }): WorkflowRecord {
    const id = input.id ?? uuidv7();
    const timestamp = now();
    this.db.database.prepare("INSERT INTO workflows (id, workspace_id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)").run(
      id, input.workspaceId, input.name, input.description ?? "", timestamp, timestamp,
    );
    return { id, workspaceId: input.workspaceId, name: input.name, description: input.description ?? "", status: "active" };
  }

  getVersion(id: string): WorkflowVersionRecord | undefined {
    const row = this.db.database.prepare("SELECT id, workflow_id AS workflowId, version_no AS versionNo, content_hash AS contentHash, source_path AS sourcePath, bundle_path AS bundlePath, manifest_json AS manifestJson, sdk_version AS sdkVersion, created_at AS createdAt FROM workflow_versions WHERE id = ?").get(id) as (Omit<WorkflowVersionRecord, "manifest"> & { manifestJson: string }) | undefined;
    if (!row) return undefined;
    return { ...row, manifest: JSON.parse(row.manifestJson) };
  }

  listVersions(workflowId: string): readonly WorkflowVersionRecord[] {
    return this.db.database.prepare("SELECT id FROM workflow_versions WHERE workflow_id = ? ORDER BY version_no DESC").all(workflowId).map((row) => this.getVersion((row as { id: string }).id)!).filter(Boolean);
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

  activateVersion(workflowId: string, versionId: string): boolean {
    this.db.database.exec("BEGIN IMMEDIATE;");
    try {
      const version = this.db.database.prepare("SELECT id FROM workflow_versions WHERE id = ? AND workflow_id = ?").get(versionId, workflowId);
      if (!version) { this.db.database.exec("ROLLBACK;"); return false; }
      const result = this.db.database.prepare("UPDATE workflows SET current_version_id = ?, updated_at = ? WHERE id = ?").run(versionId, now(), workflowId);
      this.db.database.exec(result.changes === 1 ? "COMMIT;" : "ROLLBACK;");
      return result.changes === 1;
    } catch (error) { this.db.database.exec("ROLLBACK;"); throw error; }
  }

  getCurrentVersionId(workflowId: string): string | undefined {
    const row = this.db.database.prepare("SELECT current_version_id AS currentVersionId FROM workflows WHERE id = ? AND status = 'active'").get(workflowId) as { currentVersionId?: string | null } | undefined;
    return row?.currentVersionId ?? undefined;
  }

  getDraft(id: string): { id: string; workspaceId: string; workflowId?: string; baseVersionId?: string; rootPath: string; revision: number; status: string; checkResult?: unknown } | undefined {
    const row = this.db.database.prepare("SELECT id, workspace_id AS workspaceId, workflow_id AS workflowId, base_version_id AS baseVersionId, root_path AS rootPath, revision, status, check_result_json AS checkResultJson FROM workflow_drafts WHERE id = ?").get(id) as { id: string; workspaceId: string; workflowId?: string | null; baseVersionId?: string | null; rootPath: string; revision: number; status: string; checkResultJson?: string | null } | undefined;
    if (!row) return undefined;
    return { id: row.id, workspaceId: row.workspaceId, rootPath: row.rootPath, revision: row.revision, status: row.status, ...(row.workflowId ? { workflowId: row.workflowId } : {}), ...(row.baseVersionId ? { baseVersionId: row.baseVersionId } : {}), ...(row.checkResultJson ? { checkResult: JSON.parse(row.checkResultJson) } : {}) };
  }

  getWorkspaceByName(name: string): { readonly id: string; readonly name: string; readonly rootPath: string } | undefined {
    return this.db.database.prepare("SELECT id, name, root_path AS rootPath FROM workspaces WHERE name = ?").get(name) as { id: string; name: string; rootPath: string } | undefined;
  }

  getWorkflow(id: string, workspaceId?: string): WorkflowRecord | undefined {
    const row = workspaceId === undefined
      ? this.db.database.prepare("SELECT id, workspace_id AS workspaceId, name, description, status, current_version_id AS currentVersionId FROM workflows WHERE id = ?").get(id)
      : this.db.database.prepare("SELECT id, workspace_id AS workspaceId, name, description, status, current_version_id AS currentVersionId FROM workflows WHERE id = ? AND workspace_id = ?").get(id, workspaceId);
    return row as WorkflowRecord | undefined;
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
    const maxAttempts = input.maxAttempts ?? 1;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error("Invalid task maxAttempts");
    const inputJson = input.input === undefined ? null : json(input.input);
    const id = uuidv7();
    const timestamp = now();
    // A step key is the idempotency boundary for a run. Repeated scheduling
    // must return the original task instead of creating a second execution.
    this.db.database.prepare("INSERT OR IGNORE INTO workflow_tasks (id, run_id, workflow_version_id, step_key, status, input_json, max_attempts, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)").run(id, input.runId, input.workflowVersionId, input.stepKey, inputJson, maxAttempts, timestamp);
    const row = this.db.database.prepare("SELECT id, run_id AS runId, workflow_version_id AS workflowVersionId, step_key AS stepKey, status, input_json AS inputJson, max_attempts AS maxAttempts, next_attempt_at AS nextAttemptAt FROM workflow_tasks WHERE run_id = ? AND step_key = ?").get(input.runId, input.stepKey) as WorkflowTaskRecord & { inputJson?: string | null } | undefined;
    if (!row) throw new Error("Unable to create workflow task");
    if (row.workflowVersionId !== input.workflowVersionId) throw new Error("Workflow task version conflict");
    if (inputJson !== null && row.inputJson !== null && row.inputJson !== inputJson) throw new Error("Workflow task input conflict");
    return row;
  }

  get(id: string): WorkflowTaskRecord | undefined {
    return this.db.database.prepare("SELECT id, run_id AS runId, workflow_version_id AS workflowVersionId, step_key AS stepKey, status, max_attempts AS maxAttempts, next_attempt_at AS nextAttemptAt FROM workflow_tasks WHERE id = ?").get(id) as WorkflowTaskRecord | undefined;
  }

  list(runId?: string): readonly WorkflowTaskRecord[] {
    const query = runId ? "SELECT id, run_id AS runId, workflow_version_id AS workflowVersionId, step_key AS stepKey, status, max_attempts AS maxAttempts, next_attempt_at AS nextAttemptAt FROM workflow_tasks WHERE run_id = ? ORDER BY created_at" : "SELECT id, run_id AS runId, workflow_version_id AS workflowVersionId, step_key AS stepKey, status, max_attempts AS maxAttempts, next_attempt_at AS nextAttemptAt FROM workflow_tasks ORDER BY created_at";
    return (runId ? this.db.database.prepare(query).all(runId) : this.db.database.prepare(query).all()) as unknown as WorkflowTaskRecord[];
  }

  claim(workerId: string, leaseMs: number, nowMs = now(), limits: { maxPerWorkflow?: number; maxPerRun?: number } = {}): { task: WorkflowTaskRecord; lease: TaskLeaseRecord } | undefined {
    this.db.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.db.database.prepare("SELECT id, run_id AS runId, workflow_version_id AS workflowVersionId, step_key AS stepKey, status, max_attempts AS maxAttempts, next_attempt_at AS nextAttemptAt FROM workflow_tasks t WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (? IS NULL OR (SELECT COUNT(*) FROM workflow_tasks w WHERE w.workflow_version_id = t.workflow_version_id AND w.status = 'running') < ?) AND (? IS NULL OR (SELECT COUNT(*) FROM workflow_tasks r WHERE r.run_id = t.run_id AND r.status = 'running') < ?) ORDER BY created_at LIMIT 1").get(nowMs, limits.maxPerWorkflow ?? null, limits.maxPerWorkflow ?? null, limits.maxPerRun ?? null, limits.maxPerRun ?? null) as WorkflowTaskRecord | undefined;
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
      const task = this.db.database.prepare("SELECT max_attempts AS maxAttempts FROM workflow_tasks WHERE id = ? AND status = 'running'").get(lease.taskId) as { maxAttempts: number } | undefined;
      const attempt = this.db.database.prepare("SELECT attempt_no AS attemptNo FROM task_attempts WHERE id = ? AND status = 'running'").get(lease.attemptId) as { attemptNo: number } | undefined;
      if (!task || !attempt) { this.db.database.exec("ROLLBACK;"); return false; }
      const retryable = error === undefined || (typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable !== false);
      const retrying = status === "failed" && retryable && attempt.attemptNo < task.maxAttempts;
      const nextAttemptAt = retrying ? nowMs + Math.min(60_000, 250 * (2 ** Math.max(0, attempt.attemptNo - 1))) : null;
      this.db.database.prepare("UPDATE workflow_tasks SET status = ?, output_json = ?, error_json = ?, next_attempt_at = ?, ended_at = ? WHERE id = ? AND status = 'running'").run(retrying ? "queued" : status, output === undefined ? null : json(output), error === undefined ? null : json(error), nextAttemptAt, retrying ? null : nowMs, lease.taskId);
      this.db.database.prepare("UPDATE task_attempts SET status = ?, ended_at = ?, error_json = ? WHERE id = ? AND status = 'running'").run(status, nowMs, error === undefined ? null : json(error), lease.attemptId);
      this.db.database.prepare("DELETE FROM task_leases WHERE id = ?").run(leaseId);
      this.db.database.exec("COMMIT;");
      return true;
    } catch (error) { this.db.database.exec("ROLLBACK;"); throw error; }
  }

  recoverExpired(nowMs = now()): number {
    this.db.database.exec("BEGIN IMMEDIATE;");
    try {
      const expired = this.db.database.prepare("SELECT l.task_id AS taskId, l.attempt_id AS attemptId, t.max_attempts AS maxAttempts, a.attempt_no AS attemptNo FROM task_leases l JOIN workflow_tasks t ON t.id = l.task_id JOIN task_attempts a ON a.id = l.attempt_id WHERE l.expires_at <= ? AND t.status = 'running'").all(nowMs) as { taskId: string; attemptId: string; maxAttempts: number; attemptNo: number }[];
      for (const task of expired) {
        // An expired lease means the worker may have crashed before reporting a
        // result. Always make the task reclaimable; maxAttempts limits ordinary
        // retryable failures, not recovery of an unacknowledged lease.
        this.db.database.prepare("UPDATE task_attempts SET status = 'failed', error_json = ?, ended_at = ? WHERE id = ? AND status = 'running'").run(json({ message: "Lease expired" }), nowMs, task.attemptId);
        this.db.database.prepare("UPDATE workflow_tasks SET status = 'queued', next_attempt_at = ?, error_json = ?, ended_at = NULL WHERE id = ? AND status = 'running'").run(nowMs, json({ message: "Lease expired" }), task.taskId);
        this.db.database.prepare("DELETE FROM task_leases WHERE task_id = ?").run(task.taskId);
      }
      this.db.database.exec("COMMIT;");
      return expired.length;
    } catch (error) { this.db.database.exec("ROLLBACK;"); throw error; }
  }
}

export interface ScheduleRecord { readonly id: string; readonly workflowId: string; readonly workflowVersionId?: string; readonly expression: string; readonly timezone: string; readonly enabled: boolean; readonly misfirePolicy: string; }
export interface AuthoringSessionRecord { readonly id: string; readonly draftId: string; readonly status: string; }

export class ScheduleRepository {
  constructor(private readonly db: OrchardDatabase) {}
  create(input: { workflowId: string; workflowVersionId?: string; expression: string; timezone?: string; misfirePolicy?: string }): ScheduleRecord {
    parseCron(input.expression);
    const timezone = input.timezone ?? "UTC";
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch { throw new Error(`Invalid schedule timezone: ${timezone}`); }
    const misfirePolicy = input.misfirePolicy ?? "skip";
    if (!["skip", "catch_up"].includes(misfirePolicy)) throw new Error(`Invalid schedule misfire policy: ${misfirePolicy}`);
    const id = uuidv7(); const timestamp = now();
    this.db.database.prepare("INSERT INTO schedules (id, workflow_id, workflow_version_id, expression, timezone, enabled, misfire_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)").run(id, input.workflowId, input.workflowVersionId ?? null, input.expression, timezone, misfirePolicy, timestamp, timestamp);
    return { id, workflowId: input.workflowId, ...(input.workflowVersionId ? { workflowVersionId: input.workflowVersionId } : {}), expression: input.expression, timezone, enabled: false, misfirePolicy };
  }
  setEnabled(id: string, enabled: boolean): boolean { return Number(this.db.database.prepare("UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now(), id).changes) === 1; }
  update(id: string, input: { expression?: string; timezone?: string; misfirePolicy?: string; workflowVersionId?: string }): boolean {
    if (input.expression !== undefined) parseCron(input.expression);
    if (input.timezone !== undefined) { try { new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format(); } catch { throw new Error(`Invalid schedule timezone: ${input.timezone}`); } }
    if (input.misfirePolicy !== undefined && !["skip", "catch_up"].includes(input.misfirePolicy)) throw new Error(`Invalid schedule misfire policy: ${input.misfirePolicy}`);
    const current = this.get(id);
    if (!current) return false;
    const result = this.db.database.prepare("UPDATE schedules SET expression = ?, timezone = ?, misfire_policy = ?, workflow_version_id = ?, updated_at = ? WHERE id = ?").run(input.expression ?? current.expression, input.timezone ?? current.timezone, input.misfirePolicy ?? current.misfirePolicy, input.workflowVersionId ?? current.workflowVersionId ?? null, now(), id);
    return Number(result.changes) === 1;
  }
  delete(id: string): boolean { return Number(this.db.database.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes) === 1; }
  list(): readonly ScheduleRecord[] { return this.db.database.prepare("SELECT id FROM schedules ORDER BY created_at, id").all().map((row) => this.get((row as { id: string }).id)!).filter(Boolean); }
  listEnabled(): readonly ScheduleRecord[] { return this.db.database.prepare("SELECT id, workflow_id AS workflowId, workflow_version_id AS workflowVersionId, expression, timezone, enabled, misfire_policy AS misfirePolicy FROM schedules WHERE enabled = 1 ORDER BY id").all().map((row) => { const value = row as { id: string; workflowId: string; workflowVersionId?: string | null; expression: string; timezone: string; enabled: number; misfirePolicy: string }; return { id: value.id, workflowId: value.workflowId, ...(value.workflowVersionId ? { workflowVersionId: value.workflowVersionId } : {}), expression: value.expression, timezone: value.timezone, enabled: true, misfirePolicy: value.misfirePolicy }; }); }
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
  get(id: string): ScheduleRecord | undefined { const row = this.db.database.prepare("SELECT id, workflow_id AS workflowId, workflow_version_id AS workflowVersionId, expression, timezone, enabled, misfire_policy AS misfirePolicy FROM schedules WHERE id = ?").get(id) as { id: string; workflowId: string; workflowVersionId?: string | null; expression: string; timezone: string; enabled: number; misfirePolicy: string } | undefined; return row && { id: row.id, workflowId: row.workflowId, ...(row.workflowVersionId ? { workflowVersionId: row.workflowVersionId } : {}), expression: row.expression, timezone: row.timezone, enabled: row.enabled === 1, misfirePolicy: row.misfirePolicy }; }
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

  /** Persist an event and submit matching trigger runs through one idempotent callback. */
  deliverMatching(input: { source: string; eventId: string; name: string; data: unknown; createRun: (trigger: { id: string; workflowId: string; workflowVersionId?: string }, eventId: string) => string }): { readonly event: IncomingEventResult; readonly deliveries: readonly string[] } {
    const event = this.receive(input);
    if (event.duplicate) return { event, deliveries: [] };
    const rows = this.db.database.prepare("SELECT id, workflow_id AS workflowId, workflow_version_id AS workflowVersionId, config_json AS configJson FROM triggers WHERE enabled = 1 AND type = 'event'").all() as { id: string; workflowId: string; workflowVersionId?: string | null; configJson: string }[];
    const deliveries: string[] = [];
    for (const row of rows) {
      let config: unknown;
      try { config = JSON.parse(row.configJson); } catch { continue; }
      const eventName = config && typeof config === "object" && !Array.isArray(config) ? (config as { eventName?: unknown; name?: unknown }).eventName ?? (config as { name?: unknown }).name : undefined;
      if (eventName !== input.name) continue;
      const runId = input.createRun({ id: row.id, workflowId: row.workflowId, ...(row.workflowVersionId ? { workflowVersionId: row.workflowVersionId } : {}) }, event.id);
      if (this.deliver({ eventId: event.id, triggerId: row.id, runId })) deliveries.push(runId);
    }
    return { event, deliveries };
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

export class ArtifactRepository {
  constructor(private readonly db: OrchardDatabase) {}

  register(input: Omit<ArtifactRecord, "id"> & { id?: string; runId?: string; stepId?: string; attemptId?: string; retentionPolicy?: string }): ArtifactRecord {
    const id = input.id ?? uuidv7();
    this.db.database.prepare("INSERT INTO artifacts (id, run_id, step_id, attempt_id, path, size, hash, mime, retention_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.runId ?? null, input.stepId ?? null, input.attemptId ?? null, input.path, input.size, input.hash, input.mime, input.retentionPolicy ?? "retain", now());
    return { id, path: input.path, size: input.size, hash: input.hash, mime: input.mime };
  }

  get(id: string): ArtifactRecord | undefined { return this.db.database.prepare("SELECT id, path, size, hash, mime FROM artifacts WHERE id = ?").get(id) as ArtifactRecord | undefined; }
}

export interface SuccessfulStepRecord {
  readonly stepRunId: string;
  readonly stepId: string;
  readonly output: unknown;
}

export class StepRepository {
  constructor(private readonly db: OrchardDatabase) {}

  getSuccessful(runId: string, stepId: string): SuccessfulStepRecord | undefined {
    const row = this.db.database.prepare("SELECT id AS stepRunId, step_id AS stepId, output_ref AS outputRef FROM step_runs WHERE run_id = ? AND step_instance_key = ? AND status = 'succeeded'").get(runId, stepId) as { stepRunId: string; stepId: string; outputRef?: string | null } | undefined;
    if (!row) return undefined;
    return { stepRunId: row.stepRunId, stepId: row.stepId, output: row.outputRef === null || row.outputRef === undefined ? undefined : JSON.parse(row.outputRef) };
  }

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
    this.db.database.exec("BEGIN IMMEDIATE;");
    try {
      const attempt = this.db.database.prepare("UPDATE step_attempts SET status = ?, output_ref = ?, error_json = ?, ended_at = ? WHERE id = ? AND status = 'running'").run(input.status, output, error, timestamp, input.attemptId);
      if (attempt.changes !== 1) { this.db.database.exec("ROLLBACK;"); return; }
      this.db.database.prepare("UPDATE step_runs SET status = ?, output_ref = ?, ended_at = ? WHERE id = ? AND status = 'running'").run(input.status, output, timestamp, input.stepRunId);
      this.db.database.exec("COMMIT;");
    } catch (error) { this.db.database.exec("ROLLBACK;"); throw error; }
  }
}

export class RunRepository {
  constructor(private readonly db: OrchardDatabase) {}

  createRunForWorkflow(input: { workflowId: string; workflowVersionId?: string; inputRef?: string; retryOfRunId?: string; triggerId?: string; idempotencyKey?: string }): RunRecord {
    const row = input.workflowVersionId
      ? this.db.database.prepare("SELECT id FROM workflow_versions WHERE id = ? AND workflow_id = ?").get(input.workflowVersionId, input.workflowId) as { id: string } | undefined
      : this.db.database.prepare("SELECT current_version_id AS id FROM workflows WHERE id = ? AND status = 'active' AND current_version_id IS NOT NULL").get(input.workflowId) as { id?: string } | undefined;
    if (!row?.id) { const error = new Error("WORKFLOW_NOT_FOUND"); error.name = "WORKFLOW_NOT_FOUND"; throw error; }
    return this.createRun({ ...input, workflowVersionId: row.id });
  }

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
