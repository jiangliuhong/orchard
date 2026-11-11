import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { check } from "../domain/errors.js";
import { canonicalJson, digest } from "../persistence/files.js";
import { validateSessionReference, type ProviderSessionReference, type ReferenceValidator } from "./provider-contract.js";
import type { LifecycleBinding } from "./session-lifecycle-guard.js";

export type AgentMode = "single" | "multi";
export type TurnStatus = "queued" | "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type SubmissionState = "not_sent" | "sending" | "accepted" | "settled";
export type OperationPhase = "prepared" | "closing" | "provider_pending" | "provider_confirmed" | "platform_pending" | "done";
export type OperationStatus = "pending" | "running" | "unknown" | "failed" | "succeeded";

/** Internal persistence records, NOT public DTOs. Reference/body fields must be filtered by API adapters. */
export interface ConversationRow {
  id: string; actor_key: string; scenario: string; owner_type: string; owner_id: string; owner_scope_json: string;
  mode: AgentMode; provider_id: string; current_model_id: string; knowledge_hash: string | null;
  contract_version: string; tool_policy_version: string; workspace_id: string | null;
  lifecycle: "active" | "deleting"; usability: "usable" | "knowledge_outdated" | "backend_unavailable" | "owner_unavailable";
  revision: number; title: string | null; created_at: number; updated_at: number;
}
export interface TurnRow {
  id: string; conversation_id: string; mode: AgentMode; sequence: number; request_id: string; request_hash: string;
  status: TurnStatus; submission_state: SubmissionState; requested_model_id: string; actual_model_id: string | null;
  model_source: "requested" | "reported" | "unknown" | null; generation: number;
  input_ref: string | null; proposal_ref: string | null; error_json: string | null; base_revision: string | null;
  read_baselines_json: string; apply_status: "not_applicable" | "pending" | "applied" | "rejected" | "failed";
  outcome_ref: string | null; created_at: number; started_at: number | null; ended_at: number | null;
}
export interface BackendRow {
  conversation_id: string; provider_id: string; ref_version: number; reference_json: string; fingerprint: string;
  generation: number; health: "available" | "unknown" | "unavailable"; native_delete_state: "present" | "pending" | "unknown" | "absent"; updated_at: number;
}
export interface OperationRow {
  id: string; conversation_id: string | null; subject_id: string; actor_key: string;
  kind: "turn" | "delete" | "switch_model" | "knowledge_install"; request_id: string; request_hash: string;
  expected_revision: number | null; expected_generation: number | null; status: OperationStatus; phase: OperationPhase;
  target_reference_json: string | null; result_json: string | null; error_json: string | null;
  created_at: number; updated_at: number; settled_at: number | null;
}
const active = "('queued','running','cancel_requested')";
const encode = (value: unknown) => canonicalJson(value);

/** Uses the approved schema in the SAME business database. No implicit schema installation,
 * no separate JSON truth and no long transaction across await/provider/model operations.
 */
export class AgentStore {
  constructor(readonly db: DatabaseSync) {
    check(Number(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys) === 1, "AGENT_FOREIGN_KEYS_REQUIRED", "统一 Agent 存储必须启用外键检查");
  }
  private one<T>(sql: string, ...values: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...values) as T | undefined; }
  private all<T>(sql: string, ...values: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...values) as T[]; }
  private run(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).run(...values); }
  transaction<T>(action: () => T): T {
    const name = `agent_${randomUUID().replaceAll("-", "")}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = action();
      check(!(result !== null && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function"), "ASYNC_TRANSACTION_FORBIDDEN", "数据库事务内禁止等待外部异步操作");
      this.db.exec(`RELEASE ${name}`); return result;
    }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }

  conversation(actor: string, id: string): ConversationRow {
    const row = this.one<ConversationRow>("SELECT * FROM agent_conversations WHERE id=? AND actor_key=?", id, actor);
    check(row, "NOT_FOUND", "Agent 对话不存在", 404); return row;
  }
  turn(actor: string, id: string): TurnRow {
    const row = this.one<TurnRow>("SELECT t.* FROM agent_turns t JOIN agent_conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.actor_key=?", id, actor);
    check(row, "NOT_FOUND", "Agent 轮次不存在", 404); return row;
  }
  operation(actor: string, id: string): OperationRow {
    const row = this.one<OperationRow>("SELECT * FROM agent_operations WHERE id=? AND actor_key=?", id, actor);
    check(row, "NOT_FOUND", "Agent 操作不存在", 404); return row;
  }
  backend(actor: string, id: string): BackendRow | undefined {
    this.conversation(actor, id); return this.one<BackendRow>("SELECT * FROM agent_backends WHERE conversation_id=?", id);
  }
  list(actor: string, owner: { scenario: string; type: string; id: string }, options: { limit?: number; before?: { updatedAt: number; id: string } } = {}): ConversationRow[] {
    const limit = options.limit ?? 50;
    check(Number.isInteger(limit) && limit >= 1 && limit <= 100, "INVALID_REQUEST", "分页大小无效");
    const cursor = options.before;
    return this.all<ConversationRow>(`SELECT * FROM agent_conversations WHERE actor_key=? AND scenario=? AND owner_type=? AND owner_id=?
      ${cursor ? "AND (updated_at<? OR (updated_at=? AND id<?))" : ""} ORDER BY updated_at DESC,id DESC LIMIT ?`,
      actor, owner.scenario, owner.type, owner.id, ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []), limit);
  }

  create(actor: string, requestId: string, input: {
    scenario: string; ownerType: string; ownerId: string; ownerScope: Record<string, unknown>; mode: AgentMode;
    providerId: string; modelId: string; knowledgeHash?: string; contractVersion: string; toolPolicyVersion: string; workspaceId?: string; title?: string;
  }): { conversation: ConversationRow; created: boolean } {
    check(requestId.length > 0 && requestId.length <= 200, "INVALID_REQUEST", "请求标识无效");
    const scope = `agent-create:${actor}`, requestHash = digest(encode(input));
    return this.transaction(() => {
      const prior = this.one<{ request_hash: string; result_json: string }>("SELECT request_hash,result_json FROM command_receipts WHERE scope=? AND request_id=?", scope, requestId);
      if (prior) {
        check(prior.request_hash === requestHash, "REQUEST_CONFLICT", "请求标识已用于不同内容", 409);
        const id = (JSON.parse(prior.result_json) as { conversationId: string }).conversationId;
        check(this.one("SELECT id FROM agent_conversations WHERE id=? AND actor_key=?", id, actor), "CONVERSATION_DELETED", "原请求创建的对话已删除，须使用新请求标识", 410);
        return { conversation: this.conversation(actor, id), created: false };
      }
      if (input.mode === "multi") check(this.one("SELECT id FROM agent_workspaces WHERE id=? AND knowledge_hash=? AND installation_state='ready'", input.workspaceId ?? null, input.knowledgeHash ?? null), "KNOWLEDGE_NOT_READY", "共享知识工作区尚未就绪", 409);
      const id = randomUUID(), now = Date.now();
      this.run(`INSERT INTO agent_conversations(id,actor_key,scenario,owner_type,owner_id,owner_scope_json,mode,provider_id,current_model_id,knowledge_hash,contract_version,tool_policy_version,workspace_id,lifecycle,usability,revision,title,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active','usable',1,?,?,?)`, id, actor, input.scenario, input.ownerType, input.ownerId, encode(input.ownerScope), input.mode, input.providerId, input.modelId, input.knowledgeHash ?? null, input.contractVersion, input.toolPolicyVersion, input.workspaceId ?? null, input.title ?? null, now, now);
      this.run("INSERT INTO command_receipts(scope,request_id,request_hash,result_json,created_at) VALUES(?,?,?,?,?)", scope, requestId, requestHash, encode({ conversationId: id }), now);
      return { conversation: this.conversation(actor, id), created: true };
    });
  }

  private idle(id: string): void {
    check(!this.one(`SELECT id FROM agent_turns WHERE conversation_id=? AND status IN ${active}`, id), "TURN_ACTIVE", "对话已有活动轮次", 409);
    check(!this.one("SELECT id FROM agent_turns WHERE conversation_id=? AND submission_state IN ('sending','accepted')", id), "SUBMISSION_UNCERTAIN", "原生轮次状态尚未核对，禁止继续或删除", 409);
  }
  submit(actor: string, id: string, input: { requestId: string; requestHash: string; inputRef?: string }): { turn: TurnRow; created: boolean } {
    return this.transaction(() => {
      const conversation = this.conversation(actor, id);
      const prior = this.one<TurnRow>("SELECT * FROM agent_turns WHERE conversation_id=? AND request_id=?", id, input.requestId);
      if (prior) { check(prior.request_hash === input.requestHash, "REQUEST_CONFLICT", "请求标识已用于不同内容", 409); return { turn: prior, created: false }; }
      check(conversation.lifecycle === "active" && conversation.usability === "usable", "CONVERSATION_READ_ONLY", "对话不可继续", 409);
      if (conversation.mode === "single") check(!this.one("SELECT id FROM agent_turns WHERE conversation_id=?", id), "SINGLE_TURN_LIMIT", "single 对话只允许一个逻辑轮次", 409);
      this.idle(id);
      check(!this.one("SELECT id FROM agent_operations WHERE conversation_id=? AND kind IN ('delete','switch_model') AND settled_at IS NULL", id), "OPERATION_ACTIVE", "对话控制操作尚未结束", 409);
      const turnId = randomUUID(), now = Date.now();
      const sequence = this.one<{ n: number }>("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM agent_turns WHERE conversation_id=?", id)!.n;
      const generation = this.backend(actor, id)?.generation ?? 0;
      this.run(`INSERT INTO agent_turns(id,conversation_id,mode,sequence,request_id,request_hash,status,submission_state,requested_model_id,generation,input_ref,apply_status,created_at)
        VALUES(?,?,?,?,?,?,'queued','not_sent',?,?,?,'not_applicable',?)`, turnId, id, conversation.mode, sequence, input.requestId, input.requestHash, conversation.current_model_id, generation, input.inputRef ?? null, now);
      this.run("UPDATE agent_conversations SET revision=revision+1,updated_at=? WHERE id=?", now, id);
      this.run(`INSERT INTO agent_operations(id,conversation_id,subject_id,actor_key,kind,request_id,request_hash,expected_revision,expected_generation,status,phase,created_at,updated_at)
        VALUES(?,?,?,?,'turn',?,?,?,?,'pending','prepared',?,?)`, turnId, id, id, actor, input.requestId, input.requestHash, conversation.revision + 1, generation, now, now);
      return { turn: this.turn(actor, turnId), created: true };
    });
  }

  saveBackend(actor: string, id: string, input: {
    expectedRevision: number; expectedGeneration: number; generation: number; reference: ProviderSessionReference;
    fingerprint: string; validator: ReferenceValidator;
  }): BackendRow {
    validateSessionReference(input.reference, input.validator);
    return this.transaction(() => {
      const conversation = this.conversation(actor, id), existing = this.backend(actor, id);
      check(conversation.mode === "multi" && conversation.provider_id === input.reference.providerId && conversation.revision === input.expectedRevision && (existing?.generation ?? 0) === input.expectedGeneration && input.generation >= input.expectedGeneration && input.generation > 0,
        "BACKEND_BINDING_CONFLICT", "原生会话绑定已变化", 409);
      check(conversation.lifecycle === "active" && conversation.usability === "usable", "CONVERSATION_READ_ONLY", "不可用或删除中的会话不能替换原生引用", 409);
      check(!this.one("SELECT id FROM agent_operations WHERE conversation_id=? AND kind IN ('delete','switch_model') AND settled_at IS NULL", id), "OPERATION_ACTIVE", "控制操作期间不能替换原生引用", 409);
      if (input.generation !== (existing?.generation ?? 0)) check(!this.one(`SELECT id FROM agent_turns WHERE conversation_id=? AND (status IN ('running','cancel_requested') OR submission_state IN ('sending','accepted'))`, id), "SUBMISSION_UNCERTAIN", "不能轮换活动或状态不确定的原生连接", 409);
      this.run(`INSERT INTO agent_backends(conversation_id,provider_id,ref_version,reference_json,fingerprint,generation,health,native_delete_state,updated_at)
        VALUES(?,?,?,?,?,?,'available','present',?) ON CONFLICT(conversation_id) DO UPDATE SET ref_version=excluded.ref_version,reference_json=excluded.reference_json,fingerprint=excluded.fingerprint,generation=excluded.generation,health='available',native_delete_state='present',updated_at=excluded.updated_at`,
        id, input.reference.providerId, input.reference.version, encode(input.reference), input.fingerprint, input.generation, Date.now());
      this.run("UPDATE agent_conversations SET revision=revision+1,updated_at=? WHERE id=?", Date.now(), id);
      return this.backend(actor, id)!;
    });
  }

  markSending(actor: string, turnId: string, generation: number): TurnRow {
    return this.transaction(() => {
      const turn = this.turn(actor, turnId), backend = this.backend(actor, turn.conversation_id);
      check(turn.status === "queued" && turn.submission_state === "not_sent" && Number.isSafeInteger(generation) && (turn.mode === "single" ? generation > 0 : backend?.generation === generation), "SUBMISSION_CONFLICT", "轮次不能重复发送或使用过期代次", 409);
      this.run("UPDATE agent_turns SET status='running',submission_state='sending',generation=?,started_at=? WHERE id=?", generation, Date.now(), turnId);
      this.run("UPDATE agent_operations SET status='running',phase='provider_pending',expected_generation=?,updated_at=? WHERE id=?", generation, Date.now(), turnId);
      return this.turn(actor, turnId);
    });
  }
  markAccepted(actor: string, turnId: string, generation: number): void {
    const turn = this.turn(actor, turnId), backend = this.backend(actor, turn.conversation_id);
    check(turn.generation === generation && (turn.mode === "single" || backend?.generation === generation) && ["running", "cancel_requested"].includes(turn.status) && turn.submission_state === "sending", "SUBMISSION_CONFLICT", "后端接受事件不属于当前发送", 409);
    this.run("UPDATE agent_turns SET submission_state='accepted' WHERE id=?", turnId);
  }
  requestCancel(actor: string, turnId: string): TurnRow {
    const turn = this.turn(actor, turnId);
    if (["queued", "running"].includes(turn.status)) this.run("UPDATE agent_turns SET status='cancel_requested' WHERE id=?", turnId);
    return this.turn(actor, turnId);
  }
  settle(actor: string, turnId: string, input: {
    generation: number; status: "succeeded" | "failed" | "cancelled" | "interrupted";
    actualModelId?: string; modelSource?: "requested" | "reported" | "unknown";
    proposalRef?: string; error?: Record<string, unknown>; applyStatus?: TurnRow["apply_status"];
  }): TurnRow {
    return this.transaction(() => {
      const turn = this.turn(actor, turnId);
      check(turn.generation === input.generation && ["queued", "running", "cancel_requested"].includes(turn.status), "TURN_GENERATION_CONFLICT", "轮次已结束或终态来自过期代次", 409);
      if (input.status === "succeeded") check(turn.status === "running" && turn.submission_state === "accepted", "SUBMISSION_CONFLICT", "未确认接受的轮次不能标记生成成功", 409);
      this.run(`UPDATE agent_turns SET status=?,submission_state='settled',actual_model_id=?,model_source=?,proposal_ref=?,error_json=?,apply_status=?,ended_at=? WHERE id=?`, input.status, input.actualModelId ?? null, input.modelSource ?? null, input.proposalRef ?? null, input.error ? encode(input.error) : null, input.applyStatus ?? "not_applicable", Date.now(), turnId);
      this.run("UPDATE agent_operations SET status=?,phase='done',updated_at=?,settled_at=? WHERE id=?", input.status === "succeeded" ? "succeeded" : "failed", Date.now(), Date.now(), turnId);
      return this.turn(actor, turnId);
    });
  }

  interruptUnconfirmed(actor: string, turnId: string, generation: number): TurnRow {
    return this.transaction(() => {
      const turn = this.turn(actor, turnId);
      check(turn.generation === generation && ["running", "cancel_requested"].includes(turn.status) &&
        ["sending", "accepted"].includes(turn.submission_state), "TURN_GENERATION_CONFLICT", "轮次没有待核对的原生提交", 409);
      const now = Date.now();
      this.run("UPDATE agent_turns SET status='interrupted',ended_at=? WHERE id=?", now, turnId);
      this.run("UPDATE agent_operations SET status='unknown',updated_at=? WHERE id=?", now, turnId);
      this.run("UPDATE agent_backends SET health='unknown' WHERE conversation_id=? AND generation=?", turn.conversation_id, generation);
      return this.turn(actor, turnId);
    });
  }

  beginControl(actor: string, id: string, input: { kind: "delete" | "switch_model"; requestId: string; requestHash: string; expectedRevision: number; requestedModelId?: string }): { operation: OperationRow; created: boolean } {
    return this.transaction(() => {
      const prior = this.one<OperationRow>("SELECT * FROM agent_operations WHERE actor_key=? AND subject_id=? AND kind=? AND request_id=?", actor, id, input.kind, input.requestId);
      if (prior) { check(prior.request_hash === input.requestHash, "REQUEST_CONFLICT", "控制请求标识已用于不同内容", 409); return { operation: prior, created: false }; }
      const conversation = this.conversation(actor, id);
      check(conversation.revision === input.expectedRevision, "REVISION_CONFLICT", "对话状态已变化", 409);
      this.idle(id);
      check(conversation.lifecycle === "active", "OPERATION_ACTIVE", "对话正在删除，请重试原操作", 409);
      check(!this.one("SELECT id FROM agent_operations WHERE conversation_id=? AND kind IN ('delete','switch_model') AND settled_at IS NULL", id), "OPERATION_ACTIVE", "对话已有未结束的控制操作", 409);
      if (input.kind === "switch_model") check(conversation.usability === "usable" && !!input.requestedModelId?.trim(), "CONVERSATION_READ_ONLY", "此对话不能切换模型", 409);
      const backend = this.backend(actor, id), operationId = randomUUID(), now = Date.now();
      this.run("UPDATE agent_conversations SET lifecycle=?,revision=revision+1,updated_at=? WHERE id=?", input.kind === "delete" ? "deleting" : "active", now, id);
      this.run(`INSERT INTO agent_operations(id,conversation_id,subject_id,actor_key,kind,request_id,request_hash,expected_revision,expected_generation,status,phase,target_reference_json,result_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'pending','prepared',?,?,?,?)`, operationId, id, id, actor, input.kind, input.requestId, input.requestHash, conversation.revision + 1, backend?.generation ?? 0, backend?.reference_json ?? null,
        input.kind === "switch_model" ? encode({ requestedModelId: input.requestedModelId }) : null, now, now);
      if (input.kind === "delete" && backend) this.run("UPDATE agent_backends SET native_delete_state='pending' WHERE conversation_id=?", id);
      return { operation: this.operation(actor, operationId), created: true };
    });
  }

  binding(actor: string, id: string): LifecycleBinding {
    const conversation = this.conversation(actor, id), backend = this.backend(actor, id);
    check(backend, "BACKEND_BINDING_CONFLICT", "对话没有持久原生引用", 409);
    return { conversationId: id, revision: conversation.revision, generation: backend.generation, reference: JSON.parse(backend.reference_json) as ProviderSessionReference,
      lifecycle: conversation.lifecycle, hasActiveTurn: !!this.one(`SELECT id FROM agent_turns WHERE conversation_id=? AND (status IN ${active} OR submission_state IN ('sending','accepted'))`, id) };
  }
  controlProgress(actor: string, operationId: string, input: { status: Exclude<OperationStatus, "succeeded">; phase: Exclude<OperationPhase, "done">; error?: Record<string, unknown> }): OperationRow {
    return this.transaction(() => {
      const operation = this.operation(actor, operationId);
      check(operation.settled_at === null && ["delete", "switch_model"].includes(operation.kind), "OPERATION_SETTLED", "操作已经结束", 409);
      check(["prepared", "closing", "provider_pending", "provider_confirmed", "platform_pending"].indexOf(input.phase) >= ["prepared", "closing", "provider_pending", "provider_confirmed", "platform_pending"].indexOf(operation.phase), "INVALID_STATE", "操作阶段不能倒退", 409);
      // provider_confirmed for delete is only set by confirmNativeDeleted after exact binding verification.
      check(operation.kind !== "delete" || !["provider_confirmed", "platform_pending"].includes(input.phase) || ["provider_confirmed", "platform_pending"].includes(operation.phase), "NATIVE_DELETE_UNCONFIRMED", "原生删除结果尚未确认", 409);
      this.run("UPDATE agent_operations SET status=?,phase=?,error_json=?,updated_at=? WHERE id=?", input.status, input.phase, input.error ? encode(input.error) : null, Date.now(), operationId);
      return this.operation(actor, operationId);
    });
  }
  confirmNativeDeleted(actor: string, operationId: string): void {
    this.transaction(() => {
      const operation = this.operation(actor, operationId);
      check(operation.kind === "delete" && operation.conversation_id !== null && operation.settled_at === null, "INVALID_STATE", "不是待确认的删除操作", 409);
      const conversation = this.conversation(actor, operation.conversation_id), backend = this.backend(actor, conversation.id);
      check(conversation.lifecycle === "deleting" && conversation.revision === operation.expected_revision && (backend?.generation ?? 0) === operation.expected_generation && (backend?.reference_json ?? null) === operation.target_reference_json, "BACKEND_BINDING_CONFLICT", "原生删除确认对应的引用已变化", 409);
      this.idle(conversation.id);
      if (backend) this.run("UPDATE agent_backends SET native_delete_state='absent',updated_at=? WHERE conversation_id=?", Date.now(), conversation.id);
      this.run("UPDATE agent_operations SET status='running',phase='provider_confirmed',error_json=NULL,updated_at=? WHERE id=?", Date.now(), operationId);
    });
  }
  finalizeDelete(actor: string, operationId: string): OperationRow {
    return this.transaction(() => {
      const operation = this.operation(actor, operationId);
      if (operation.kind === "delete" && operation.status === "succeeded") return operation;
      check(operation.kind === "delete" && operation.conversation_id !== null && ["provider_confirmed", "platform_pending"].includes(operation.phase), "NATIVE_DELETE_UNCONFIRMED", "原生删除尚未确认", 409);
      const conversation = this.conversation(actor, operation.conversation_id), backend = this.backend(actor, conversation.id);
      check(conversation.lifecycle === "deleting" && conversation.revision === operation.expected_revision && (backend?.generation ?? 0) === operation.expected_generation && (!backend || backend.native_delete_state === "absent"), "BACKEND_BINDING_CONFLICT", "删除确认已过期", 409);
      this.idle(conversation.id);
      check(!this.one(`SELECT r.operation_id FROM agent_runtime_resources r JOIN agent_operations o ON o.id=r.operation_id WHERE o.conversation_id=? AND (r.release_state!='released' OR r.process_state NOT IN ('stopped','absent'))`, conversation.id), "RESOURCE_RELEASE_PENDING", "私有资源尚未确认停止并释放", 409);
      this.run("DELETE FROM agent_host_feedback WHERE conversation_id=?", conversation.id);
      this.run("DELETE FROM agent_events WHERE conversation_id=?", conversation.id);
      const now = Date.now();
      this.run(`UPDATE agent_operations SET conversation_id=NULL,target_reference_json=NULL,error_json=NULL,
        result_json=CASE WHEN id=? THEN ? ELSE NULL END,
        status=CASE WHEN id=? THEN 'succeeded' WHEN settled_at IS NULL THEN 'failed' ELSE status END,
        phase=CASE WHEN id=? OR settled_at IS NULL THEN 'done' ELSE phase END,
        settled_at=CASE WHEN id=? OR settled_at IS NULL THEN ? ELSE settled_at END,updated_at=? WHERE conversation_id=?`,
        operationId, encode({ deleted: true }), operationId, operationId, operationId, now, now, conversation.id);
      this.run("DELETE FROM agent_conversations WHERE id=?", conversation.id);
      return this.operation(actor, operationId);
    });
  }

  finishModelSwitch(actor: string, operationId: string, result: { confirmedModelId: string } | { error: Record<string, unknown> }): ConversationRow {
    return this.transaction(() => {
      const operation = this.operation(actor, operationId);
      check(operation.kind === "switch_model" && operation.conversation_id !== null && operation.settled_at === null, "INVALID_STATE", "模型切换操作已结束", 409);
      const conversation = this.conversation(actor, operation.conversation_id), backend = this.backend(actor, conversation.id);
      this.idle(conversation.id);
      check(conversation.lifecycle === "active" && conversation.usability === "usable" && conversation.revision === operation.expected_revision && (backend?.generation ?? 0) === operation.expected_generation && (backend?.reference_json ?? null) === operation.target_reference_json, "BACKEND_BINDING_CONFLICT", "模型切换绑定已变化", 409);
      if ("confirmedModelId" in result) {
        const requested = JSON.parse(operation.result_json!) as { requestedModelId: string };
        check(result.confirmedModelId === requested.requestedModelId, "MODEL_SWITCH_UNCONFIRMED", "后端实际模型与请求不一致", 409);
        this.run("UPDATE agent_conversations SET current_model_id=?,revision=revision+1,updated_at=? WHERE id=?", result.confirmedModelId, Date.now(), conversation.id);
      }
      this.run("UPDATE agent_operations SET status=?,phase='done',error_json=?,settled_at=?,updated_at=? WHERE id=?", "error" in result ? "failed" : "succeeded", "error" in result ? encode(result.error) : null, Date.now(), Date.now(), operationId);
      return this.conversation(actor, conversation.id);
    });
  }

  appendEvent(actor: string, id: string, input: { eventId: string; type: string; generation: number; turnId?: string; operationId?: string; role?: "user" | "assistant" | "host" | "system"; payloadRef?: string }): { sequence: number; created: boolean } {
    return this.transaction(() => {
      this.conversation(actor, id);
      const prior = this.one<{ sequence: number; conversation_id: string; type: string; generation: number; turn_id: string | null; operation_id: string | null; role: string | null; payload_ref: string | null }>("SELECT * FROM agent_events WHERE event_id=?", input.eventId);
      if (prior) {
        check(prior.conversation_id === id && prior.type === input.type && prior.generation === input.generation && prior.turn_id === (input.turnId ?? null) && prior.operation_id === (input.operationId ?? null) && prior.role === (input.role ?? null) && prior.payload_ref === (input.payloadRef ?? null), "REQUEST_CONFLICT", "事件 ID 已用于不同内容", 409);
        return { sequence: prior.sequence, created: false };
      }
      if (input.turnId) {
        const turn = this.turn(actor, input.turnId), backend = this.backend(actor, id);
        check(turn.conversation_id === id && turn.generation === input.generation && (!backend || backend.generation === input.generation), "TURN_GENERATION_CONFLICT", "事件不属于当前轮次代次", 409);
      }
      if (input.operationId) check(this.operation(actor, input.operationId).conversation_id === id, "OPERATION_CONFLICT", "事件不属于当前对话操作", 409);
      const sequence = this.one<{ n: number }>("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM agent_events WHERE conversation_id=?", id)!.n;
      this.run("INSERT INTO agent_events(conversation_id,sequence,event_id,turn_id,operation_id,generation,type,role,payload_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", id, sequence, input.eventId, input.turnId ?? null, input.operationId ?? null, input.generation, input.type, input.role ?? null, input.payloadRef ?? null, Date.now());
      return { sequence, created: true };
    });
  }
  events(actor: string, id: string, after = 0, limit = 100): Record<string, unknown>[] {
    this.conversation(actor, id);
    check(Number.isSafeInteger(after) && after >= 0 && Number.isInteger(limit) && limit >= 1 && limit <= 200, "INVALID_REQUEST", "事件分页无效");
    return this.all("SELECT * FROM agent_events WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?", id, after, limit);
  }

  /** Called only by the authorized current.get gateway after reading the actual business revision. */
  recordCurrentRead(actor: string, turnId: string, generation: number, revision: string): void {
    this.transaction(() => {
      const turn = this.turn(actor, turnId), conversation = this.conversation(actor, turn.conversation_id);
      check(conversation.lifecycle === "active" && conversation.usability === "usable" && turn.status === "running" && turn.generation === generation, "TURN_GENERATION_CONFLICT", "查询授权不属于当前可用轮次", 409);
      check(revision.length > 0 && revision.length <= 200, "INVALID_REVISION", "资源 revision 无效");
      const key = this.ownerKey(conversation), baselines = JSON.parse(turn.read_baselines_json) as Record<string, unknown>;
      baselines[key] = { revision, generation };
      this.run("UPDATE agent_turns SET read_baselines_json=? WHERE id=?", encode(baselines), turnId);
    });
  }
  private ownerKey(conversation: ConversationRow): string {
    return digest(encode({ scenario: conversation.scenario, ownerType: conversation.owner_type, ownerId: conversation.owner_id, scope: JSON.parse(conversation.owner_scope_json) }));
  }
  recordProposalBaseline(actor: string, turnId: string, baseRevision: string): void {
    const turn = this.turn(actor, turnId), conversation = this.conversation(actor, turn.conversation_id);
    const baseline = (JSON.parse(turn.read_baselines_json) as Record<string, { revision: string; generation: number }>)[this.ownerKey(conversation)];
    check(conversation.lifecycle === "active" && conversation.usability === "usable" && turn.status === "running" && baseline?.revision === baseRevision && baseline.generation === turn.generation, "BASELINE_NOT_QUERIED", "提案必须携带本轮查询所得的当前对象 revision", 409);
    this.run("UPDATE agent_turns SET base_revision=? WHERE id=?", baseRevision, turnId);
  }
  /** Both callbacks must be synchronous and use this database/transaction for the business CAS.
   * Prepare immutable files before entering this method; never await or execute a model here.
   */
  applyProposal(actor: string, turnId: string, host: { currentRevision(): string; apply(): { newRevision: string; outcomeRef: string } }): { outcomeRef: string; applied: boolean } {
    return this.transaction(() => {
      const turn = this.turn(actor, turnId), conversation = this.conversation(actor, turn.conversation_id);
      check(conversation.lifecycle === "active", "CONVERSATION_READ_ONLY", "删除中的对话不能应用旧提案", 409);
      if (turn.apply_status === "applied") return { outcomeRef: turn.outcome_ref!, applied: false };
      check(conversation.usability === "usable", "CONVERSATION_READ_ONLY", "不可用的旧对话不能应用提案", 409);
      check(turn.status === "succeeded" && turn.apply_status === "pending" && turn.proposal_ref !== null && turn.base_revision !== null, "INVALID_STATE", "没有可应用的提案", 409);
      const baseline = (JSON.parse(turn.read_baselines_json) as Record<string, { revision: string; generation: number }>)[this.ownerKey(conversation)];
      check(baseline?.revision === turn.base_revision && baseline.generation === turn.generation && host.currentRevision() === turn.base_revision, "REVISION_CONFLICT", "基线已变化，请重新查询", 409);
      const applied = host.apply();
      check(typeof applied.newRevision === "string" && typeof applied.outcomeRef === "string", "INVALID_STATE", "应用结果无效");
      this.run("UPDATE agent_turns SET apply_status='applied',outcome_ref=? WHERE id=?", applied.outcomeRef, turnId);
      this.enqueueFeedback(actor, conversation.id, { eventId: randomUUID(), turnId, generation: turn.generation, type: "applied", payload: { revision: applied.newRevision } });
      return { outcomeRef: applied.outcomeRef, applied: true };
    });
  }
  enqueueFeedback(actor: string, id: string, input: { eventId: string; turnId?: string; operationId?: string; generation: number; type: "applied" | "rejected" | "resource_changed" | "selected_test_changed"; payload: Record<string, unknown> }): boolean {
    return this.transaction(() => {
      const conversation = this.conversation(actor, id);
      check(conversation.lifecycle === "active", "CONVERSATION_READ_ONLY", "删除中的对话不能继续投递事实", 409);
      if (input.turnId) check(this.turn(actor, input.turnId).conversation_id === id, "INVALID_STATE", "反馈轮次不属于当前对话");
      if (input.operationId) check(this.operation(actor, input.operationId).conversation_id === id, "INVALID_STATE", "反馈操作不属于当前对话");
      const payload = encode(input.payload), prior = this.one<{ conversation_id: string; turn_id: string | null; operation_id: string | null; generation: number; type: string; payload_json: string }>("SELECT * FROM agent_host_feedback WHERE event_id=?", input.eventId);
      if (prior) {
        check(prior.conversation_id === id && prior.turn_id === (input.turnId ?? null) && prior.operation_id === (input.operationId ?? null) && prior.generation === input.generation && prior.type === input.type && prior.payload_json === payload, "REQUEST_CONFLICT", "反馈事件 ID 已用于不同事实", 409);
        return false;
      }
      // Logical enqueue time is strictly increasing within the conversation, even
      // within one millisecond, after restart or when the wall clock moves backwards.
      const previous = this.one<{ timestamp: number | null }>("SELECT MAX(created_at) AS timestamp FROM agent_host_feedback WHERE conversation_id=?", id)!.timestamp;
      const timestamp = Math.max(Date.now(), (previous ?? 0) + 1);
      check(Number.isSafeInteger(timestamp), "INVALID_STATE", "反馈队列顺序超过安全整数范围");
      this.run("INSERT INTO agent_host_feedback(event_id,conversation_id,turn_id,operation_id,generation,type,payload_json,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)", input.eventId, id, input.turnId ?? null, input.operationId ?? null, input.generation, input.type, payload, timestamp);
      return true;
    });
  }
  pendingFeedback(actor: string, id: string): Record<string, unknown>[] {
    const conversation = this.conversation(actor, id);
    if (conversation.lifecycle !== "active" || conversation.usability !== "usable") return [];
    return this.all("SELECT * FROM agent_host_feedback WHERE conversation_id=? AND status IN ('pending','unknown') ORDER BY created_at,event_id", id);
  }
  feedbackReceipt(actor: string, id: string, eventId: string, input: { status: "delivered"; receipt: Record<string, unknown> } | { status: "unknown" }): void {
    this.transaction(() => {
      const conversation = this.conversation(actor, id);
      check(conversation.lifecycle === "active", "CONVERSATION_READ_ONLY", "删除中的对话不能继续投递事实", 409);
      if (input.status === "delivered") check(input.receipt.confirmed === true && input.receipt.eventId === eventId, "FEEDBACK_UNCONFIRMED", "反馈缺少对应事件的确认回执", 409);
      const prior = this.one<{ status: string; receipt_json: string | null }>("SELECT status,receipt_json FROM agent_host_feedback WHERE event_id=? AND conversation_id=?", eventId, id);
      check(prior, "NOT_FOUND", "反馈事件不存在", 404);
      if (prior.status === "delivered") {
        check(input.status === "delivered" && prior.receipt_json === encode(input.receipt), "FEEDBACK_ALREADY_DELIVERED", "反馈已经确认投递，不能重置或改写", 409);
        return;
      }
      this.run("UPDATE agent_host_feedback SET status=?,receipt_json=?,delivered_at=? WHERE event_id=?", input.status, input.status === "delivered" ? encode(input.receipt) : null, input.status === "delivered" ? Date.now() : null, eventId);
    });
  }
  markKnowledgeOutdated(currentHash: string): number {
    check(/^[a-f0-9]{64}$/.test(currentHash), "INVALID_KNOWLEDGE_HASH", "知识 hash 无效");
    return this.transaction(() => {
      check(!this.one(`SELECT t.id FROM agent_turns t JOIN agent_conversations c ON c.id=t.conversation_id WHERE c.mode='multi' AND c.knowledge_hash!=? AND (t.status IN ${active} OR t.submission_state IN ('sending','accepted'))`, currentHash), "WORKSPACE_BUSY", "旧知识仍有活动或未核对轮次", 409);
      // Changing the revision here would invalidate the persisted binding needed to finish or retry control operations.
      check(!this.one(`SELECT o.id FROM agent_operations o JOIN agent_conversations c ON c.id=o.conversation_id
        WHERE c.mode='multi' AND c.knowledge_hash!=? AND c.usability!='knowledge_outdated'
          AND o.kind IN ('delete','switch_model') AND o.settled_at IS NULL`, currentHash),
        "WORKSPACE_BUSY", "旧知识对话仍有未完成的删除或模型切换", 409);
      return Number(this.run("UPDATE agent_conversations SET usability='knowledge_outdated',revision=revision+1,updated_at=? WHERE mode='multi' AND knowledge_hash!=? AND usability!='knowledge_outdated'", Date.now(), currentHash).changes);
    });
  }

  recoverInterrupted(): number {
    return this.transaction(() => {
      this.run("UPDATE agent_backends SET health='unknown' WHERE conversation_id IN (SELECT conversation_id FROM agent_turns WHERE submission_state IN ('sending','accepted'))");
      const changed = this.run(`UPDATE agent_turns SET status='interrupted',ended_at=?,submission_state=CASE WHEN submission_state='not_sent' THEN 'settled' ELSE submission_state END WHERE status IN ${active}`, Date.now()).changes;
      this.run("UPDATE agent_operations SET status='unknown',updated_at=? WHERE kind IN ('turn','delete','switch_model') AND settled_at IS NULL", Date.now());
      this.run("UPDATE agent_runtime_resources SET process_state='unknown' WHERE release_state!='released' AND process_state IN ('starting','running')");
      return Number(changed);
    });
  }
  /** The caller must confirm the process for this turn and generation has stopped. */
  reconcileStopped(actor: string, turnId: string, generation: number): void {
    this.transaction(() => {
      const turn = this.turn(actor, turnId), backend = this.backend(actor, turn.conversation_id);
      check(turn.status === "interrupted" && turn.generation === generation && (turn.mode === "single" || (backend?.generation ?? 0) === generation), "TURN_GENERATION_CONFLICT", "无法确认旧代次轮次已停止", 409);
      this.run("UPDATE agent_turns SET submission_state='settled' WHERE id=?", turnId);
      this.run("UPDATE agent_operations SET status='failed',phase='done',settled_at=?,updated_at=? WHERE id=?", Date.now(), Date.now(), turnId);
      if (backend) this.run("UPDATE agent_backends SET health='available' WHERE conversation_id=?", turn.conversation_id);
    });
  }
}
