import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { AppError, check } from "../domain/errors.js";
import { configCoordinator } from "../config-git/coordinator.js";
import { canonicalJson, digest } from "../persistence/files.js";
import type { Store } from "../persistence/store.js";
import type { MaintenanceBusinessHost } from "./maintenance-assets.js";
import { assertTarget, MAINTENANCE_CONTRACT, onlyKeys, type MaintenanceTarget } from "./maintenance-protocol.js";
import { validateSessionReference, type ReferenceValidator, type ProviderSessionReference } from "./provider-contract.js";
import { assertQuerySafe } from "./query-gateway.js";
import { projectionState, requireWorkspaceSchema } from "./workspace-state.js";
import { assertMaintenanceOwnerAvailable, maintenanceOwnerRetired, requireWorkspaceBusinessTracking } from "./workspace-business-hooks.js";

type Mode = "single" | "multi";
type Status = "queued" | "running" | "stopping" | "succeeded" | "failed" | "cancelled" | "interrupted";
interface Session {
  id: string; actor_key: string; scenario: string; owner_kind: MaintenanceTarget["kind"]; owner_id: string; owner_scope_json: string;
  mode: Mode; provider_id: string; model_id: string; contract_version: string; tool_policy_version: string; knowledge_hash: string;
  native_ref_json: string | null; native_ref_version: number | null; provider_fingerprint: string | null;
  generation: number; revision: number; lifecycle: string; native_delete_state: string; created_at: number; updated_at: number;
}
interface Task {
  id: string; session_id: string; mode: Mode; request_hash: string; sequence: number; generation: number;
  projection_generation: number; projection_hash: string; baseline_json: string; input_ref: string | null;
  display_output_ref: string | null; status: Status; process_state: string; error_code: string | null; created_at: number; started_at: number | null; ended_at: number | null;
}
export interface MaintenanceProcessBinding { taskId: string; sessionId: string; generation: number }
export interface MaintenanceBackendPolicy {
  fingerprint: string; knowledgeHash: string; toolPolicyVersion: string;
  /** Validator must bind the platform-managed history to this exact session owner,
   * not merely accept any provider-owned path or syntactically valid session ID. */
  references: ReferenceValidator;
}
export interface MaintenanceSessionBoundary {
  /** Whole-project permission, NOT a client assertion or just target ownership. */
  authorize(actor: string, target: MaintenanceTarget, action: "read" | "maintain"): void;
  /** Must reject unverified installations/modes and unavailable model choices.
   * Protocol declarations and tests are not CLI safety certification. */
  backend(providerId: string, modelId: string, mode: Mode, owner: { actor: string; sessionId: string; target: MaintenanceTarget }): MaintenanceBackendPolicy;
  /** Prove the entire Provider/MCP/read-resource tree stopped for THIS binding.
   * Include draining in-flight protocol callbacks before granting the proof.
   * Never implement using a client boolean, abort sent, DB status or guessed PID. */
  assertStopped(binding: MaintenanceProcessBinding): void;
  /** Revoke tool grants, file readers and dispatch/transport authority. */
  revokeTask(taskId: string): void;
  knownSecrets(): readonly string[];
}
// An internal capability, not a task ID or JSON token. Only claim() can mint one.
export interface MaintenanceTaskHandle { readonly taskId: string; readonly generation: number }
interface Claim extends MaintenanceProcessBinding { policy: MaintenanceBackendPolicy }
const active = (task: Task) => ["queued", "running", "stopping"].includes(task.status);
const targetOf = (session: Pick<Session, "owner_kind" | "owner_id" | "owner_scope_json">) => ({ kind: session.owner_kind, id: session.owner_id, scope: JSON.parse(session.owner_scope_json) }) as MaintenanceTarget;
const id = (value: unknown) => check(typeof value === "string" && value.trim().length > 0 && value.length <= 200, "INVALID_REQUEST", "请求或身份标识无效");
function syncVoid(result: unknown, code: string, message: string) {
  if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
  check(result === undefined, code, message, 503);
}
const sessionDto = (s: Session) => ({ id: s.id, scenario: s.scenario, target: targetOf(s), mode: s.mode, providerId: s.provider_id, modelId: s.model_id,
  generation: s.generation, revision: s.revision, lifecycle: s.lifecycle, createdAt: s.created_at, updatedAt: s.updated_at });
const taskDto = (t: Task) => ({ id: t.id, sessionId: t.session_id, mode: t.mode, sequence: t.sequence, generation: t.generation,
  status: t.status, processState: t.process_state,
  errorCode: t.error_code === null ? null : ["CANCEL_REQUESTED", "PROCESS_STOP_UNCONFIRMED", "MAINTENANCE_TASK_FAILED"].includes(t.error_code) ? t.error_code : "MAINTENANCE_TASK_FAILED",
  createdAt: t.created_at, startedAt: t.started_at, endedAt: t.ended_at });

/** Eight-table storage/admission kernel. No implicit SQL installation, native
 * process spawning, history replay or default policy.
 * Host-only methods/capabilities MUST NOT be registered as HTTP/MCP tools. */
export class MaintenanceSessions {
  private claims = new WeakMap<MaintenanceTaskHandle, Claim>();
  constructor(private readonly store: Store, private readonly business: MaintenanceBusinessHost,
    private readonly boundary: MaintenanceSessionBoundary, private readonly now = Date.now) { requireWorkspaceSchema(store); requireWorkspaceBusinessTracking(store); }
  private authorize(actor: string, target: MaintenanceTarget, action: "read" | "maintain") {
    requireWorkspaceBusinessTracking(this.store); id(actor); assertTarget(target);
    syncVoid(this.boundary.authorize(actor, target, action), "AUTHORIZATION_INVALID", "维护权限检查必须同步完成");
  }
  private session(actor: string, sessionId: string): Session {
    requireWorkspaceBusinessTracking(this.store); id(actor); id(sessionId);
    const session = this.store.one<Session>("SELECT * FROM agent_maintenance_sessions WHERE id=? AND actor_key=?", sessionId, actor);
    check(session, "NOT_FOUND", "维护会话不存在", 404); return session;
  }
  private task(taskId: string): Task {
    requireWorkspaceBusinessTracking(this.store); id(taskId);
    const task = this.store.one<Task>("SELECT * FROM agent_maintenance_tasks WHERE id=?", taskId);
    check(task, "NOT_FOUND", "维护任务不存在", 404); return task;
  }
  private policy(session: Pick<Session, "provider_id" | "model_id" | "mode" | "id" | "actor_key" | "owner_kind" | "owner_id" | "owner_scope_json">): MaintenanceBackendPolicy {
    const policy = this.boundary.backend(session.provider_id, session.model_id, session.mode, { actor: session.actor_key, sessionId: session.id, target: targetOf(session) });
    if (policy && typeof (policy as unknown as { then?: unknown }).then === "function") void Promise.resolve(policy).catch(() => {});
    check(policy && /^[a-f0-9]{64}$/.test(policy.fingerprint) && /^[a-f0-9]{64}$/.test(policy.knowledgeHash) &&
      typeof policy.toolPolicyVersion === "string" && policy.toolPolicyVersion.trim().length > 0 && policy.toolPolicyVersion.length <= 200 &&
      policy.references?.providerId === session.provider_id && typeof policy.references.validatePayload === "function" &&
      Array.isArray(policy.references.supportedVersions) && policy.references.supportedVersions.length > 0 &&
      policy.references.supportedVersions.every(version => Number.isSafeInteger(version) && version > 0), "BACKEND_UNAVAILABLE", "未取得已验证的维护后端策略", 503);
    // Snapshot policy identities; a later catalog refresh cannot mutate an
    // already claimed task's fingerprint or reference-version allowlist.
    return Object.freeze({ fingerprint: policy.fingerprint, knowledgeHash: policy.knowledgeHash, toolPolicyVersion: policy.toolPolicyVersion,
      references: Object.freeze({ providerId: policy.references.providerId, supportedVersions: Object.freeze([...policy.references.supportedVersions]),
        validatePayload: policy.references.validatePayload.bind(policy.references) }) });
  }
  private current(session: Session): MaintenanceBackendPolicy {
    assertMaintenanceOwnerAvailable(this.store, session.id);
    check(session.lifecycle === "active" && ["present", "absent"].includes(session.native_delete_state), "SESSION_UNAVAILABLE", "维护会话已关闭或原生状态待核对", 409);
    const policy = this.policy(session);
    check(session.contract_version === MAINTENANCE_CONTRACT && session.knowledge_hash === policy.knowledgeHash &&
      session.tool_policy_version === policy.toolPolicyVersion, "SESSION_CONTRACT_CHANGED", "规则或工具策略已变化，请新建维护会话", 409);
    check(!session.provider_fingerprint || session.provider_fingerprint === policy.fingerprint, "BACKEND_CHANGED", "原生后端安装身份已变化，禁止恢复旧引用", 409);
    return policy;
  }
  private ready(session: Session) {
    const p = projectionState(this.store);
    check(p.state === "ready" && p.target_generation === p.synced_generation && p.content_hash && p.target_knowledge_hash === session.knowledge_hash,
      "WORKSPACE_NOT_READY", "共享维护工作区尚未就绪", 409);
    return p;
  }
  private dto(session: Session) { return { ...sessionDto(session), readOnlyReason: maintenanceOwnerRetired(this.store, session.id) ? "OWNER_UNAVAILABLE" : null }; }
  view(actor: string, sessionId: string) {
    const session = this.session(actor, sessionId); this.authorize(actor, targetOf(session), "read"); return this.dto(session);
  }
  list(actor: string, target: MaintenanceTarget, limit = 50) {
    this.authorize(actor, target, "read"); check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "INVALID_REQUEST", "分页大小无效");
    return this.store.all<Session>("SELECT * FROM agent_maintenance_sessions WHERE actor_key=? AND owner_kind=? AND owner_id=? AND owner_scope_json=? ORDER BY updated_at DESC,id LIMIT ?",
      actor, target.kind, target.id, canonicalJson(target.scope), limit).map(session => this.dto(session));
  }
  ownerHistory(actor: string, kind: MaintenanceTarget["kind"], owner: string, selected?: string) {
    id(actor); id(owner);
    const ownerColumn = kind === "workflow_draft" ? "json_extract(owner_scope_json,'$.draftId')" : "owner_id";
    const rows = this.store.all<Session>(`SELECT * FROM agent_maintenance_sessions WHERE actor_key=? AND owner_kind=?
      AND ${ownerColumn}=? ORDER BY (id=?) DESC,updated_at DESC,id LIMIT 100`, actor, kind, owner, selected ?? "");
    const safeText = (ref: string | null, key: string) => {
      if (!ref) return "";
      let text: unknown;
      try { text = (this.store.dereference(ref) as Record<string, unknown> | null)?.[key]; }
      catch { return "历史内容不可用"; }
      if (typeof text !== "string") return "";
      try { assertQuerySafe(text, secrets); return text; }
      catch { return "内容因包含敏感信息而隐藏"; }
    };
    const secrets = [...this.boundary.knownSecrets(), this.store.root, homedir()];
    const conversations = rows.map(session => {
      this.authorize(actor, targetOf(session), "read");
      const first = this.store.one<Task>("SELECT input_ref FROM agent_maintenance_tasks WHERE session_id=? ORDER BY sequence LIMIT 1", session.id);
      return { ...this.dto(session), title: safeText(first?.input_ref ?? null, "prompt").split("\n")[0]!.slice(0, 100) || "维护对话" };
    });
    const session = rows.find(row => row.id === selected);
    const tasks = session ? this.store.all<Task>("SELECT * FROM agent_maintenance_tasks WHERE session_id=? ORDER BY sequence DESC LIMIT 100", session.id)
      .reverse().map(task => ({ ...taskDto(task), prompt: safeText(task.input_ref, "prompt"), text: safeText(task.display_output_ref, "text"),
        proposals: this.store.all<{ id: string }>("SELECT id FROM agent_maintenance_proposals WHERE task_id=? AND actor_key=? ORDER BY created_at,id", task.id, actor) })) : [];
    return { conversations, tasks };
  }
  tasks(actor: string, sessionId: string, before = Number.MAX_SAFE_INTEGER, limit = 50) {
    const session = this.session(actor, sessionId); this.authorize(actor, targetOf(session), "read");
    check(Number.isSafeInteger(before) && before > 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "INVALID_REQUEST", "任务分页无效");
    return this.store.all<Task>("SELECT * FROM agent_maintenance_tasks WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?", sessionId, before, limit).map(taskDto);
  }
  create(actor: string, requestId: string, input: { target: MaintenanceTarget; mode: Mode; providerId: string; modelId: string }) {
    id(requestId); onlyKeys(input, ["target", "mode", "providerId", "modelId"]); assertTarget(input.target);
    check(["single", "multi"].includes(input.mode), "INVALID_REQUEST", "维护模式无效"); id(input.providerId);
    check(typeof input.modelId === "string" && input.modelId.trim().length > 0 && input.modelId.length <= 500, "INVALID_REQUEST", "模型标识无效");
    this.authorize(actor, input.target, "maintain");
    return this.store.command(`maintenance.session.create:${actor}`, requestId, input, () => {
      this.authorize(actor, input.target, "maintain"); this.business.capture(input.target);
      const sessionId = randomUUID(), policy = this.policy({ id: sessionId, actor_key: actor, provider_id: input.providerId, model_id: input.modelId, mode: input.mode,
        owner_kind: input.target.kind, owner_id: input.target.id, owner_scope_json: canonicalJson(input.target.scope) });
      check(projectionState(this.store).target_knowledge_hash === policy.knowledgeHash, "WORKSPACE_NOT_READY", "维护规则尚未初始化", 409);
      const now = this.now(), scenario = input.target.kind === "workflow_draft" ? "workflow" : input.target.kind === "script_draft" ? "script" : "web-bridge";
      this.store.exec(`INSERT INTO agent_maintenance_sessions(id,actor_key,scenario,owner_kind,owner_id,owner_scope_json,mode,provider_id,model_id,contract_version,tool_policy_version,knowledge_hash,generation,revision,lifecycle,native_delete_state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,1,'active','absent',?,?)`, sessionId, actor, scenario, input.target.kind, input.target.id, canonicalJson(input.target.scope), input.mode, input.providerId, input.modelId, MAINTENANCE_CONTRACT, policy.toolPolicyVersion, policy.knowledgeHash, now, now);
      // Store only identity in the idempotency receipt, never a stale public view.
      return { sessionId };
    }).sessionId;
  }
  retry(actor: string, sessionId: string, requestId: string, prompt: string, modelId?: string) {
    const session = this.session(actor, sessionId);
    this.authorize(actor, targetOf(session), "maintain");
    const task = this.store.one<Task>("SELECT * FROM agent_maintenance_tasks WHERE session_id=? AND request_id=?", sessionId, requestId);
    if (!task) return undefined;
    const saved = this.store.dereference(task.input_ref) as { prompt?: string; modelId?: string } | null;
    check(saved?.prompt === prompt && (!modelId || (saved.modelId ?? session.model_id) === modelId), "REQUEST_CONFLICT", "请求标识已用于不同消息", 409);
    return taskDto(task);
  }
  enqueue(actor: string, sessionId: string, input: { requestId: string; prompt: string; expectedRevision: number; expectedGeneration: number; modelId?: string }) {
    onlyKeys(input, ["requestId", "prompt", "expectedRevision", "expectedGeneration", "modelId"], ["requestId", "prompt", "expectedRevision", "expectedGeneration"]); id(input.requestId);
    if (input.modelId !== undefined) id(input.modelId);
    check(typeof input.prompt === "string" && input.prompt.trim().length > 0 && input.prompt.length <= 100000 && Buffer.byteLength(input.prompt) <= 256 * 1024,
      "INVALID_REQUEST", "维护消息为空或超过预算");
    check(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0 && Number.isSafeInteger(input.expectedGeneration) && input.expectedGeneration > 0,
      "INVALID_REQUEST", "维护会话修订号或代次无效");
    const session = this.session(actor, sessionId); this.authorize(actor, targetOf(session), "maintain");
    const requestHash = digest(canonicalJson(input)), prior = this.store.one<Task>("SELECT * FROM agent_maintenance_tasks WHERE session_id=? AND request_id=?", sessionId, input.requestId);
    if (prior) { check(prior.request_hash === requestHash, "REQUEST_CONFLICT", "请求标识已用于不同消息", 409); return taskDto(prior); }
    return configCoordinator(this.store).withAdmission(() => this.store.transaction(() => {
      const current = this.session(actor, sessionId); this.authorize(actor, targetOf(current), "maintain"); this.current(current);
      check(current.revision === input.expectedRevision && current.generation === input.expectedGeneration, "REVISION_CONFLICT", "维护会话已变化，请刷新", 409);
      check(!this.store.one("SELECT id FROM agent_maintenance_tasks WHERE status IN ('queued','running','stopping') LIMIT 1"), "WORKSPACE_BUSY", "已有共享维护任务", 409);
      check(!this.store.one("SELECT id FROM agent_maintenance_apply_requests WHERE state='queued' LIMIT 1"), "MAINTENANCE_APPLY_PENDING", "须先处理已确认应用请求", 409);
      if (current.mode === "single") check(!this.store.one("SELECT id FROM agent_maintenance_tasks WHERE session_id=?", sessionId), "SINGLE_TASK_SETTLED", "单轮会话不能继续或重放，请新建会话", 409);
      const modelId = input.modelId ?? current.model_id;
      const changedModel = modelId !== current.model_id;
      if (changedModel) {
        check(current.mode === "multi", "SESSION_MODEL_CONFLICT", "单轮会话不能切换模型", 409);
        const policy = this.policy({ ...current, model_id: modelId });
        check(policy.knowledgeHash === current.knowledge_hash && policy.toolPolicyVersion === current.tool_policy_version,
          "SESSION_CONTRACT_CHANGED", "规则或工具策略已变化，请新建维护会话", 409);
        if (current.native_ref_json) validateSessionReference(JSON.parse(current.native_ref_json), policy.references);
        this.store.exec("UPDATE agent_maintenance_sessions SET model_id=?,provider_fingerprint=?,revision=revision+1 WHERE id=?",
          modelId, current.provider_fingerprint ? policy.fingerprint : null, sessionId);
      }
      const p = this.ready(current), snapshot = this.business.capture(targetOf(current));
      const sequence = Number(this.store.one<{ n: number }>("SELECT coalesce(max(sequence),0)+1 n FROM agent_maintenance_tasks WHERE session_id=?", sessionId)!.n);
      check(Number.isSafeInteger(sequence) && sequence > 0, "TASK_SEQUENCE_EXHAUSTED", "维护任务序号已耗尽", 409);
      const taskId = randomUUID(), now = this.now();
      this.store.exec(`INSERT INTO agent_maintenance_tasks(id,session_id,mode,request_id,request_hash,sequence,generation,projection_generation,projection_hash,baseline_json,status,process_state,input_ref,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'queued','absent',?,?)`, taskId, sessionId, current.mode, input.requestId, requestHash, sequence, current.generation, p.synced_generation, p.content_hash, canonicalJson(snapshot.baseline), this.store.reference({ prompt: input.prompt, ...(input.modelId ? { modelId } : {}) }), now);
      this.store.exec("UPDATE agent_maintenance_sessions SET updated_at=? WHERE id=?", now, sessionId);
      return taskDto(this.task(taskId));
    }));
  }
  cancel(actor: string, sessionId: string, taskId: string) {
    const session = this.session(actor, sessionId); this.authorize(actor, targetOf(session), "read");
    const result = this.store.transaction(() => {
      const task = this.task(taskId); check(task.session_id === sessionId, "NOT_FOUND", "维护任务不存在", 404);
      if (!active(task)) return taskDto(task);
      if (task.status === "queued" && task.process_state === "absent")
        this.store.exec("UPDATE agent_maintenance_tasks SET status='cancelled',ended_at=? WHERE id=?", this.now(), taskId);
      else this.store.exec("UPDATE agent_maintenance_tasks SET status='stopping',process_state=CASE WHEN process_state='unknown' THEN 'unknown' ELSE 'stopping' END,error_code='CANCEL_REQUESTED' WHERE id=?", taskId);
      return taskDto(this.task(taskId));
    });
    this.revoke(taskId); return result;
  }
  private revoke(taskId: string) { try { syncVoid(this.boundary.revokeTask(taskId), "TASK_REVOCATION_INVALID", "撤销必须同步登记"); } catch { /* DB status also revokes every gateway call; host must still prove exit. */ } }
  /** Host only. Mark starting BEFORE any spawn; never return platform messages,
   * asset source or a synthesized summary as native history. */
  claim(taskId: string) {
    return this.store.transaction(() => {
      this.store.directoryLease.assert(); const task = this.task(taskId);
      const session = this.store.one<Session>("SELECT * FROM agent_maintenance_sessions WHERE id=?", task.session_id)!;
      this.authorize(session.actor_key, targetOf(session), "maintain"); const policy = this.current(session), p = this.ready(session);
      check(task.status === "queued" && task.process_state === "absent" && task.generation === session.generation, "TASK_NOT_QUEUED", "任务不能重复启动", 409);
      check(task.projection_generation === p.synced_generation && task.projection_hash === p.content_hash &&
        task.baseline_json === canonicalJson(this.business.capture(targetOf(session)).baseline), "REVISION_CONFLICT", "任务读取基线已变化", 409);
      const reference = session.native_ref_json ? validateSessionReference(JSON.parse(session.native_ref_json), policy.references) : null;
      check(!reference || reference.version === session.native_ref_version, "BACKEND_REFERENCE_VERSION_UNSUPPORTED", "持久化原生引用版本不一致", 409);
      check(session.mode !== "single" || !reference, "SINGLE_REFERENCE_FORBIDDEN", "单轮任务不能恢复原生历史", 409);
      const input = this.store.dereference(task.input_ref);
      onlyKeys(input, ["prompt", "modelId"], ["prompt"]);
      check(input.modelId === undefined || input.modelId === session.model_id, "SESSION_MODEL_CONFLICT", "任务模型与会话不一致", 409);
      check(typeof input.prompt === "string" && input.prompt.trim().length > 0 && input.prompt.length <= 100000 && Buffer.byteLength(input.prompt) <= 256 * 1024,
        "INVALID_TASK_INPUT", "维护任务输入缺失、损坏或超过预算", 409);
      this.store.exec("UPDATE agent_maintenance_tasks SET status='running',process_state='starting',started_at=? WHERE id=?", this.now(), taskId);
      const handle = Object.freeze({ taskId, generation: task.generation });
      this.claims.set(handle, { taskId, sessionId: session.id, generation: task.generation, policy });
      return { handle, mode: session.mode, providerId: session.provider_id, modelId: session.model_id, target: targetOf(session), baseline: JSON.parse(task.baseline_json),
        projectionGeneration: task.projection_generation, projectionHash: task.projection_hash,
        input: { prompt: input.prompt }, reference, fingerprint: policy.fingerprint };
    });
  }
  private claimed(handle: MaintenanceTaskHandle): { task: Task; binding: Claim; session: Session } {
    const binding = this.claims.get(handle); check(binding, "TASK_CAPABILITY_INVALID", "任务宿主凭证无效", 403);
    const task = this.task(binding.taskId), session = this.store.one<Session>("SELECT * FROM agent_maintenance_sessions WHERE id=?", binding.sessionId)!;
    check(active(task) && task.generation === binding.generation && session.generation === binding.generation, "TASK_GENERATION_CONFLICT", "迟到事件或已结束任务", 409);
    return { task, binding, session };
  }
  started(handle: MaintenanceTaskHandle) {
    const { task } = this.claimed(handle);
    check(task.status === "running" && task.process_state === "starting", "TASK_STATE_CONFLICT", "任务已取消或重复启动", 409);
    this.store.exec("UPDATE agent_maintenance_tasks SET process_state='running' WHERE id=?", task.id);
  }
  attachReference(handle: MaintenanceTaskHandle, reference: ProviderSessionReference) {
    return this.store.transaction(() => {
      const { session, binding } = this.claimed(handle);
      check(session.mode === "multi", "SINGLE_REFERENCE_FORBIDDEN", "单轮任务不得持久化原生历史", 409);
      const checked = validateSessionReference(reference, binding.policy.references), json = canonicalJson(checked);
      check(!this.store.one("SELECT id FROM agent_maintenance_sessions WHERE id<>? AND native_ref_json=?", session.id, json), "BACKEND_REFERENCE_CONFLICT", "原生引用已绑定其他维护会话", 409);
      check(!session.native_ref_json || session.native_ref_json === json, "BACKEND_REFERENCE_CONFLICT", "原生会话引用与准确恢复目标不一致", 409);
      if (!session.native_ref_json) this.store.exec("UPDATE agent_maintenance_sessions SET native_ref_json=?,native_ref_version=?,provider_fingerprint=?,native_delete_state='present',revision=revision+1,updated_at=? WHERE id=?", json, checked.version, binding.policy.fingerprint, this.now(), session.id);
    });
  }
  recordDisplay(handle: MaintenanceTaskHandle, text: string) {
    const { task } = this.claimed(handle);
    check(task.status === "running" && typeof text === "string" && Buffer.byteLength(text) <= 256 * 1024, "INVALID_TASK_OUTPUT", "展示输出已失效或超过预算", 409);
    assertQuerySafe(text, [...this.boundary.knownSecrets(), this.store.root, homedir()]);
    this.store.exec("UPDATE agent_maintenance_tasks SET display_output_ref=? WHERE id=?", this.store.reference({ text }), task.id);
  }
  private unknown(task: Task) {
    this.store.transaction(() => {
      this.store.exec("UPDATE agent_maintenance_tasks SET status='stopping',process_state='unknown',error_code=CASE WHEN error_code='CANCEL_REQUESTED' THEN error_code ELSE 'PROCESS_STOP_UNCONFIRMED' END WHERE id=?", task.id);
      this.store.exec("UPDATE agent_workspace_projection_state SET state='failed',error_code='PROCESS_STOP_UNCONFIRMED',updated_at=? WHERE id='maintenance'", this.now());
    });
    this.revoke(task.id);
  }
  private finish(task: Task, status: Exclude<Status, "queued" | "running" | "stopping">) {
    this.revoke(task.id);
    try {
      syncVoid(this.boundary.assertStopped({ taskId: task.id, sessionId: task.session_id, generation: task.generation }),
        "PROCESS_STOP_UNCONFIRMED", "进程停止检查必须同步完成");
    } catch {
      this.unknown(task); throw new AppError("PROCESS_STOP_UNCONFIRMED", "维护进程或读取资源退出尚未确认，已保留阻断状态", 503);
    }
    return this.store.transaction(() => {
      const current = this.task(task.id);
      check(active(current) && current.generation === task.generation, "TASK_GENERATION_CONFLICT", "任务已经结束", 409);
      const outcome = current.error_code === "CANCEL_REQUESTED" ? "cancelled" : status;
      this.store.exec("UPDATE agent_maintenance_tasks SET status=?,process_state=?,error_code=?,ended_at=? WHERE id=?", outcome,
        current.process_state === "absent" ? "absent" : "stopped", outcome === "failed" ? "MAINTENANCE_TASK_FAILED" : null, this.now(), task.id);
      return taskDto(this.task(task.id));
    });
  }
  settle(handle: MaintenanceTaskHandle, status: "succeeded" | "failed" | "cancelled") {
    check(["succeeded", "failed", "cancelled"].includes(status), "INVALID_REQUEST", "任务终态无效");
    const { task } = this.claimed(handle); const result = this.finish(task, status); this.claims.delete(handle); return result;
  }
  /** Startup never infers process exit from lost in-memory state. Queued/absent
   * requests remain resumable, all possibly submitted tasks stay globally active. */
  recoverUncertain() {
    requireWorkspaceBusinessTracking(this.store);
    const tasks = this.store.all<Task>("SELECT * FROM agent_maintenance_tasks WHERE status IN ('queued','running','stopping')");
    for (const task of tasks) if (!(task.status === "queued" && task.process_state === "absent")) this.unknown(task);
  }
  /** Host recovery after a real external stop proof. It does NOT mark the damaged
   * projection ready; WorkspaceInstaller.recover must rebuild/verify it first. */
  reconcileStopped(taskId: string, generation: number) {
    const task = this.task(taskId);
    check(active(task) && task.generation === generation, "TASK_GENERATION_CONFLICT", "恢复对应的任务代次已变化", 409);
    return this.finish(task, "interrupted");
  }
}
