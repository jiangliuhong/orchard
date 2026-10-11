import { createHash } from "node:crypto";
import { readVersionConfiguration, sourceReadOnly, type SourceConfiguration } from "../authoring/source-configuration.js";
import { v7 as uuidv7 } from "uuid";
import type { OrchardDatabase } from "./database.js";
import { assertRunTransition, type RunStatus } from "../core/contracts.js";
import { parseCron } from "../scheduler/cron.js";
import { assertTaskResult, type TaskResult } from '../runtime/task-protocol.js';
import { validateAgentProfile } from "../integrations/pi/profile.js";

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
  readonly executionConfig: unknown;
  readonly artifactHash?: string;
  readonly activatedAt?: number;
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
  readonly retryBackoff?: "fixed" | "exponential";
  readonly retryInitialDelayMs?: number;
  readonly retryMaxDelayMs?: number;
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

  create(input: { name: string; provider: string; model: string; config?: unknown; allowedTools?: readonly string[] }): AgentProfileRecord {
    const profile = validateAgentProfile(input);
    const id = uuidv7(); const timestamp = now();
    const config: Record<string, unknown> = {};
    if (profile.timeoutMs !== undefined) config.timeoutMs = profile.timeoutMs;
    if (profile.thinkingLevel !== undefined) config.thinkingLevel = profile.thinkingLevel;
    const allowedTools = [...profile.allowedTools];
    // secret_ref is deprecated: credentials are owned by the host CLI and the
    // column is kept (no schema change) but never written again.
    this.db.database.prepare("INSERT INTO agent_profiles (id, name, provider, model, config_json, allowed_tools_json, secret_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)").run(id, profile.name, profile.launcher, profile.model, json(config), json(allowedTools), timestamp, timestamp);
    return { id, name: profile.name, provider: profile.launcher, model: profile.model, config, allowedTools, createdAt: timestamp, updatedAt: timestamp };
  }
}

export class WorkflowRepository {
  constructor(private readonly db: OrchardDatabase) {}
  get instanceRoot(): string { return this.db.dataDir; }

  getSourceConfiguration(versionId: string): SourceConfiguration {
    const version = this.db.database.prepare("SELECT source_path AS sourcePath, content_hash AS contentHash, manifest_json AS manifestJson FROM workflow_versions WHERE id = ?").get(versionId) as { sourcePath: string; contentHash: string; manifestJson: string } | undefined;
    if (!version) throw new Error("WORKFLOW_VERSION_NOT_FOUND");
    return readVersionConfiguration(this.db.dataDir, { ...version, manifest: JSON.parse(version.manifestJson) });
  }

  /** Backup rows are generated from code; all consumers reconstruct their config from code. */
  private backupTriggers(workflowId: string, versionId: string, config: SourceConfiguration): void {
    config.triggers.forEach((trigger, index) => {
      const id = `code:${workflowId}:${versionId}:${trigger.type}:${index}`;
      const enabled = trigger.config.enabled !== false;
      if (trigger.type === 'cron') {
        this.db.database.prepare("INSERT OR IGNORE INTO schedules (id, workflow_id, workflow_version_id, expression, timezone, enabled, misfire_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, workflowId, versionId, trigger.config.expression as string, (trigger.config.timezone as string) ?? 'UTC', enabled ? 1 : 0, (trigger.config.misfirePolicy as string) ?? 'skip', now(), now());
      } else if (trigger.type === 'event') {
        this.db.database.prepare("INSERT OR IGNORE INTO triggers (id, workflow_id, type, version_policy, config_json, timezone, enabled, created_at, updated_at) VALUES (?, ?, 'event', 'pinned', ?, 'UTC', ?, ?, ?)").run(id, workflowId, json({ ...trigger.config, workflowVersionId: versionId }), enabled ? 1 : 0, now(), now());
      }
    });
  }

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
    const row = this.db.database.prepare("SELECT id, workflow_id AS workflowId, version_no AS versionNo, content_hash AS contentHash, source_path AS sourcePath, bundle_path AS bundlePath, manifest_json AS manifestJson, sdk_version AS sdkVersion, artifact_hash AS artifactHash, activated_at AS activatedAt, created_at AS createdAt FROM workflow_versions WHERE id = ?").get(id) as (Omit<WorkflowVersionRecord, "manifest" | "executionConfig"> & { manifestJson: string; artifactHash?: string | null; activatedAt?: number | null }) | undefined;
    if (!row) return undefined;
    const config = this.getSourceConfiguration(id);
    const { executionConfig: _executionConfig, definition: _definition, name: _name, description: _description, triggers: _triggers, policy: _policy, concurrency: _concurrency, ...artifactMetadata } = JSON.parse(row.manifestJson) as Record<string, unknown>;
    const { manifestJson: _manifestJson, ...record } = row;
    return { ...record, manifest: { ...artifactMetadata, definition: config }, executionConfig: config, ...(row.artifactHash ? { artifactHash: row.artifactHash } : {}), ...(row.activatedAt === null || row.activatedAt === undefined ? {} : { activatedAt: row.activatedAt }) };
  }

  listVersions(workflowId: string): readonly WorkflowVersionRecord[] {
    return this.db.database.prepare("SELECT id FROM workflow_versions WHERE workflow_id = ? ORDER BY version_no DESC").all(workflowId).map((row) => this.getVersion((row as { id: string }).id)!).filter(Boolean);
  }

  createVersion(input: { id?: string; workflowId: string; contentHash: string; sourcePath: string; bundlePath: string; manifest: unknown; sdkVersion: string; dependencyLockHash?: string; executionConfig?: unknown; artifactHash?: string }): string {
    const id = input.id ?? uuidv7();
    if (input.executionConfig !== undefined) throw sourceReadOnly();
    const workflow = this.db.database.prepare("SELECT status FROM workflows WHERE id = ?").get(input.workflowId);
    if (!workflow || workflow.status === 'deleted') throw new Error("WORKFLOW_NOT_FOUND");
    const config = readVersionConfiguration(this.db.dataDir, input);
    const { executionConfig: _executionConfig, definition: _definition, name: _name, description: _description, triggers: _triggers, policy: _policy, concurrency: _concurrency, ...artifactMetadata } = input.manifest as Record<string, unknown>;
    const manifest = { ...artifactMetadata, definition: config };
    const timestamp = now();
    this.db.database.exec("BEGIN IMMEDIATE;");
    try {
      const next = this.db.database.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM workflow_versions WHERE workflow_id = ?").get(input.workflowId) as { version_no: number };
      this.db.database.prepare("INSERT INTO workflow_versions (id, workflow_id, version_no, content_hash, source_path, bundle_path, manifest_json, sdk_version, dependency_lock_hash, execution_config_json, artifact_hash, activated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, input.workflowId, next.version_no, input.contentHash, input.sourcePath, input.bundlePath, json(manifest), input.sdkVersion, input.dependencyLockHash ?? null, json(config), input.artifactHash ?? null, timestamp, timestamp,
      );
      const activated = this.db.database.prepare("UPDATE workflows SET current_version_id = ?, updated_at = ? WHERE id = ?").run(id, timestamp, input.workflowId);
      if (Number(activated.changes) !== 1) throw new Error(`Workflow not found: ${input.workflowId}`);
      this.db.database.prepare("UPDATE workflows SET name = ?, description = ? WHERE id = ?").run(config.name ?? input.workflowId, config.description ?? '', input.workflowId);
      this.backupTriggers(input.workflowId, id, config);
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
      const version = this.db.database.prepare("SELECT v.id FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE v.id = ? AND v.workflow_id = ? AND w.status <> 'deleted'").get(versionId, workflowId);
      if (!version) { this.db.database.exec("ROLLBACK;"); return false; }
      const config = this.getSourceConfiguration(versionId);
      const result = this.db.database.prepare("UPDATE workflows SET current_version_id = ?, name = ?, description = ?, updated_at = ? WHERE id = ?").run(versionId, config.name ?? workflowId, config.description ?? '', now(), workflowId);
      this.backupTriggers(workflowId, versionId, config);
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

  /** Remove from the workbench without deleting code, versions, or history. */
  deleteWorkflow(id: string, workspaceId: string): boolean {
    this.db.database.exec("BEGIN IMMEDIATE");
    try {
      const workflow = this.db.database.prepare("SELECT id FROM workflows WHERE id = ? AND workspace_id = ? AND status <> 'deleted'").get(id, workspaceId);
      if (!workflow) { this.db.database.exec("COMMIT"); return false; }
      const busy = this.db.database.prepare("SELECT id FROM runs WHERE workflow_version_id IN (SELECT id FROM workflow_versions WHERE workflow_id = ?) AND status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'needs_review') LIMIT 1").get(id);
      const task = this.db.database.prepare("SELECT id FROM workflow_tasks WHERE workflow_version_id IN (SELECT id FROM workflow_versions WHERE workflow_id = ?) AND status IN ('queued', 'running') LIMIT 1").get(id);
      if (busy || task) throw Object.assign(new Error("工作流还有未结束的运行，请先取消或等待完成后再删除。"), { name: "WORKFLOW_BUSY" });
      this.db.database.prepare("UPDATE workflows SET status = 'deleted', updated_at = ? WHERE id = ? AND workspace_id = ?").run(now(), id, workspaceId);
      this.db.database.exec("COMMIT");
      return true;
    } catch (error) { this.db.database.exec("ROLLBACK"); throw error; }
  }

  getWorkflow(id: string, workspaceId?: string, includeDeleted = false): WorkflowRecord | undefined {
    const row = workspaceId === undefined
      ? this.db.database.prepare("SELECT id, workspace_id AS workspaceId, name, description, status, current_version_id AS currentVersionId FROM workflows WHERE id = ?").get(id)
      : this.db.database.prepare("SELECT id, workspace_id AS workspaceId, name, description, status, current_version_id AS currentVersionId FROM workflows WHERE id = ? AND workspace_id = ?").get(id, workspaceId);
    if (!row || (!includeDeleted && row.status === "deleted")) return undefined;
    const workflow = row as unknown as WorkflowRecord;
    let config: SourceConfiguration | undefined;
    try { if (workflow.currentVersionId) config = this.getSourceConfiguration(workflow.currentVersionId); } catch { /* UI can still identify an unavailable version, without using backups. */ }
    return { ...workflow, name: config?.name ?? workflow.id, description: config?.description ?? '' };
  }

  listWorkflows(workspaceId: string, limit = 50, offset = 0): readonly WorkflowRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      throw new Error("Invalid pagination");
    }
    return this.db.database.prepare("SELECT id FROM workflows WHERE workspace_id = ? AND status <> 'deleted' ORDER BY created_at, id LIMIT ? OFFSET ?").all(workspaceId, limit, offset).map(row => this.getWorkflow((row as { id: string }).id)!).filter(Boolean);
  }
}

export interface IncomingEventResult { readonly id: string; readonly duplicate: boolean; }

export class WorkflowTaskRepository {
  constructor(private readonly db: OrchardDatabase) {}

  claimableKeyCount(policyKey: string): number { return Number((this.db.database.prepare("SELECT COUNT(*) AS n FROM workflow_tasks WHERE policy_key = ? AND status = 'running'").get(policyKey) as { n: number }).n); }

  enqueueRun(runId: string): WorkflowTaskRecord | undefined {
    this.db.database.exec('SAVEPOINT enqueue_run');
    try {
      const run = new RunRepository(this.db).getRun(runId);
      if (!run || run.status !== 'queued') { this.db.database.exec('RELEASE enqueue_run'); return undefined; }
      const active = this.db.database.prepare("SELECT id FROM workflow_tasks WHERE run_id = ? AND step_key LIKE '__run__:%' AND status IN ('queued', 'running') LIMIT 1").get(runId) as { id: string } | undefined;
      if (active) { this.db.database.exec('RELEASE enqueue_run'); return this.get(active.id); }
      const sequence = (this.db.database.prepare("SELECT COUNT(*) AS n FROM workflow_tasks WHERE run_id = ? AND step_key LIKE '__run__:%'").get(runId) as { n: number }).n;
      const config = new WorkflowRepository(this.db).getSourceConfiguration(run.workflowVersionId).policy as Record<string, unknown>;
      const retry = config.retry && typeof config.retry === 'object' ? config.retry as Record<string, unknown> : undefined;
      const concurrencyKey = typeof config.concurrencyKey === 'string' ? config.concurrencyKey : undefined;
      const priority = typeof config.priority === 'number' && Number.isSafeInteger(config.priority) ? config.priority : 0;
      const task = this.create({ runId, workflowVersionId: run.workflowVersionId, stepKey: `__run__:${sequence}`, priority, ...(concurrencyKey === undefined ? {} : { policyKey: concurrencyKey }), ...(retry && typeof retry.maxAttempts === 'number' ? { maxAttempts: retry.maxAttempts, ...(retry.backoff === 'fixed' ? { retryBackoff: 'fixed' as const } : {}), ...(typeof retry.initialDelayMs === 'number' ? { retryInitialDelayMs: retry.initialDelayMs } : {}), ...(typeof retry.maxDelayMs === 'number' ? { retryMaxDelayMs: retry.maxDelayMs } : {}) } : {}) });
      this.db.database.exec('RELEASE enqueue_run');
      return task;
    } catch (error) { this.db.database.exec('ROLLBACK TO enqueue_run; RELEASE enqueue_run'); throw error; }
  }

  heartbeatWorker(workerId: string, activeLeases: number): void {
    new WorkerHeartbeatRepository(this.db).beat(workerId, `process:${process.pid}`, activeLeases);
  }

  health(at = now()): unknown {
    const count = (sql: string) => (this.db.database.prepare(sql).get() as { n: number }).n;
    const recovered = this.db.database.prepare("SELECT MAX(created_at) AS at FROM run_events WHERE event_type = 'task.lease_expired'").get() as { at: number | null };
    return { workers: new WorkerHeartbeatRepository(this.db).list(at), activeLeases: (this.db.database.prepare('SELECT COUNT(*) AS n FROM task_leases WHERE expires_at > ?').get(at) as { n: number }).n, queueDepth: count("SELECT COUNT(*) AS n FROM workflow_tasks WHERE status = 'queued'"), failures: count("SELECT COUNT(*) AS n FROM workflow_tasks WHERE status = 'failed'"), recovery: { lastRun: recovered.at } };
  }

  create(input: { runId: string; workflowVersionId: string; stepKey: string; input?: unknown; maxAttempts?: number; priority?: number; policyKey?: string; retryBackoff?: "fixed" | "exponential"; retryInitialDelayMs?: number; retryMaxDelayMs?: number }): WorkflowTaskRecord {
    const maxAttempts = input.maxAttempts ?? 1;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error("Invalid task maxAttempts");
    if (input.priority !== undefined && !Number.isSafeInteger(input.priority)) throw new Error('Invalid task priority');
    for (const delay of [input.retryInitialDelayMs, input.retryMaxDelayMs]) if (delay !== undefined && (!Number.isSafeInteger(delay) || delay < 0)) throw new Error('Invalid retry delay');
    if (input.retryBackoff !== undefined && !['fixed', 'exponential'].includes(input.retryBackoff)) throw new Error('Invalid retry backoff');
    const inputJson = input.input === undefined ? null : json(input.input);
    const id = uuidv7();
    const timestamp = now();
    // A step key is the idempotency boundary for a run. Repeated scheduling
    // must return the original task instead of creating a second execution.
    this.db.database.prepare("INSERT OR IGNORE INTO workflow_tasks (id, run_id, workflow_version_id, step_key, status, input_json, max_attempts, retry_backoff, retry_initial_delay_ms, retry_max_delay_ms, priority, policy_key, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.runId, input.workflowVersionId, input.stepKey, inputJson, maxAttempts, input.retryBackoff ?? "exponential", input.retryInitialDelayMs ?? 250, input.retryMaxDelayMs ?? 60_000, input.priority ?? 0, input.policyKey ?? null, timestamp);
    const row = this.db.database.prepare("SELECT id, run_id AS runId, workflow_version_id AS workflowVersionId, step_key AS stepKey, status, input_json AS inputJson, max_attempts AS maxAttempts, retry_backoff AS retryBackoff, retry_initial_delay_ms AS retryInitialDelayMs, retry_max_delay_ms AS retryMaxDelayMs, next_attempt_at AS nextAttemptAt FROM workflow_tasks WHERE run_id = ? AND step_key = ?").get(input.runId, input.stepKey) as WorkflowTaskRecord & { inputJson?: string | null } | undefined;
    if (!row) throw new Error("Unable to create workflow task");
    if (row.workflowVersionId !== input.workflowVersionId) throw new Error("Workflow task version conflict");
    if (inputJson !== null && row.inputJson !== null && row.inputJson !== inputJson) throw new Error("Workflow task input conflict");
    return row;
  }

  get(id: string): WorkflowTaskRecord | undefined {
    return this.db.database.prepare("SELECT id, run_id AS runId, workflow_version_id AS workflowVersionId, step_key AS stepKey, status, max_attempts AS maxAttempts, retry_backoff AS retryBackoff, retry_initial_delay_ms AS retryInitialDelayMs, retry_max_delay_ms AS retryMaxDelayMs, next_attempt_at AS nextAttemptAt FROM workflow_tasks WHERE id = ?").get(id) as WorkflowTaskRecord | undefined;
  }

  list(runId?: string): readonly WorkflowTaskRecord[] {
    const query = runId ? "SELECT id, run_id AS runId, workflow_version_id AS workflowVersionId, step_key AS stepKey, status, max_attempts AS maxAttempts, retry_backoff AS retryBackoff, retry_initial_delay_ms AS retryInitialDelayMs, retry_max_delay_ms AS retryMaxDelayMs, next_attempt_at AS nextAttemptAt FROM workflow_tasks WHERE run_id = ? ORDER BY created_at" : "SELECT id, run_id AS runId, workflow_version_id AS workflowVersionId, step_key AS stepKey, status, max_attempts AS maxAttempts, retry_backoff AS retryBackoff, retry_initial_delay_ms AS retryInitialDelayMs, retry_max_delay_ms AS retryMaxDelayMs, next_attempt_at AS nextAttemptAt FROM workflow_tasks ORDER BY created_at";
    return (runId ? this.db.database.prepare(query).all(runId) : this.db.database.prepare(query).all()) as unknown as WorkflowTaskRecord[];
  }

  claim(workerId: string, leaseMs: number, nowMs = now(), limits: { maxPerWorkflow?: number; maxPerRun?: number; policyKey?: string; maxPerKey?: number } = {}): { task: WorkflowTaskRecord; lease: TaskLeaseRecord } | undefined {
    this.db.database.exec("BEGIN IMMEDIATE;");
    try {
      const candidates = this.db.database.prepare("SELECT id, run_id AS runId, workflow_version_id AS workflowVersionId, step_key AS stepKey, status, max_attempts AS maxAttempts, retry_backoff AS retryBackoff, retry_initial_delay_ms AS retryInitialDelayMs, retry_max_delay_ms AS retryMaxDelayMs, policy_key AS policyKey, next_attempt_at AS nextAttemptAt FROM workflow_tasks t WHERE status = 'queued' AND (step_key NOT LIKE '__run__:%' OR EXISTS (SELECT 1 FROM runs WHERE id = t.run_id AND status = 'queued')) AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (? IS NULL OR (SELECT COUNT(*) FROM workflow_tasks w WHERE w.workflow_version_id = t.workflow_version_id AND w.status = 'running') < ?) AND (? IS NULL OR (SELECT COUNT(*) FROM workflow_tasks r WHERE r.run_id = t.run_id AND r.status = 'running') < ?) AND (? IS NULL OR (SELECT COUNT(*) FROM workflow_tasks k WHERE k.policy_key = t.policy_key AND k.status = 'running') < ?) ORDER BY priority DESC, created_at, id").all(nowMs, limits.maxPerWorkflow ?? null, limits.maxPerWorkflow ?? null, limits.maxPerRun ?? null, limits.maxPerRun ?? null, limits.policyKey ?? null, limits.maxPerKey ?? null) as unknown as WorkflowTaskRecord[];
      const workflows = new WorkflowRepository(this.db);
      const row = candidates.find(candidate => {
        const config = workflows.getSourceConfiguration(candidate.workflowVersionId);
        if (config.concurrency === undefined) return true;
        const active = this.db.database.prepare("SELECT COUNT(*) AS n FROM workflow_tasks WHERE workflow_version_id = ? AND status = 'running'").get(candidate.workflowVersionId) as { n: number };
        return active.n < config.concurrency;
      });
      if (!row) { this.db.database.exec("COMMIT;"); return undefined; }
      const attempt = uuidv7();
      const lease = uuidv7();
      const version = 1;
      this.db.database.prepare("INSERT INTO task_attempts (id, task_id, attempt_no, status, worker_id, lease_id, created_at, started_at) VALUES (?, ?, (SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM task_attempts WHERE task_id = ?), 'running', ?, ?, ?, ?)").run(attempt, row.id, row.id, workerId, lease, nowMs, nowMs);
      this.db.database.prepare("INSERT INTO task_leases (id, task_id, attempt_id, worker_id, lease_version, expires_at, heartbeat_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(lease, row.id, attempt, workerId, version, nowMs + leaseMs, nowMs, nowMs);
      this.db.database.prepare("UPDATE workflow_tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(nowMs, row.id);
      if (row.stepKey.startsWith('__run__:')) this.db.database.prepare("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?), claim_owner = ?, claim_until = ?, worker_generation = COALESCE(worker_generation, 0) + 1 WHERE id = ? AND status = 'queued'").run(nowMs, workerId, nowMs + leaseMs, row.runId);
      this.db.database.exec("COMMIT;");
      return { task: { ...row, status: "running" }, lease: { id: lease, taskId: row.id, attemptId: attempt, workerId, leaseVersion: version, expiresAt: nowMs + leaseMs } };
    } catch (error) { this.db.database.exec("ROLLBACK;"); throw error; }
  }

  heartbeat(leaseId: string, workerId: string, leaseVersion: number, leaseMs: number, nowMs = now()): boolean {
    const result = this.db.database.prepare("UPDATE task_leases SET expires_at = ?, heartbeat_at = ?, lease_version = lease_version + 1 WHERE id = ? AND worker_id = ? AND lease_version = ? AND expires_at > ?").run(nowMs + leaseMs, nowMs, leaseId, workerId, leaseVersion, nowMs);
    return result.changes === 1;
  }

  acceptResult(result: TaskResult, at = now()): boolean {
    assertTaskResult(result);
    const match = this.db.database.prepare('SELECT l.id FROM task_leases l JOIN workflow_tasks t ON t.id = l.task_id WHERE l.id = ? AND l.task_id = ? AND l.attempt_id = ? AND l.worker_id = ? AND l.lease_version = ? AND t.run_id = ?').get(result.leaseId, result.taskId, result.attemptId, result.workerId, result.leaseVersion, result.runId);
    if (!match) {
      const task = this.get(result.taskId);
      if (task) new RunRepository(this.db).appendEvent({ runId: task.runId, type: 'task.stale_result', payload: { taskId: result.taskId, taskAttemptId: result.attemptId, leaseId: result.leaseId, reason: 'identity_mismatch' } });
      return false;
    }
    return this.complete(result.leaseId, result.workerId, result.leaseVersion, result.status, result.output, result.error, at);
  }

  complete(leaseId: string, workerId: string, leaseVersion: number, status: "succeeded" | "failed" | "cancelled", output?: unknown, error?: unknown, nowMs = now()): boolean {
    this.db.database.exec("BEGIN IMMEDIATE;");
    try {
      const lease = this.db.database.prepare("SELECT task_id AS taskId, attempt_id AS attemptId FROM task_leases WHERE id = ? AND worker_id = ? AND lease_version = ? AND expires_at > ?").get(leaseId, workerId, leaseVersion, nowMs) as { taskId: string; attemptId: string } | undefined;
      if (!lease) {
        const stale = this.db.database.prepare("SELECT t.run_id AS runId, a.id AS attemptId FROM task_attempts a JOIN workflow_tasks t ON t.id = a.task_id WHERE a.lease_id = ?").get(leaseId) as { runId: string; attemptId: string } | undefined;
        if (stale) {
          const runs = new RunRepository(this.db);
          runs.appendEvent({ runId: stale.runId, type: 'task.stale_result', payload: { leaseId, workerId, leaseVersion, taskAttemptId: stale.attemptId, status } });
          if (runs.getRun(stale.runId)?.status === 'cancel_requested') runs.finish(stale.runId, status === 'succeeded' ? 'needs_review' : 'cancelled');
        }
        this.db.database.exec("COMMIT;"); return false;
      }
      const task = this.db.database.prepare("SELECT max_attempts AS maxAttempts, retry_backoff AS retryBackoff, retry_initial_delay_ms AS retryInitialDelayMs, retry_max_delay_ms AS retryMaxDelayMs FROM workflow_tasks WHERE id = ? AND status = 'running'").get(lease.taskId) as { maxAttempts: number; retryBackoff: "fixed" | "exponential"; retryInitialDelayMs: number; retryMaxDelayMs: number } | undefined;
      const attempt = this.db.database.prepare("SELECT attempt_no AS attemptNo FROM task_attempts WHERE id = ? AND status = 'running'").get(lease.attemptId) as { attemptNo: number } | undefined;
      if (!task || !attempt) { this.db.database.exec("ROLLBACK;"); return false; }
      const retryable = error === undefined || (typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable !== false);
      const retrying = status === "failed" && retryable && attempt.attemptNo < task.maxAttempts;
      const delay = task.retryBackoff === "fixed" ? task.retryInitialDelayMs : task.retryInitialDelayMs * (2 ** Math.max(0, attempt.attemptNo - 1));
      const nextAttemptAt = retrying ? nowMs + Math.min(task.retryMaxDelayMs, delay) : null;
      this.db.database.prepare("UPDATE workflow_tasks SET status = ?, output_json = ?, error_json = ?, next_attempt_at = ?, ended_at = ? WHERE id = ? AND status = 'running'").run(retrying ? "queued" : status, output === undefined ? null : json(output), error === undefined ? null : json(error), nextAttemptAt, retrying ? null : nowMs, lease.taskId);
      this.db.database.prepare("UPDATE task_attempts SET status = ?, ended_at = ?, error_json = ? WHERE id = ? AND status = 'running'").run(status, nowMs, error === undefined ? null : json(error), lease.attemptId);
      this.db.database.prepare("DELETE FROM task_leases WHERE id = ?").run(leaseId);
      const identity = this.get(lease.taskId)!;
      if (identity.stepKey.startsWith('__run__:') && !retrying) {
        new RunRepository(this.db).finish(identity.runId, status, output === undefined ? undefined : json(output));
      }
      new RunRepository(this.db).appendEvent({ runId: identity.runId, stepId: identity.stepKey, type: retrying ? 'task.retrying' : `task.${status}`, payload: { taskId: lease.taskId, taskAttemptId: lease.attemptId, attemptNo: attempt.attemptNo, nextAttemptAt, ...(error === undefined ? {} : { error }) } });
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
        const identity = this.get(task.taskId)!;
        if (identity.stepKey.startsWith('__run__:')) {
          this.db.database.prepare("UPDATE runs SET status = 'queued', claim_owner = NULL, claim_until = NULL WHERE id = ? AND status = 'running'").run(identity.runId);
          this.db.database.prepare("UPDATE step_attempts SET status = 'failed', error_json = ?, ended_at = ? WHERE status = 'running' AND step_run_id IN (SELECT id FROM step_runs WHERE run_id = ?)").run(json({ message: 'Worker lease expired' }), nowMs, identity.runId);
          this.db.database.prepare("UPDATE step_runs SET status = 'failed', ended_at = ? WHERE run_id = ? AND status = 'running'").run(nowMs, identity.runId);
        }
        new RunRepository(this.db).appendEvent({ runId: identity.runId, stepId: identity.stepKey, type: 'task.lease_expired', payload: { taskId: task.taskId, taskAttemptId: task.attemptId } });
      }
      this.db.database.exec("COMMIT;");
      return expired.length;
    } catch (error) { this.db.database.exec("ROLLBACK;"); throw error; }
  }
}

export interface ContinuationRecord { readonly id: string; readonly runId: string; readonly stepKey: string; readonly kind: string; readonly status: string; readonly resumeAt?: number; readonly eventName?: string; readonly matchKey?: string; readonly payload?: unknown; readonly idempotencyKey: string; }

export class ContinuationRepository {
  constructor(private readonly db: OrchardDatabase) {}
  create(input: { runId: string; stepKey: string; kind: string; resumeAt?: number; eventName?: string; matchKey?: string; payload?: unknown; idempotencyKey: string }): ContinuationRecord {
    const id = uuidv7();
    this.db.database.prepare("INSERT OR IGNORE INTO workflow_continuations (id, run_id, step_key, kind, status, resume_at, event_name, match_key, payload_json, idempotency_key, created_at) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?)").run(id, input.runId, input.stepKey, input.kind, input.resumeAt ?? null, input.eventName ?? null, input.matchKey ?? null, input.payload === undefined ? null : json(input.payload), input.idempotencyKey, now());
    return this.getByKey(input.idempotencyKey)!;
  }
  getByKey(key: string): ContinuationRecord | undefined { return this.map(this.db.database.prepare("SELECT * FROM workflow_continuations WHERE idempotency_key = ?").get(key)); }
  list(runId?: string): readonly ContinuationRecord[] { const rows = runId ? this.db.database.prepare("SELECT * FROM workflow_continuations WHERE run_id = ? ORDER BY created_at").all(runId) : this.db.database.prepare("SELECT * FROM workflow_continuations ORDER BY created_at").all(); return rows.map((row) => this.map(row)!).filter(Boolean); }
  resumeDue(at = now()): number {
    this.db.database.exec("SAVEPOINT resume_due");
    try {
      const rows = this.db.database.prepare("SELECT c.id, c.run_id AS runId, c.kind FROM workflow_continuations c JOIN runs r ON r.id = c.run_id WHERE c.status = 'waiting' AND c.resume_at <= ? AND r.status IN ('running', 'sleeping', 'waiting', 'retrying')").all(at) as { id: string; runId: string; kind: string }[];
      for (const row of rows) {
        this.db.database.prepare("UPDATE workflow_continuations SET status = 'resumed', consumed_at = ?, payload_json = ? WHERE id = ? AND status = 'waiting'").run(at, json(row.kind === 'wait' ? { timeout: true } : null), row.id);
        this.db.database.prepare("UPDATE runs SET status = 'queued', claim_owner = NULL, claim_until = NULL WHERE id = ? AND status IN ('sleeping', 'waiting', 'retrying')").run(row.runId);
        new RunRepository(this.db).appendEvent({ runId: row.runId, type: "continuation.resumed", payload: { continuationId: row.id, reason: row.kind === 'wait' ? 'timeout' : 'deadline' } });
      }
      this.db.database.exec("RELEASE resume_due");
      return rows.length;
    } catch (error) { this.db.database.exec("ROLLBACK TO resume_due; RELEASE resume_due"); throw error; }
  }

  resumeChildren(at = now()): number {
    this.db.database.exec('SAVEPOINT resume_children');
    try {
      const children = this.db.database.prepare("SELECT l.parent_run_id AS parentId, l.parent_step_key AS stepKey, l.child_run_id AS childId, r.status FROM run_links l JOIN runs r ON r.id = l.child_run_id WHERE l.status = 'running' AND r.status IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'needs_review')").all() as { parentId: string; stepKey: string; childId: string; status: string }[];
      for (const child of children) {
        this.db.database.prepare('UPDATE run_links SET status = ? WHERE child_run_id = ?').run(child.status, child.childId);
        this.db.database.prepare("UPDATE workflow_continuations SET status = 'resumed', consumed_at = ? WHERE run_id = ? AND step_key = ? AND kind = 'invoke' AND status = 'waiting'").run(at, child.parentId, child.stepKey);
        this.db.database.prepare("UPDATE runs SET status = 'queued', claim_owner = NULL, claim_until = NULL WHERE id = ? AND status = 'waiting'").run(child.parentId);
        new RunRepository(this.db).appendEvent({ runId: child.parentId, stepId: child.stepKey, type: `run.child_${child.status}`, payload: { childRunId: child.childId } });
      }
      this.db.database.exec('RELEASE resume_children');
      return children.length;
    } catch (error) { this.db.database.exec('ROLLBACK TO resume_children; RELEASE resume_children'); throw error; }
  }

  pause(runId: string, status: "sleeping" | "waiting" | "retrying"): boolean {
    const changed = this.db.database.prepare("UPDATE runs SET status = ?, claim_owner = NULL, claim_until = NULL WHERE id = ? AND status = 'running'").run(status, runId);
    if (changed.changes === 1) new RunRepository(this.db).appendEvent({ runId, type: `run.${status}` });
    if (changed.changes === 1) return true;
    const run = new RunRepository(this.db).getRun(runId);
    return run?.status === 'sleeping' || run?.status === 'waiting' || run?.status === 'retrying';
  }
  cancelForRun(runId: string, at = now()): number { return Number(this.db.database.prepare("UPDATE workflow_continuations SET status = 'cancelled', consumed_at = ? WHERE run_id = ? AND status = 'waiting'").run(at, runId).changes); }
  consumeEvent(eventName: string, matchKey?: string, at = now(), payload?: unknown): readonly string[] {
    const rows = this.db.database.prepare("SELECT c.id, c.run_id AS runId FROM workflow_continuations c JOIN runs r ON r.id = c.run_id WHERE c.status = 'waiting' AND c.event_name = ? AND (c.match_key IS NULL OR c.match_key = ?) AND (c.resume_at IS NULL OR c.resume_at > ?) AND r.status IN ('running', 'waiting', 'sleeping') ORDER BY c.created_at").all(eventName, matchKey ?? null, at) as { id: string; runId: string }[];
    const result: string[] = [];
    for (const row of rows) {
      const changed = this.db.database.prepare("UPDATE workflow_continuations SET status = 'resumed', consumed_at = ?, payload_json = ? WHERE id = ? AND status = 'waiting'").run(at, json({ event: payload ?? null }), row.id);
      if (changed.changes === 1) {
        this.db.database.prepare("UPDATE runs SET status = 'queued', claim_owner = NULL, claim_until = NULL WHERE id = ? AND status IN ('waiting', 'sleeping')").run(row.runId);
        new RunRepository(this.db).appendEvent({ runId: row.runId, type: "continuation.resumed", payload: { continuationId: row.id, reason: 'event' } });
        result.push(row.runId);
      }
    }
    return result;
  }
  private map(row: unknown): ContinuationRecord | undefined { if (!row) return undefined; const value = row as Record<string, unknown>; return { id: value.id as string, runId: value.run_id as string, stepKey: value.step_key as string, kind: value.kind as string, status: value.status as string, ...(value.resume_at == null ? {} : { resumeAt: value.resume_at as number }), ...(value.event_name == null ? {} : { eventName: value.event_name as string }), ...(value.match_key == null ? {} : { matchKey: value.match_key as string }), ...(value.payload_json == null ? {} : { payload: JSON.parse(value.payload_json as string) }), idempotencyKey: value.idempotency_key as string }; }
}

export class PolicyBucketRepository {
  constructor(private readonly db: OrchardDatabase) {}
  consume(key: string, input: { limit: number; periodMs: number; now?: number }): { allowed: boolean; retryAt?: number } {
    if (!Number.isInteger(input.limit) || input.limit < 1 || !Number.isFinite(input.periodMs) || input.periodMs <= 0) throw new Error('Invalid rate limit');
    this.db.database.exec('BEGIN IMMEDIATE');
    try {
    const at = input.now ?? now();
    const row = this.db.database.prepare("SELECT window_start AS windowStart, window_count AS windowCount FROM policy_buckets WHERE policy_key = ?").get(key) as { windowStart?: number; windowCount?: number } | undefined;
    const reset = row?.windowStart === undefined || at - row.windowStart >= input.periodMs;
    const start = reset ? at : row.windowStart!;
    const count = reset ? 0 : (row?.windowCount ?? 0);
    if (count >= input.limit) { this.db.database.exec('COMMIT'); return { allowed: false, retryAt: start + input.periodMs }; }
    this.db.database.prepare("INSERT INTO policy_buckets (policy_key, window_start, window_count, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(policy_key) DO UPDATE SET window_start = excluded.window_start, window_count = excluded.window_count, updated_at = excluded.updated_at").run(key, start, count + 1, at);
    this.db.database.exec('COMMIT');
    return { allowed: true };
    } catch (error) { this.db.database.exec('ROLLBACK'); throw error; }
  }
}

export class WorkerHeartbeatRepository {
  constructor(private readonly db: OrchardDatabase) {}
  beat(workerId: string, instanceId: string, activeLeases = 0, at = now()): void { this.db.database.prepare("INSERT INTO worker_heartbeats (worker_id, instance_id, heartbeat_at, active_leases, status) VALUES (?, ?, ?, ?, 'active') ON CONFLICT(worker_id) DO UPDATE SET instance_id = excluded.instance_id, heartbeat_at = excluded.heartbeat_at, active_leases = excluded.active_leases, status = 'active'").run(workerId, instanceId, at, activeLeases); }
  list(at = now(), staleAfterMs = 30_000): readonly { workerId: string; instanceId: string; heartbeatAt: number; activeLeases: number; status: string }[] { return this.db.database.prepare("SELECT worker_id AS workerId, instance_id AS instanceId, heartbeat_at AS heartbeatAt, active_leases AS activeLeases, CASE WHEN heartbeat_at < ? THEN 'stale' ELSE status END AS status FROM worker_heartbeats ORDER BY worker_id").all(at - staleAfterMs) as { workerId: string; instanceId: string; heartbeatAt: number; activeLeases: number; status: string }[]; }
}

export interface ScheduleRecord { readonly id: string; readonly workflowId: string; readonly workflowVersionId?: string; readonly expression: string; readonly timezone: string; readonly enabled: boolean; readonly misfirePolicy: string; }
export interface AuthoringSessionRecord { readonly id: string; readonly draftId: string; readonly status: string; }

export class ScheduleRepository {
  constructor(private readonly db: OrchardDatabase) {}
  create(_input: { workflowId: string; workflowVersionId?: string; expression: string; timezone?: string; misfirePolicy?: string }): ScheduleRecord { throw sourceReadOnly(); }
  setEnabled(_id: string, _enabled: boolean): boolean { throw sourceReadOnly(); }
  update(_id: string, _input: { expression?: string; timezone?: string; misfirePolicy?: string; workflowVersionId?: string }): boolean { throw sourceReadOnly(); }
  delete(_id: string): boolean { throw sourceReadOnly(); }
  list(): readonly ScheduleRecord[] {
    const workflows = new WorkflowRepository(this.db);
    const rows = this.db.database.prepare("SELECT id, current_version_id AS versionId FROM workflows WHERE status = 'active' AND current_version_id IS NOT NULL ORDER BY id").all() as { id: string; versionId: string }[];
    return rows.flatMap(row => workflows.getSourceConfiguration(row.versionId).triggers.flatMap((trigger, index) => trigger.type !== 'cron' ? [] : [{
      id: `code:${row.id}:${row.versionId}:cron:${index}`, workflowId: row.id, workflowVersionId: row.versionId,
      expression: trigger.config.expression as string, timezone: (trigger.config.timezone as string) ?? 'UTC',
      enabled: trigger.config.enabled !== false, misfirePolicy: (trigger.config.misfirePolicy as string) ?? 'skip',
    }]));
  }
  listEnabled(): readonly ScheduleRecord[] { return this.list().filter(schedule => schedule.enabled); }
  updateCursor(id: string, cursor: string): boolean { return Number(this.db.database.prepare("UPDATE schedules SET cursor = ?, updated_at = ? WHERE id = ?").run(cursor, now(), id).changes) === 1; }
  planDue(id: string, until: Date, from?: Date): readonly { occurrenceKey: string; scheduledFor: number; occurrenceId: string }[] {
    const schedule = this.get(id);
    if (!schedule || !schedule.enabled) return [];
    const cron = parseCron(schedule.expression, schedule.timezone);
    const stored = this.db.database.prepare('SELECT cursor, created_at AS createdAt FROM schedules WHERE id = ?').get(id) as { cursor: string | null; createdAt: number };
    let cursor = stored.cursor ? new Date(stored.cursor) : from ?? new Date(stored.createdAt);
    while (true) {
      const next = cron.next(cursor);
      if (next > until) break;
      const occurrenceKey = next.toISOString();
      const occurrenceId = uuidv7();
      const skipped = schedule.misfirePolicy === 'skip' && next.getTime() < Math.floor(until.getTime() / 60_000) * 60_000;
      this.db.database.prepare("INSERT OR IGNORE INTO schedule_occurrences (id, schedule_id, occurrence_key, scheduled_for, status) VALUES (?, ?, ?, ?, ?)").run(occurrenceId, id, occurrenceKey, next.getTime(), skipped ? 'skipped' : 'planned');
      cursor = next;
    }
    if (!stored.cursor || until.getTime() > new Date(stored.cursor).getTime()) this.updateCursor(id, until.toISOString());
    return this.db.database.prepare("SELECT id AS occurrenceId, occurrence_key AS occurrenceKey, scheduled_for AS scheduledFor FROM schedule_occurrences WHERE schedule_id = ? AND status = 'planned' AND scheduled_for <= ? ORDER BY scheduled_for").all(id, until.getTime()) as { occurrenceKey: string; scheduledFor: number; occurrenceId: string }[];
  }
  deliverOccurrence(scheduleId: string, occurrenceKey: string, runId: string): boolean { return Number(this.db.database.prepare("UPDATE schedule_occurrences SET run_id = ?, delivered_at = ?, status = 'delivered' WHERE schedule_id = ? AND occurrence_key = ? AND run_id IS NULL").run(runId, now(), scheduleId, occurrenceKey).changes) === 1; }
  get(id: string): ScheduleRecord | undefined { return this.list().find(schedule => schedule.id === id); }
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
    const existing = this.db.database.prepare("SELECT id, event_name AS eventName, payload_hash AS payloadHash FROM incoming_events WHERE source = ? AND event_id = ?").get(input.source, input.eventId) as { id: string; eventName: string; payloadHash: string } | undefined;
    if (existing) {
      if (existing.payloadHash !== hash || existing.eventName !== input.name) {
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
    // The callback must only persist a Run, never execute user code or submit
    // to an in-memory worker before this transaction commits.
    this.db.database.exec("SAVEPOINT event_delivery");
    try {
      const event = this.receive(input);
      if (!event.duplicate) {
        this.cancelOnMatchingRuns(input.name, input.data, now());
        const matchKey = input.data && typeof input.data === "object" && "key" in input.data && typeof input.data.key === "string" ? input.data.key : undefined;
        new ContinuationRepository(this.db).consumeEvent(input.name, matchKey, now(), input.data);
        const workflows = new WorkflowRepository(this.db);
        const rows = this.db.database.prepare("SELECT id, current_version_id AS versionId FROM workflows WHERE status = 'active' AND current_version_id IS NOT NULL ORDER BY id").all() as { id: string; versionId: string }[];
        for (const row of rows) {
          workflows.getSourceConfiguration(row.versionId).triggers.forEach((trigger, index) => {
            if (trigger.type !== 'event' || trigger.config.enabled === false || (trigger.config.eventName ?? trigger.config.name) !== input.name) return;
            const id = `code:${row.id}:${row.versionId}:event:${index}`;
            const runId = input.createRun({ id, workflowId: row.id, workflowVersionId: row.versionId }, event.id);
            this.deliver({ eventId: event.id, triggerId: id, runId });
          });
        }
      }
      const deliveries = (this.db.database.prepare("SELECT run_id AS runId FROM incoming_event_deliveries WHERE incoming_event_id = ? AND run_id IS NOT NULL ORDER BY trigger_id").all(event.id) as { runId: string }[]).map((row) => row.runId);
      this.db.database.exec("RELEASE event_delivery");
      return { event, deliveries };
    } catch (error) {
      this.db.database.exec("ROLLBACK TO event_delivery; RELEASE event_delivery");
      throw error;
    }
  }

  /** Apply the deliberately small cancelOn contract at event acceptance. The
   * version config is immutable, so matching is deterministic after restart. */
  private cancelOnMatchingRuns(eventName: string, data: unknown, at: number): void {
    const rows = this.db.database.prepare("SELECT r.id, r.status, r.workflow_version_id AS versionId FROM runs r WHERE r.status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'needs_review')").all() as { id: string; status: string; versionId: string }[];
    const valueAt = (path: string): unknown => path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined, data);
    for (const row of rows) {
      const policy = new WorkflowRepository(this.db).getSourceConfiguration(row.versionId).policy;
      const conditions = policy && typeof policy === 'object' && Array.isArray((policy as { cancelOn?: unknown }).cancelOn) ? (policy as { cancelOn: unknown[] }).cancelOn : [];
      const matches = conditions.some((condition) => {
        if (!condition || typeof condition !== 'object') return false;
        const item = condition as { event?: unknown; field?: unknown; equals?: unknown };
        return item.event === eventName && (item.field === undefined || valueAt(item.field as string) === item.equals);
      });
      if (!matches) continue;
      const target = row.status === 'queued' ? 'cancelled' : 'cancel_requested';
      const changed = this.db.database.prepare("UPDATE runs SET status = ?, cancel_requested_at = ?, cancel_reason = ? WHERE id = ? AND status = ?").run(target, at, `cancelOn: ${eventName}`, row.id, row.status);
      if (changed.changes !== 1) continue;
      new ContinuationRepository(this.db).cancelForRun(row.id, at);
      this.db.database.prepare("UPDATE workflow_tasks SET status = 'cancelled', ended_at = ? WHERE run_id = ? AND status IN ('queued', 'running')").run(at, row.id);
      new RunRepository(this.db).appendEvent({ runId: row.id, type: target === 'cancelled' ? 'run.cancelled' : 'run.cancel_requested', payload: { reason: 'cancelOn', eventName } });
    }
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

export interface StepMemoRecord extends SuccessfulStepRecord {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly error?: unknown;
}

export class StepRepository {
  constructor(private readonly db: OrchardDatabase) {}

  getSuccessful(runId: string, stepId: string): SuccessfulStepRecord | undefined {
    const row = this.db.database.prepare("SELECT id AS stepRunId, step_id AS stepId, output_ref AS outputRef FROM step_runs WHERE run_id = ? AND step_instance_key = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1").get(runId, stepId) as { stepRunId: string; stepId: string; outputRef?: string | null } | undefined;
    if (!row) return undefined;
    return { stepRunId: row.stepRunId, stepId: row.stepId, output: row.outputRef === null || row.outputRef === undefined ? undefined : JSON.parse(row.outputRef) };
  }

  getMemoized(runId: string, stepId: string): StepMemoRecord | undefined {
    const row = this.db.database.prepare("SELECT s.id AS stepRunId, s.step_id AS stepId, s.status, s.output_ref AS outputRef, (SELECT a.error_json FROM step_attempts a WHERE a.step_run_id = s.id ORDER BY a.attempt_no DESC LIMIT 1) AS errorJson FROM step_runs s WHERE s.run_id = ? AND s.step_instance_key = ? AND s.status IN ('succeeded', 'failed', 'cancelled') ORDER BY s.created_at DESC LIMIT 1").get(runId, stepId) as { stepRunId: string; stepId: string; status: StepMemoRecord["status"]; outputRef?: string | null; errorJson?: string | null } | undefined;
    if (!row) return undefined;
    return { stepRunId: row.stepRunId, stepId: row.stepId, status: row.status, output: row.outputRef == null ? undefined : JSON.parse(row.outputRef), ...(row.errorJson == null ? {} : { error: JSON.parse(row.errorJson) }) };
  }

  listAttempts(runId: string, stepId?: string): readonly unknown[] {
    const sql = stepId
      ? "SELECT a.id AS attemptId, s.id AS stepRunId, s.step_id AS stepId, a.attempt_no AS attemptNo, a.status, a.input_ref AS inputRef, a.output_ref AS outputRef, a.error_json AS errorJson, a.started_at AS startedAt, a.ended_at AS endedAt FROM step_attempts a JOIN step_runs s ON s.id = a.step_run_id WHERE s.run_id = ? AND s.step_id = ? ORDER BY a.created_at"
      : "SELECT a.id AS attemptId, s.id AS stepRunId, s.step_id AS stepId, a.attempt_no AS attemptNo, a.status, a.input_ref AS inputRef, a.output_ref AS outputRef, a.error_json AS errorJson, a.started_at AS startedAt, a.ended_at AS endedAt FROM step_attempts a JOIN step_runs s ON s.id = a.step_run_id WHERE s.run_id = ? ORDER BY a.created_at";
    return (stepId ? this.db.database.prepare(sql).all(runId, stepId) : this.db.database.prepare(sql).all(runId)).map((row) => { const value = row as Record<string, unknown>; return { ...value, ...(typeof value.inputRef === "string" ? { input: JSON.parse(value.inputRef) } : {}), ...(typeof value.outputRef === "string" ? { output: JSON.parse(value.outputRef) } : {}), ...(typeof value.errorJson === "string" ? { error: JSON.parse(value.errorJson) } : {}) }; });
  }

  beginStep(input: { runId: string; stepId: string; nodeType: string; nodeVersion: string; config: unknown; value: unknown }): StepAttemptRecord {
    this.db.database.exec("SAVEPOINT begin_step");
    try {
      const prior = this.db.database.prepare("SELECT id, status FROM step_runs WHERE run_id = ? AND step_instance_key = ?").get(input.runId, input.stepId) as { id: string; status: string } | undefined;
      if (prior && prior.status !== 'failed') throw new Error(`Step is not retryable: ${prior.status}`);
      const stepRunId = prior?.id ?? uuidv7(), attemptId = uuidv7(), timestamp = now();
      const value = json(input.value ?? null), config = json(input.config ?? null);
      if (prior) this.db.database.prepare("UPDATE step_runs SET status = 'running', ended_at = NULL, started_at = ? WHERE id = ?").run(timestamp, stepRunId);
      else this.db.database.prepare("INSERT INTO step_runs (id, run_id, step_id, step_instance_key, node_type, node_version, config_snapshot_ref, status, input_ref, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)").run(stepRunId, input.runId, input.stepId, input.stepId, input.nodeType, input.nodeVersion, config, value, timestamp, timestamp);
      const attemptNo = (this.db.database.prepare("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM step_attempts WHERE step_run_id = ?").get(stepRunId) as { n: number }).n;
      this.db.database.prepare("INSERT INTO step_attempts (id, step_run_id, attempt_no, status, input_ref, created_at, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?)").run(attemptId, stepRunId, attemptNo, value, timestamp, timestamp);
      new RunRepository(this.db).appendEvent({ runId: input.runId, stepId: input.stepId, attemptId, type: 'step.started', payload: { attemptNo } });
      this.db.database.exec("RELEASE begin_step");
      return { stepRunId, attemptId, attemptNo };
    } catch (error) { this.db.database.exec("ROLLBACK TO begin_step; RELEASE begin_step"); throw error; }
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
      const step = this.db.database.prepare("SELECT run_id AS runId, step_id AS stepId FROM step_runs WHERE id = ?").get(input.stepRunId) as { runId: string; stepId: string };
      new RunRepository(this.db).appendEvent({ ...step, attemptId: input.attemptId, type: `step.${input.status}`, ...(input.error === undefined ? {} : { payload: { error: input.error } }) });
      this.db.database.exec("COMMIT;");
    } catch (error) { this.db.database.exec("ROLLBACK;"); throw error; }
  }
}

export class RunRepository {
  constructor(private readonly db: OrchardDatabase) {}

  createRunForWorkflow(input: { workflowId: string; workflowVersionId?: string; inputRef?: string; retryOfRunId?: string; triggerId?: string; idempotencyKey?: string }): RunRecord {
    if (!input.workflowVersionId && input.idempotencyKey) {
      const bound = this.db.database.prepare("SELECT r.workflow_version_id AS versionId FROM idempotency_keys k JOIN runs r ON r.id = k.resource_id JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE k.key = ? AND k.operation = 'create-run' AND v.workflow_id = ?").get(input.idempotencyKey, input.workflowId) as { versionId: string } | undefined;
      if (bound) return this.createRun({ ...input, workflowVersionId: bound.versionId });
    }
    const row = input.workflowVersionId
      ? this.db.database.prepare("SELECT id FROM workflow_versions WHERE id = ? AND workflow_id = ?").get(input.workflowVersionId, input.workflowId) as { id: string } | undefined
      : this.db.database.prepare("SELECT current_version_id AS id FROM workflows WHERE id = ? AND status = 'active' AND current_version_id IS NOT NULL").get(input.workflowId) as { id?: string } | undefined;
    if (!row?.id) { const error = new Error("WORKFLOW_NOT_FOUND"); error.name = "WORKFLOW_NOT_FOUND"; throw error; }
    return this.createRun({ ...input, workflowVersionId: row.id });
  }

  createRun(input: { workflowVersionId: string; inputRef?: string; retryOfRunId?: string; triggerId?: string; idempotencyKey?: string }): RunRecord {
    this.db.database.exec('SAVEPOINT create_run');
    try {
    const requestHash = createHash("sha256").update(JSON.stringify({ workflowVersionId: input.workflowVersionId, inputRef: input.inputRef ?? null, retryOfRunId: input.retryOfRunId ?? null, triggerId: input.triggerId ?? null })).digest("hex");
    if (input.idempotencyKey) {
      const existing = this.db.database.prepare("SELECT request_hash AS requestHash, resource_id AS resourceId FROM idempotency_keys WHERE key = ? AND operation = 'create-run'").get(input.idempotencyKey) as { requestHash: string; resourceId: string } | undefined;
      if (existing) {
        if (existing.requestHash !== requestHash) { const error = new Error("IDEMPOTENCY_CONFLICT"); error.name = "IDEMPOTENCY_CONFLICT"; throw error; }
        const prior = this.getRun(existing.resourceId);
        if (prior) { this.db.database.exec('RELEASE create_run'); return prior; }
      }
    }
    const definition = this.db.database.prepare("SELECT w.status FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE v.id = ?").get(input.workflowVersionId);
    if (!definition || definition.status === 'deleted') throw new Error("WORKFLOW_NOT_FOUND");
    const id = uuidv7();
    const inputRef = input.inputRef;
    this.db.database.prepare("INSERT INTO runs (id, workflow_version_id, trigger_id, retry_of_run_id, status, input_ref, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)").run(
      id, input.workflowVersionId, input.triggerId ?? null, input.retryOfRunId ?? null, inputRef ?? null, now(),
    );
    if (input.idempotencyKey) this.db.database.prepare("INSERT INTO idempotency_keys (key, operation, request_hash, resource_id, created_at) VALUES (?, 'create-run', ?, ?, ?)").run(input.idempotencyKey, requestHash, id, now());
    this.db.database.exec('RELEASE create_run');
    return { id, workflowVersionId: input.workflowVersionId, status: "queued", ...(inputRef === undefined ? {} : { inputRef }) };
    } catch (error) { this.db.database.exec('ROLLBACK TO create_run; RELEASE create_run'); throw error; }
  }

  createChildRun(input: { parentRunId: string; parentStepKey: string; workflowVersionId: string; inputRef?: string; idempotencyKey: string }): RunRecord {
    const existing = this.db.database.prepare("SELECT child_run_id AS childRunId FROM run_links WHERE idempotency_key = ?").get(input.idempotencyKey) as { childRunId: string } | undefined;
    if (existing) return this.getRun(existing.childRunId)!;
    this.db.database.exec('SAVEPOINT create_child');
    try {
    const child = this.createRun({ workflowVersionId: input.workflowVersionId, ...(input.inputRef === undefined ? {} : { inputRef: input.inputRef }), idempotencyKey: `child:${input.idempotencyKey}` });
    this.db.database.prepare("INSERT INTO run_links (parent_run_id, parent_step_key, child_run_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)").run(input.parentRunId, input.parentStepKey, child.id, input.idempotencyKey, now());
    this.appendEvent({ runId: input.parentRunId, type: "run.child_started", stepId: input.parentStepKey, payload: { childRunId: child.id } });
    this.db.database.exec('RELEASE create_child');
    return child;
    } catch (error) { this.db.database.exec('ROLLBACK TO create_child; RELEASE create_child'); throw error; }
  }

  completeChildRun(childRunId: string, status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">): boolean {
    const link = this.db.database.prepare("SELECT parent_run_id AS parentRunId, parent_step_key AS parentStepKey FROM run_links WHERE child_run_id = ?").get(childRunId) as { parentRunId: string; parentStepKey: string } | undefined;
    if (!link) return false;
    const changed = this.db.database.prepare("UPDATE run_links SET status = ? WHERE child_run_id = ? AND status = 'running'").run(status, childRunId);
    if (changed.changes === 1) this.appendEvent({ runId: link.parentRunId, type: `run.child_${status}`, stepId: link.parentStepKey, payload: { childRunId } });
    return changed.changes === 1;
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
    const result = this.db.database.prepare("UPDATE runs SET status = 'queued', claim_owner = NULL, claim_until = NULL WHERE status = 'running' AND claim_until IS NOT NULL AND claim_until <= ? AND NOT EXISTS (SELECT 1 FROM workflow_tasks t WHERE t.run_id = runs.id AND t.status = 'running')").run(nowMs);
    return Number(result.changes);
  }

  getRun(id: string): RunRecord | undefined {
    return this.db.database.prepare("SELECT id, workflow_version_id AS workflowVersionId, status, input_ref AS inputRef, created_at AS createdAt FROM runs WHERE id = ?").get(id) as unknown as RunRecord | undefined;
  }

  requestCancel(id: string, reason: string): boolean {
    const row = this.getRun(id);
    if (!row || ["succeeded", "failed", "cancelled", "interrupted", "needs_review"].includes(row.status)) return false;
    const target: RunStatus = row.status === "queued" ? "cancelled" : "cancel_requested";
    new ContinuationRepository(this.db).cancelForRun(id);
    assertRunTransition(row.status as RunStatus, target);
    const result = this.db.database.prepare("UPDATE runs SET status = ?, cancel_requested_at = ?, cancel_reason = ? WHERE id = ? AND status = ?").run(target, now(), reason, id, row.status);
    this.appendEvent({ runId: id, type: target === "cancelled" ? "run.cancelled" : "run.cancel_requested", payload: { reason } });
    if (result.changes === 1) {
      this.db.database.prepare("UPDATE task_attempts SET status = 'cancelled', ended_at = ? WHERE status = 'running' AND task_id IN (SELECT id FROM workflow_tasks WHERE run_id = ?)").run(now(), id);
      this.db.database.prepare('DELETE FROM task_leases WHERE task_id IN (SELECT id FROM workflow_tasks WHERE run_id = ?)').run(id);
      const tasksCancelled = this.db.database.prepare("UPDATE workflow_tasks SET status = 'cancelled', ended_at = ? WHERE run_id = ? AND status IN ('queued', 'running')").run(now(), id);
      if (tasksCancelled.changes > 0 || ['sleeping', 'waiting', 'retrying'].includes(row.status)) this.finish(id, 'cancelled');
    }
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

  listRuns(limit = 50, offset = 0, filter: { workflowId?: string; workflowVersionId?: string; status?: string; triggerId?: string; since?: number; until?: number } = {}): readonly RunRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid pagination");
    const clauses = ["1 = 1"]; const args: (string | number)[] = [];
    if (filter.workflowId) { clauses.push('workflow_version_id IN (SELECT id FROM workflow_versions WHERE workflow_id = ?)'); args.push(filter.workflowId); }
    if (filter.workflowVersionId) { clauses.push("workflow_version_id = ?"); args.push(filter.workflowVersionId); }
    if (filter.status) { clauses.push("status = ?"); args.push(filter.status); }
    if (filter.triggerId) { clauses.push("trigger_id = ?"); args.push(filter.triggerId); }
    if (filter.since !== undefined) { clauses.push("created_at >= ?"); args.push(filter.since); }
    if (filter.until !== undefined) { clauses.push("created_at <= ?"); args.push(filter.until); }
    args.push(limit, offset);
    return this.db.database.prepare(`SELECT id, workflow_version_id AS workflowVersionId, status, input_ref AS inputRef, created_at AS createdAt FROM runs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args) as unknown as RunRecord[];
  }

  rerunFromStep(runId: string, stepId: string): RunRecord {
    const original = this.getRun(runId);
    if (!original) throw new Error("RUN_NOT_FOUND");
    const order = [...new Set(this.listEvents(runId).filter(event => event.type === 'step.started' || event.type === 'step.memoized').map(event => event.stepId).filter((id): id is string => id !== undefined))];
    const boundary = order.indexOf(stepId);
    if (boundary < 0) throw new Error("REPLAY_LINEAGE_NOT_FOUND");
    this.db.database.exec("SAVEPOINT replay_run");
    try {
      const replay = this.createRun({ workflowVersionId: original.workflowVersionId, ...(original.inputRef === undefined ? {} : { inputRef: original.inputRef }), retryOfRunId: runId });
      for (const predecessor of order.slice(0, boundary)) {
        const changed = this.db.database.prepare("INSERT INTO step_runs (id, run_id, step_id, step_instance_key, node_type, node_version, config_snapshot_ref, status, input_ref, output_ref, created_at, started_at, ended_at) SELECT ?, ?, step_id, step_instance_key, node_type, node_version, config_snapshot_ref, status, input_ref, output_ref, created_at, started_at, ended_at FROM step_runs WHERE run_id = ? AND step_instance_key = ? AND status = 'succeeded'").run(uuidv7(), replay.id, runId, predecessor);
        if (changed.changes === 1) this.appendEvent({ runId: replay.id, stepId: predecessor, type: 'step.memoized', payload: { sourceRunId: runId } });
      }
      this.appendEvent({ runId: replay.id, type: "run.replayed", payload: { sourceRunId: runId, fromStepId: stepId, boundarySequence: boundary } });
      this.db.database.exec("RELEASE replay_run");
      return replay;
    } catch (error) { this.db.database.exec("ROLLBACK TO replay_run; RELEASE replay_run"); throw error; }
  }

  listEvents(runId: string): readonly { id: string; sequenceNo: number; type: string; stepId?: string; attemptId?: string; payload?: unknown; createdAt: number }[] {
    return this.db.database.prepare("SELECT id, sequence_no AS sequenceNo, event_type AS type, step_id AS stepId, attempt_id AS attemptId, payload_json AS payload, created_at AS createdAt FROM run_events WHERE run_id = ? ORDER BY sequence_no").all(runId).map((row) => { const value = row as { id: string; sequenceNo: number; type: string; stepId?: string | null; attemptId?: string | null; payload?: string | null; createdAt: number }; return { id: value.id, sequenceNo: value.sequenceNo, type: value.type, ...(value.stepId ? { stepId: value.stepId } : {}), ...(value.attemptId ? { attemptId: value.attemptId } : {}), ...(value.payload === null || value.payload === undefined ? {} : { payload: JSON.parse(value.payload) }), createdAt: value.createdAt }; });
  }

  trace(runId: string): readonly { stepId?: string; attemptId?: string; type: string; status?: string; startedAt?: number; endedAt?: number; durationMs?: number; error?: unknown }[] {
    const events = this.listEvents(runId);
    const byStep = new Map<string, { stepId?: string; attemptId?: string; type: string; status?: string; startedAt?: number; endedAt?: number; durationMs?: number; error?: unknown }>();
    for (const event of events) {
      if (!event.stepId) continue;
      const current = byStep.get(event.stepId) ?? { stepId: event.stepId, type: event.type };
      current.type = event.type;
      if (event.type.endsWith("started") || event.type.endsWith("running")) current.startedAt ??= event.createdAt;
      if (event.type.endsWith("succeeded") || event.type.endsWith("failed") || event.type.endsWith("cancelled")) { current.endedAt = event.createdAt; const status = event.type.split(".").at(-1); if (status) current.status = status; if (event.payload && typeof event.payload === "object" && "error" in event.payload) current.error = (event.payload as { error: unknown }).error; }
      if (current.startedAt !== undefined && current.endedAt !== undefined) current.durationMs = current.endedAt - current.startedAt;
      byStep.set(event.stepId, current);
    }
    return [...byStep.values()];
  }

  recordSchedulingDecision(input: { runId?: string; triggerId?: string; decision: string; reason: string; policyKey?: string; retryAt?: number }): string {
    const id = uuidv7();
    this.db.database.prepare("INSERT INTO scheduling_decisions (id, run_id, trigger_id, decision, reason, policy_key, retry_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.runId ?? null, input.triggerId ?? null, input.decision, input.reason, input.policyKey ?? null, input.retryAt ?? null, now());
    if (input.runId) this.appendEvent({ runId: input.runId, type: `schedule.${input.decision}`, payload: { reason: input.reason, ...(input.policyKey === undefined ? {} : { policyKey: input.policyKey }), ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }), decisionId: id } });
    return id;
  }

  listSchedulingDecisions(runId?: string): readonly { id: string; runId?: string; decision: string; reason: string; policyKey?: string; retryAt?: number; createdAt: number }[] {
    const rows = runId ? this.db.database.prepare("SELECT id, run_id AS runId, decision, reason, policy_key AS policyKey, retry_at AS retryAt, created_at AS createdAt FROM scheduling_decisions WHERE run_id = ? ORDER BY created_at, id").all(runId) : this.db.database.prepare("SELECT id, run_id AS runId, decision, reason, policy_key AS policyKey, retry_at AS retryAt, created_at AS createdAt FROM scheduling_decisions ORDER BY created_at, id").all();
    return (rows as Record<string, unknown>[]).map((row) => ({ id: row.id as string, ...(row.runId == null ? {} : { runId: row.runId as string }), decision: row.decision as string, reason: row.reason as string, ...(row.policyKey == null ? {} : { policyKey: row.policyKey as string }), ...(row.retryAt == null ? {} : { retryAt: row.retryAt as number }), createdAt: row.createdAt as number }));
  }

  appendEvent(input: { runId: string; type: string; stepId?: string; attemptId?: string; payload?: unknown }): number {
    const sequence = this.db.database.prepare("SELECT COALESCE(MAX(sequence_no), 0) + 1 AS sequence_no FROM run_events WHERE run_id = ?").get(input.runId) as { sequence_no: number };
    this.db.database.prepare("INSERT INTO run_events (id, run_id, sequence_no, step_id, attempt_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      uuidv7(), input.runId, sequence.sequence_no, input.stepId ?? null, input.attemptId ?? null, input.type, input.payload === undefined ? null : json(input.payload), now(),
    );
    return sequence.sequence_no;
  }
}
