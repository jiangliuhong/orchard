import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { AppError, check } from "../domain/errors.js";
import { configCoordinator } from "../config-git/coordinator.js";
import { canonicalJson, digest } from "../persistence/files.js";
import type { Store } from "../persistence/store.js";
import { assertQuerySafe } from "./query-gateway.js";
import { assertProposalInput, assertTarget, MAINTENANCE_CONTRACT, type MaintenanceTarget } from "./maintenance-protocol.js";
import type { MaintenanceBusinessHost } from "./maintenance-assets.js";
import { markWorkspaceDirty, projectionState, requireWorkspaceSchema } from "./workspace-state.js";
import { assertMaintenanceOwnerAvailable } from "./workspace-business-hooks.js";

export type MaintenanceAction = "read" | "submit" | "confirm" | "revoke" | "apply";
export interface MaintenanceBoundary {
  /** Synchronous local policy is checked again inside the final transaction.
   * Do not supply an async function: pending authorization must never authorize. */
  authorize(actor: string, target: MaintenanceTarget, action: MaintenanceAction): void;
  knownSecrets(): readonly string[];
  /** Must prove Provider/MCP processes and all file reads stopped, not just sent
   * abort/kill. A database task status is not a process-exit proof. */
  assertQuiescent(): void;
  synchronize(signal: AbortSignal): Promise<void>;
}
/** A failed real stop check is durable even if no DB task happens to be active.
 * Never let a retry or an empty task table silently authorize page writes. */
export function assertMaintenanceQuiescent(store: Store, boundary: Pick<MaintenanceBoundary, "assertQuiescent">): void {
  try {
    const result: unknown = boundary.assertQuiescent();
    if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
    check(result === undefined, "PROCESS_STOP_UNCONFIRMED", "维护进程和读取资源退出尚未确认", 409);
  } catch {
    store.exec("UPDATE agent_workspace_projection_state SET state='failed',error_code='PROCESS_STOP_UNCONFIRMED',updated_at=? WHERE id='maintenance'", Date.now());
    throw new AppError("PROCESS_STOP_UNCONFIRMED", "维护进程和读取资源退出尚未确认", 409);
  }
}
interface Session { id: string; actor_key: string; owner_kind: MaintenanceTarget["kind"]; owner_id: string; owner_scope_json: string; generation: number; lifecycle: string; contract_version: string }
interface Task { id: string; session_id: string; generation: number; baseline_json: string; status: string }
interface Proposal {
  id: string; actor_key: string; session_id: string; task_id: string; submit_request_hash: string; contract_version: string;
  target_kind: MaintenanceTarget["kind"]; target_id: string; target_scope_json: string; baseline_json: string; body_json: string; before_json: string;
  content_hash: string; diff_hash: string; state: string; created_at: number; expires_at: number;
}
interface Decision { id: string; proposal_id: string; action: string; content_hash: string; diff_hash: string; valid_until: number | null }
interface ApplyRequest { id: string; actor_key: string; proposal_id: string; confirmation_id: string; request_hash: string; state: string; target_generation: number | null; result_json: string | null; error_code: string | null }
const targetOf = (proposal: Pick<Proposal, "target_kind" | "target_id" | "target_scope_json">): MaintenanceTarget => ({ kind: proposal.target_kind, id: proposal.target_id, scope: JSON.parse(proposal.target_scope_json) }) as MaintenanceTarget;
const hashContent = (actor: string, target: MaintenanceTarget, baseline: unknown, before: unknown, body: unknown) => digest(canonicalJson({ actor, target, baseline, before, body, contractVersion: MAINTENANCE_CONTRACT }));
const requestId = (value: string) => check(typeof value === "string" && value.trim().length > 0 && value.length <= 200, "INVALID_REQUEST", "请求标识无效");
const active = "('queued','running','stopping')";
const day = 24 * 60 * 60 * 1000;
const retainedApplyScope = (actor: string) => `maintenance.apply:${digest(actor)}`;
interface RetainedApply extends ApplyRequest {
  request_id: string;
  contentHash: string;
  target: MaintenanceTarget;
}

/** Shared application service for page and controlled MCP entry points. No raw SQL,
 * host paths, confirmed:true, changed body, publish or execution tool is exposed. */
export class MaintenanceService {
  constructor(private readonly store: Store, private readonly business: MaintenanceBusinessHost, private readonly boundary: MaintenanceBoundary, private readonly now = Date.now) {
    requireWorkspaceSchema(store);
  }
  private authorize(actor: string, target: MaintenanceTarget, action: MaintenanceAction) {
    check(typeof actor === "string" && actor.trim().length > 0 && actor.length <= 200, "UNAUTHORIZED", "维护身份无效", 403);
    assertTarget(target);
    const result: unknown = this.boundary.authorize(actor, target, action);
    if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
    check(result === undefined, "AUTHORIZATION_INVALID", "维护权限检查必须同步完成", 503);
  }
  /** Internal read authority for the task-bound file bridge, not a user RPC. */
  authorizeTaskRead(actor: string, sessionId: string, taskId: string): void {
    this.store.directoryLease.assert();
    const session = this.store.one<Session>("SELECT * FROM agent_maintenance_sessions WHERE id=? AND actor_key=?", sessionId, actor);
    const task = this.store.one<Task>("SELECT * FROM agent_maintenance_tasks WHERE id=? AND session_id=?", taskId, sessionId);
    check(session && task && session.lifecycle === "active" && session.generation === task.generation && ["queued", "running"].includes(task.status),
      "MAINTENANCE_AUTHORIZATION_REVOKED", "维护读取权限已失效", 403);
    assertMaintenanceOwnerAvailable(this.store, sessionId);
    this.authorize(actor, { kind: session.owner_kind, id: session.owner_id, scope: JSON.parse(session.owner_scope_json) } as MaintenanceTarget, "read");
  }
  /** Internal egress check for controlled transports; not an Agent tool. */
  assertToolResultSafe(value: unknown): void { this.safe(value); }
  private safe(value: unknown) { assertQuerySafe(value, [...this.boundary.knownSecrets(), this.store.root, homedir()]); }
  private quiescent(): void { assertMaintenanceQuiescent(this.store, this.boundary); }
  /** Internal worker entry: rebuild derived files, never business definitions.
   * The supplied synchronizer must authorize the complete projection itself. */
  async synchronizePending(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.store.one(`SELECT id FROM agent_maintenance_tasks WHERE status IN ${active} LIMIT 1`)) return;
    const state = projectionState(this.store);
    if (state.state === "ready" && state.synced_generation === state.target_generation) return;
    await configCoordinator(this.store).withWorkspaceSynchronization(async () => {
      this.quiescent(); signal.throwIfAborted();
      await this.boundary.synchronize(signal);
      this.quiescent(); signal.throwIfAborted();
    });
  }
  private proposal(actor: string, id: string): Proposal {
    const value = this.store.one<Proposal>("SELECT * FROM agent_maintenance_proposals WHERE id=? AND actor_key=?", id, actor);
    check(value, "NOT_FOUND", "提案不存在", 404);
    const target = targetOf(value), before = JSON.parse(value.before_json), body = JSON.parse(value.body_json), baseline = JSON.parse(value.baseline_json);
    check(value.contract_version === MAINTENANCE_CONTRACT && hashContent(actor, target, baseline, before, body) === value.content_hash &&
      digest(canonicalJson({ before, after: body.after })) === value.diff_hash, "PROPOSAL_CORRUPTED", "提案内容或 diff 摘要不一致", 409);
    return value;
  }
  view(actor: string, id: string) {
    const proposal = this.proposal(actor, id), target = targetOf(proposal); this.authorize(actor, target, "read");
    const body = JSON.parse(proposal.body_json), before = JSON.parse(proposal.before_json);
    const value = { id: proposal.id, target, baseline: JSON.parse(proposal.baseline_json), summary: body.summary,
      contentHash: proposal.content_hash, diffHash: proposal.diff_hash, diff: { before, after: body.after },
      state: ["pending", "confirmed"].includes(proposal.state) && proposal.expires_at <= this.now() ? "expired" : proposal.state,
      createdAt: proposal.created_at, expiresAt: proposal.expires_at };
    this.safe(value); return value;
  }
  list(actor: string, sessionId: string) {
    const session = this.store.one<Session>("SELECT * FROM agent_maintenance_sessions WHERE id=? AND actor_key=?", sessionId, actor);
    check(session, "NOT_FOUND", "维护会话不存在", 404);
    this.authorize(actor, { kind: session.owner_kind, id: session.owner_id, scope: JSON.parse(session.owner_scope_json) } as MaintenanceTarget, "read");
    // Metadata only, not 50 multi-megabyte source snapshots in a list response.
    return this.store.all<{ id: string; state: string; content_hash: string; diff_hash: string; created_at: number; expires_at: number }>(
      "SELECT id,state,content_hash,diff_hash,created_at,expires_at FROM agent_maintenance_proposals WHERE actor_key=? AND session_id=? ORDER BY created_at DESC,id LIMIT 50", actor, sessionId);
  }

  listForOwner(actor: string, kind: MaintenanceTarget["kind"], id: string) {
    const workflow = kind === "workflow_draft";
    const rows = this.store.all<Pick<Proposal, "id" | "target_kind" | "target_id" | "target_scope_json" | "state" | "created_at" | "expires_at">>(
      `SELECT id,target_kind,target_id,target_scope_json,state,created_at,expires_at FROM agent_maintenance_proposals
       WHERE actor_key=? AND target_kind=? AND ${workflow ? "json_extract(target_scope_json,'$.draftId')" : "target_id"}=?
       ORDER BY created_at DESC,id LIMIT 50`, actor, kind, id);
    return rows.map(row => {
      this.authorize(actor, targetOf(row), "read");
      return { id: row.id, state: ["pending", "confirmed"].includes(row.state) && row.expires_at <= this.now() ? "expired" : row.state, createdAt: row.created_at };
    });
  }

  async submit(actor: string, sessionId: string, taskId: string, input: unknown, signal: AbortSignal) {
    assertProposalInput(input); signal.throwIfAborted();
    check(Buffer.byteLength(canonicalJson(input)) <= 8 * 1024 * 1024, "PROPOSAL_TOO_LARGE", "提案请求超过 8 MiB");
    this.authorize(actor, input.target, "submit");
    const submittedHash = digest(canonicalJson({ sessionId, taskId, input }));
    const existing = this.store.one<Proposal>("SELECT * FROM agent_maintenance_proposals WHERE actor_key=? AND submit_request_id=?", actor, input.requestId);
    if (existing) { check(existing.submit_request_hash === submittedHash, "REQUEST_CONFLICT", "请求标识已用于另一份提案", 409); return this.view(actor, existing.id); }
    return configCoordinator(this.store).withRead(async () => {
      const session = this.store.one<Session>("SELECT * FROM agent_maintenance_sessions WHERE id=? AND actor_key=?", sessionId, actor);
      const task = this.store.one<Task>("SELECT * FROM agent_maintenance_tasks WHERE id=? AND session_id=?", taskId, sessionId);
      check(session && task && session.lifecycle === "active" && session.generation === task.generation && ["queued", "running"].includes(task.status), "MAINTENANCE_AUTHORIZATION_REVOKED", "维护任务已失效", 403);
      assertMaintenanceOwnerAvailable(this.store, sessionId);
      check(session.contract_version === MAINTENANCE_CONTRACT && canonicalJson(input.target) === canonicalJson({ kind: session.owner_kind, id: session.owner_id, scope: JSON.parse(session.owner_scope_json) }), "PROPOSAL_TARGET_MISMATCH", "提案不属于当前固定维护对象", 403);
      const snapshot = this.business.capture(input.target);
      check(canonicalJson(snapshot.baseline) === canonicalJson(input.baseline) && canonicalJson(input.baseline) === task.baseline_json, "REVISION_CONFLICT", "提案基线不是当前任务读取的基线", 409);
      // Reject sensitive source before preparing any immutable artifact, not only
      // after a failed proposal has already written its candidate to disk.
      this.safe(snapshot.before); this.safe(input.change);
      const prepared = await this.business.prepare(input.target, input.change, snapshot); signal.throwIfAborted();
      this.authorize(actor, input.target, "submit");
      check(canonicalJson(this.business.capture(input.target).baseline) === canonicalJson(snapshot.baseline), "REVISION_CONFLICT", "校验期间资源已变化", 409);
      const body = { summary: input.summary, change: prepared.change, after: prepared.after };
      this.safe(snapshot.before); this.safe(body);
      check(Buffer.byteLength(canonicalJson(snapshot.before)) <= 8 * 1024 * 1024 && Buffer.byteLength(canonicalJson(body)) <= 8 * 1024 * 1024, "PROPOSAL_TOO_LARGE", "提案快照或正文超过预算");
      const contentHash = hashContent(actor, input.target, snapshot.baseline, snapshot.before, body), diffHash = digest(canonicalJson({ before: snapshot.before, after: prepared.after }));
      const id = this.store.transaction(() => {
        const currentTask = this.store.one<Task>("SELECT * FROM agent_maintenance_tasks WHERE id=? AND session_id=?", taskId, sessionId);
        check(currentTask && ["queued", "running"].includes(currentTask.status), "MAINTENANCE_AUTHORIZATION_REVOKED", "维护任务已结束", 403);
        assertMaintenanceOwnerAvailable(this.store, sessionId);
        const replay = this.store.one<Proposal>("SELECT * FROM agent_maintenance_proposals WHERE actor_key=? AND submit_request_id=?", actor, input.requestId);
        if (replay) { check(replay.submit_request_hash === submittedHash, "REQUEST_CONFLICT", "请求标识已使用", 409); return replay.id; }
        const usage = this.store.one<{ count: number; bytes: number }>("SELECT sum(CASE WHEN state IN ('pending','confirmed') AND expires_at>? THEN 1 ELSE 0 END) AS count,coalesce(sum(length(CAST(body_json AS BLOB))+length(CAST(before_json AS BLOB))),0) AS bytes FROM agent_maintenance_proposals WHERE actor_key=?", this.now(), actor)!;
        check(Number(usage.count) < 20 && Number(usage.bytes) + Buffer.byteLength(canonicalJson(body)) + Buffer.byteLength(canonicalJson(snapshot.before)) <= 256 * 1024 * 1024, "PROPOSAL_BUDGET_EXCEEDED", "未处理提案或存储预算已达到上限", 409);
        const id = randomUUID(), now = this.now();
        this.store.exec(`INSERT INTO agent_maintenance_proposals(id,actor_key,session_id,task_id,submit_request_id,submit_request_hash,contract_version,target_kind,target_id,target_scope_json,baseline_json,body_json,before_json,content_hash,diff_hash,state,created_at,expires_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`, id, actor, sessionId, taskId, input.requestId, submittedHash, MAINTENANCE_CONTRACT, input.target.kind, input.target.id, canonicalJson(input.target.scope), canonicalJson(snapshot.baseline), canonicalJson(body), canonicalJson(snapshot.before), contentHash, diffHash, now, now + 7 * 86400000);
        return id;
      });
      return this.view(actor, id);
    });
  }

  /** User HTTP route only. Deliberately not exposed by the MCP tool dispatcher. */
  decideByUser(actor: string, id: string, action: "confirm" | "revoke", contentHash: string, diffHash: string, idempotencyKey: string) {
    requestId(idempotencyKey);
    return this.store.transaction(() => {
      const proposal = this.proposal(actor, id); this.authorize(actor, targetOf(proposal), action);
      if (action === "confirm") assertMaintenanceOwnerAvailable(this.store, proposal.session_id);
      check(proposal.content_hash === contentHash && proposal.diff_hash === diffHash, "PROPOSAL_CHANGED", "确认的提案或 diff 不匹配", 409);
      const prior = this.store.one<Decision>("SELECT * FROM agent_maintenance_decisions WHERE actor_key=? AND request_id=?", actor, idempotencyKey);
      if (prior) { check(prior.proposal_id === id && prior.action === action && prior.content_hash === contentHash && prior.diff_hash === diffHash, "REQUEST_CONFLICT", "用户决定请求标识已使用", 409); return this.view(actor, id); }
      check(proposal.expires_at > this.now() && (action === "confirm" ? proposal.state === "pending" : ["pending", "confirmed"].includes(proposal.state)), "PROPOSAL_NOT_APPLICABLE", "提案已过期、撤销或应用，不能执行该决定", 409);
      const now = this.now();
      this.store.exec("INSERT INTO agent_maintenance_decisions(id,proposal_id,actor_key,request_id,action,content_hash,diff_hash,created_at,valid_until) VALUES(?,?,?,?,?,?,?,?,?)", randomUUID(), id, actor, idempotencyKey, action, contentHash, diffHash, now, action === "confirm" ? Math.min(proposal.expires_at, now + 86400000) : null);
      this.store.exec("UPDATE agent_maintenance_proposals SET state=? WHERE id=?", action === "confirm" ? "confirmed" : "revoked", id);
      return this.view(actor, id);
    });
  }
  enqueue(actor: string, proposalId: string, idempotencyKey: string) {
    requestId(idempotencyKey);
    const retained = this.store.one<{ result_json: string; request_hash: string }>(
      "SELECT result_json,request_hash FROM command_receipts WHERE scope=? AND request_id=?", retainedApplyScope(actor), idempotencyKey);
    if (retained) {
      const row: RetainedApply = JSON.parse(retained.result_json);
      this.authorize(actor, row.target, "apply");
      check(row.proposal_id === proposalId && retained.request_hash === digest(canonicalJson({ proposalId, contentHash: row.contentHash })),
        "REQUEST_CONFLICT", "应用请求标识已使用", 409);
      return this.applyReceipt(row);
    }
    const proposal = this.proposal(actor, proposalId); this.authorize(actor, targetOf(proposal), "apply");
    const hash = digest(canonicalJson({ proposalId, contentHash: proposal.content_hash }));
    const prior = this.store.one<ApplyRequest>("SELECT * FROM agent_maintenance_apply_requests WHERE actor_key=? AND request_id=?", actor, idempotencyKey);
    if (prior) { check(prior.request_hash === hash, "REQUEST_CONFLICT", "应用请求标识已使用", 409); return this.receipt(actor, prior.id); }
    const id = this.store.transaction(() => {
      assertMaintenanceOwnerAvailable(this.store, proposal.session_id);
      check(proposal.state === "confirmed" && proposal.expires_at > this.now(), "CONFIRMATION_REQUIRED", "提案尚未获用户确认或已失效", 409);
      const confirmation = this.store.one<Decision>("SELECT * FROM agent_maintenance_decisions WHERE proposal_id=? AND actor_key=? AND action='confirm'", proposalId, actor);
      check(confirmation && Number(confirmation.valid_until) > this.now() && !this.store.one("SELECT id FROM agent_maintenance_decisions WHERE proposal_id=? AND action='revoke'", proposalId), "CONFIRMATION_REQUIRED", "用户确认缺失、过期或已撤销", 409);
      const id = randomUUID(), now = this.now();
      this.store.exec("INSERT INTO agent_maintenance_apply_requests(id,proposal_id,confirmation_id,actor_key,request_id,request_hash,state,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',0,?,?)", id, proposalId, confirmation.id, actor, idempotencyKey, hash, now, now); return id;
    });
    return this.receipt(actor, id);
  }
  receipt(actor: string, id: string) {
    const row = this.store.one<ApplyRequest>("SELECT * FROM agent_maintenance_apply_requests WHERE id=? AND actor_key=?", id, actor);
    if (!row) {
      const retained = this.store.one<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE scope=? AND json_extract(result_json,'$.id')=?", retainedApplyScope(actor), id);
      check(retained, "NOT_FOUND", "应用回执不存在", 404);
      const application: RetainedApply = JSON.parse(retained.result_json);
      this.authorize(actor, application.target, "read");
      return this.applyReceipt(application);
    }
    const proposal = this.proposal(actor, row.proposal_id); this.authorize(actor, targetOf(proposal), "read");
    return this.applyReceipt(row);
  }

  private applyReceipt(row: ApplyRequest) {
    const projection = projectionState(this.store);
    return { id: row.id, proposalId: row.proposal_id, status: row.state === "applied" && (projection.state !== "ready" || projection.synced_generation < row.target_generation!) ? "applied_projection_pending" : row.state,
      targetGeneration: row.target_generation, result: row.result_json ? JSON.parse(row.result_json) : null, errorCode: row.error_code,
      projection: { state: projection.state, targetGeneration: projection.target_generation, syncedGeneration: projection.synced_generation } };
  }

  private retentionCandidates(actor: string) {
    const auditCutoff = this.now() - 90 * day;
    const proposals = this.store.all<Pick<Proposal, "id" | "target_kind" | "target_id" | "target_scope_json" | "content_hash"> & { bytes: number }>(`
      SELECT p.id,p.target_kind,p.target_id,p.target_scope_json,p.content_hash,
        length(CAST(p.body_json AS BLOB))+length(CAST(p.before_json AS BLOB))+length(CAST(p.baseline_json AS BLOB)) AS bytes
      FROM agent_maintenance_proposals p
      WHERE p.actor_key=? AND p.expires_at<=?
        AND NOT EXISTS (SELECT 1 FROM agent_maintenance_decisions d WHERE d.proposal_id=p.id AND d.created_at>?)
        AND NOT EXISTS (SELECT 1 FROM agent_maintenance_apply_requests a WHERE a.proposal_id=p.id AND (a.settled_at IS NULL OR a.settled_at>?))
      ORDER BY p.id LIMIT 200`, actor, auditCutoff, auditCutoff, auditCutoff);
    const audits = proposals.map(proposal => {
      const target = { kind: proposal.target_kind, id: proposal.target_id, scope: JSON.parse(proposal.target_scope_json) } as MaintenanceTarget;
      this.authorize(actor, target, "apply");
      const applications = this.store.all<ApplyRequest & { request_id: string }>("SELECT * FROM agent_maintenance_apply_requests WHERE proposal_id=? ORDER BY id", proposal.id);
      const decisions = this.store.all<{ id: string }>("SELECT id FROM agent_maintenance_decisions WHERE proposal_id=? ORDER BY id", proposal.id);
      return { proposal, target, applications, decisions };
    });
    const displays = this.store.all<{ id: string; display_output_ref: string; owner_kind: Proposal["target_kind"]; owner_id: string; owner_scope_json: string }>(`
      SELECT t.id,t.display_output_ref,s.owner_kind,s.owner_id,s.owner_scope_json
      FROM agent_maintenance_tasks t JOIN agent_maintenance_sessions s ON s.id=t.session_id
      WHERE s.actor_key=? AND t.status NOT IN ${active} AND t.ended_at<=? AND t.display_output_ref IS NOT NULL
      ORDER BY t.id LIMIT 200`, actor, this.now() - 30 * day);
    for (const row of displays) this.authorize(actor, { kind: row.owner_kind, id: row.owner_id, scope: JSON.parse(row.owner_scope_json) } as MaintenanceTarget, "apply");
    const bytes = audits.reduce((total, item) => total + item.proposal.bytes + item.applications.reduce((sum, row) => sum + Buffer.byteLength(row.result_json ?? ""), 0), 0)
      + displays.reduce((total, row) => total + Buffer.byteLength(row.display_output_ref), 0);
    const preview = {
      proposals: audits.length, decisions: audits.reduce((n, item) => n + item.decisions.length, 0),
      applications: audits.reduce((n, item) => n + item.applications.length, 0), displays: displays.length,
      storedPayloadBytes: bytes, dependencies: { retainsTasks: true, retainsSessions: true, retainsApplyReceipts: true },
      hash: digest(canonicalJson({ actor, audits, displays })),
    };
    return { preview, audits, displays };
  }

  previewRetention(actor: string) { return this.retentionCandidates(actor).preview; }

  applyRetention(actor: string, expectedHash: string) {
    return configCoordinator(this.store).withWrite(() => {
      const projection = projectionState(this.store);
      check(projection.state === "ready" && projection.target_generation === projection.synced_generation &&
        !this.store.one(`SELECT id FROM agent_maintenance_tasks WHERE status IN ${active} LIMIT 1`) &&
        !this.store.one("SELECT id FROM agent_maintenance_apply_requests WHERE state='queued' LIMIT 1"),
      "WORKSPACE_BUSY", "维护任务、应用请求或投影同步尚未完成", 409);
      this.quiescent();
      return this.store.transaction(() => {
        const { preview, audits, displays } = this.retentionCandidates(actor);
        check(preview.hash === expectedHash, "PREVIEW_EXPIRED", "清理范围已变化，请重新预览", 409);
        for (const { proposal, target, applications } of audits) {
          for (const row of applications) {
            const retained: RetainedApply = { id: row.id, actor_key: row.actor_key, proposal_id: row.proposal_id,
              confirmation_id: "", request_id: row.request_id, request_hash: row.request_hash, state: row.state,
              target_generation: row.target_generation, result_json: row.result_json, error_code: row.error_code, target, contentHash: proposal.content_hash };
            this.store.exec("INSERT INTO command_receipts VALUES(?,?,?,?,?)", retainedApplyScope(actor), row.request_id, row.request_hash, canonicalJson(retained), this.now());
            this.store.exec("DELETE FROM agent_maintenance_apply_requests WHERE id=?", row.id);
          }
          this.store.exec("DELETE FROM agent_maintenance_proposals WHERE id=?", proposal.id);
        }
        for (const row of displays) this.store.exec("UPDATE agent_maintenance_tasks SET display_output_ref=NULL WHERE id=?", row.id);
        return preview;
      });
    });
  }

  async process(actor: string, id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const owned = this.store.one<ApplyRequest>("SELECT * FROM agent_maintenance_apply_requests WHERE id=? AND actor_key=?", id, actor);
    check(owned, "NOT_FOUND", "应用回执不存在", 404);
    const original = { proposalId: owned.proposal_id };
    if (owned.state !== "queued" || this.store.one(`SELECT id FROM agent_maintenance_tasks WHERE status IN ${active} LIMIT 1`)) return this.receipt(actor, id);
    try {
      if (projectionState(this.store).error_code === "PROCESS_STOP_UNCONFIRMED") {
        // A fresh real proof may resume a queued application; this only clears
        // the stop barrier to pending, NEVER makes old files readable/ready.
        this.quiescent(); signal.throwIfAborted();
        this.store.exec("UPDATE agent_workspace_projection_state SET state='pending',error_code=NULL,updated_at=? WHERE id='maintenance' AND error_code='PROCESS_STOP_UNCONFIRMED'", this.now());
      }
      return await configCoordinator(this.store).withMaintenanceApply(async () => {
        this.quiescent();
        const proposal = this.proposal(actor, original.proposalId), target = targetOf(proposal);
        assertMaintenanceOwnerAvailable(this.store, proposal.session_id);
        this.authorize(actor, target, "apply");
        check(proposal.state === "confirmed" && proposal.expires_at > this.now(), "PROPOSAL_NOT_APPLICABLE", "提案已失效", 409);
        const snapshot = this.business.capture(target);
        check(canonicalJson(snapshot.baseline) === proposal.baseline_json, "REVISION_CONFLICT", "资源已变化，请重新生成提案", 409);
        const body = JSON.parse(proposal.body_json);
        this.safe(snapshot.before); this.safe(body.change);
        const prepared = await this.business.prepare(target, body.change, snapshot);
        check(canonicalJson(prepared.after) === canonicalJson(body.after), "PROPOSAL_CHANGED", "重新校验得到不同的候选内容", 409);
        signal.throwIfAborted();
        this.authorize(actor, target, "apply");
        this.quiescent();
        this.store.transaction(() => {
          const row = this.store.one<ApplyRequest>("SELECT * FROM agent_maintenance_apply_requests WHERE id=? AND actor_key=?", id, actor)!;
          if (row.state !== "queued") return;
          assertMaintenanceOwnerAvailable(this.store, proposal.session_id);
          const current = this.proposal(actor, proposal.id), confirmation = this.store.one<Decision>("SELECT * FROM agent_maintenance_decisions WHERE id=?", row.confirmation_id);
          check(current.state === "confirmed" && current.expires_at > this.now() && confirmation && Number(confirmation.valid_until) > this.now() && !this.store.one("SELECT id FROM agent_maintenance_decisions WHERE proposal_id=? AND action='revoke'", proposal.id), "CONFIRMATION_REQUIRED", "用户确认已失效", 409);
          this.authorize(actor, target, "apply");
          check(canonicalJson(this.business.capture(target).baseline) === current.baseline_json, "REVISION_CONFLICT", "资源基线冲突", 409);
          const beforeGeneration = projectionState(this.store).target_generation;
          const result = prepared.commit(); this.safe(result);
          const generation = projectionState(this.store).target_generation === beforeGeneration ? markWorkspaceDirty(this.store) : projectionState(this.store).target_generation;
          const now = this.now();
          this.store.exec("UPDATE agent_maintenance_apply_requests SET state='applied',target_generation=?,result_json=?,error_code=NULL,updated_at=?,settled_at=? WHERE id=? AND state='queued'", generation, canonicalJson(result), now, now, id);
          this.store.exec("UPDATE agent_maintenance_proposals SET state='applied' WHERE id=?", proposal.id);
        });
        this.business.refresh();
        // Once committed, cancellation or filesystem failure cannot undo the
        // business receipt or cause the resource operation to run a second time.
        try { await configCoordinator(this.store).withWorkspaceSynchronization(() => this.boundary.synchronize(signal)); } catch { /* Durable pending generation is authoritative. */ }
        return this.receipt(actor, id);
      });
    } catch (error) {
      this.business.refresh();
      const row = this.store.one<ApplyRequest>("SELECT * FROM agent_maintenance_apply_requests WHERE id=? AND actor_key=?", id, actor);
      if (row?.state === "queued") this.store.transaction(() => {
        const conflict = error instanceof AppError && /REVISION_CONFLICT|OWNER_UNAVAILABLE|IDENTITY_CONFLICT|NOT_FOUND|RESOURCE_IN_USE|DEPENDENCY_/.test(error.code);
        const rejected = error instanceof AppError && (error.statusCode === 403 || /CONFIRMATION_REQUIRED|PROPOSAL_NOT_APPLICABLE|PROPOSAL_CHANGED|PROPOSAL_CORRUPTED|QUERY_SENSITIVE_CONTENT|INVALID_|SCHEMA_MISMATCH|SCRIPT_LIMIT/.test(error.code));
        const state = conflict ? "conflicted" : rejected ? "rejected" : "queued", code = error instanceof AppError ? error.code : "MAINTENANCE_PREPARE_FAILED", now = this.now();
        this.store.exec("UPDATE agent_maintenance_apply_requests SET state=?,error_code=?,result_json=?,settled_at=?,attempt_count=attempt_count+1,retry_at=?,updated_at=? WHERE id=? AND state='queued'", state, code, state === "queued" ? null : canonicalJson({ code }), state === "queued" ? null : now, state === "queued" ? now + 1000 : null, now, id);
        if (conflict) this.store.exec("UPDATE agent_maintenance_proposals SET state='conflicted' WHERE id=? AND state='confirmed'", original.proposalId);
      });
      return this.receipt(actor, id);
    }
  }
}
