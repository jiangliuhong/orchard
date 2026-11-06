import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Store } from "../persistence/store.js";
import { checkFiles, compileScripts, json, readDefinition, readLayout, safeFile, validateFiles } from "../persistence/files.js";
import { ProviderRegistry } from "../providers/registry.js";
import { check, failure } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import type { SourceFiles, Workflow, AgentChoice } from "../domain/types.js";
import { transportOf } from "../providers/registry.js";
import { ConversationService, titleFromPrompt } from "./conversations.js";
import { ACTIVE_TURN_STATUSES } from "../domain/turns.js";
import { buildAuthoringContext, composeAuthoringPrompt, type ContextHistoryMessage } from "./context.js";

export const AUTHORING_SCHEMA = {
  type: "object", required: ["summary", "changes"], properties: {
    summary: { type: "string", maxLength: 10000 },
    changes: { type: "array", maxItems: 100, items: { type: "object", required: ["operation", "path"], properties: { operation: { enum: ["create", "update", "delete"] }, path: { type: "string" }, content: { type: "string" } }, additionalProperties: false } },
  }, additionalProperties: false,
};

/** AUTHORING_SCHEMA 的 changes 项形状。 */
export interface AuthoringChange { operation: string; path: string; content?: string }

/**
 * 纯准备阶段（设计 §19.3）：把后端文件变更应用到草稿副本并做全部静态检查，
 * 不产生副作用、不写库；保持 generate() 原有语义：
 * 重复路径、safeFile、create/update/delete 与原文件状态、文件树校验。
 */
export function applyAuthoringChanges(before: SourceFiles, changes: AuthoringChange[]): SourceFiles {
  const files = { ...before }, seen = new Set<string>();
  for (const change of changes) {
    safeFile(change.path);
    check(!seen.has(change.path), "INVALID_CHANGES", "文件操作重复");
    seen.add(change.path);
    const exists = Object.hasOwn(files, change.path);
    check(change.operation === "create" ? !exists : exists, "INVALID_CHANGES", "文件操作与草稿状态不一致");
    if (change.operation === "delete") delete files[change.path];
    else {
      check(typeof change.content === "string", "INVALID_CHANGES", "缺少完整文件内容");
      files[change.path] = change.content;
    }
  }
  checkFiles(files);
  return files;
}

export function initialFiles(id: string): SourceFiles {
  const workflow: Workflow = {
    formatVersion: 1, id, name: "未命名工作流", inputSchema: true, outputSchema: true, entryNodeId: "start",
    nodes: [{ id: "start", name: "处理输入", type: "code.nodejs", config: { script: "scripts/start.ts" }, input: { source: "workflow" }, outputSchema: true }],
    edges: [], result: { source: "node", nodeId: "start" },
  };
  return { "workflow.json": JSON.stringify(workflow, null, 2), "scripts/start.ts": "export default async function run(input: unknown) {\n  return input;\n}\n" };
}
export class AuthoringService {
  private readonly jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly sessionHandles = new Map<string, { providerId: string; handle: import("../providers/session.js").ProviderSessionHandle }>();
  readonly conversations: ConversationService;
  constructor(readonly store: Store, readonly providers: ProviderRegistry) { this.conversations = new ConversationService(store, providers); }
  private ensureDeletable(draftIds: string[]) {
    check(![...this.jobs.keys()].some(id => draftIds.includes(this.store.turn(id).draftId)), "WORKFLOW_BUSY", "创作任务尚未结束，请等待取消或生成完成后再删除");
  }
  deleteWorkflow(id: string) {
    this.ensureDeletable(this.store.workflowDraftIds(id));
    return this.store.deleteWorkflow(id);
  }
  deleteDraft(id: string) {
    this.ensureDeletable([id]);
    return this.store.deleteDraft(id);
  }
  async editVersion(workflowId: string, versionId: string | undefined, mode: "edit" | "copy" | "restore", requestId: string) {
    const scope = `version-draft:${workflowId}`, input = { versionId, mode };
    if (this.store.one("SELECT * FROM command_receipts WHERE scope=? AND request_id=?", scope, requestId)) return this.store.command(scope, requestId, input, () => { throw new Error("unreachable"); });
    const workflow = this.store.workflows().find(w => w.id === workflowId);
    check(workflow, "NOT_FOUND", "工作流不存在");
    const version = this.store.version(versionId ?? workflow.currentVersionId);
    check(version.workflowId === workflowId, "NOT_FOUND", "版本不属于该工作流");
    const files = { ...this.store.files.readTree(version.artifactPath).files };
    if (mode === "copy") {
      const definition = readDefinition(files);
      files["workflow.json"] = JSON.stringify({ ...definition, id: `workflow-${randomUUID()}`, name: `${definition.name}（副本）` }, null, 2);
    }
    const validation = await validateFiles(files), tree = this.store.files.saveTree(files);
    return this.store.command(scope, requestId, input, () => {
      const current = this.store.workflows().find(w => w.id === workflowId);
      check(current, "NOT_FOUND", "工作流不存在");
      check(current.currentVersionId === workflow.currentVersionId, "BASELINE_CONFLICT", "工作流已有新版本，请刷新后重试");
      const existing = this.store.drafts().find(d => d.workflowId === workflowId && ["draft", "publishing"].includes(d.status));
      if (mode === "edit" && existing) return existing;
      check(mode !== "restore" || !existing, "DRAFT_BUSY", "已有未发布的草稿，请先完成该草稿后再还原历史版本");
      const id = randomUUID(), now = Date.now();
      this.store.exec("INSERT INTO drafts VALUES(?,?,?,?,?,?,NULL,'draft',?,?)", id, mode === "copy" ? null : workflowId, mode === "copy" ? null : current.currentVersionId, 0, tree.path, json(validation), now, now);
      return this.store.draft(id);
    });
  }
  async create(workflowId: string | undefined, requestId: string) {
    const prior = this.store.one("SELECT * FROM command_receipts WHERE scope='draft' AND request_id=?", requestId);
    if (prior) return this.store.command("draft", requestId, { workflowId }, () => { throw new Error("unreachable"); });
    let files: SourceFiles, baseVersionId: string | null = null;
    if (workflowId) {
      const workflow = this.store.workflows().find(w => w.id === workflowId); check(workflow, "NOT_FOUND", "工作流不存在");
      baseVersionId = workflow.currentVersionId;
      files = this.store.files.readTree(this.store.version(baseVersionId).artifactPath).files;
    } else files = initialFiles(`workflow-${randomUUID()}`);
    const validation = await validateFiles(files), tree = this.store.files.saveTree(files);
    return this.store.command("draft", requestId, { workflowId }, () => {
      const id = randomUUID(), now = Date.now();
      this.store.exec("INSERT INTO drafts VALUES(?,?,?,?,?,?,NULL,'draft',?,?)", id, workflowId ?? null, baseVersionId, 0, tree.path, json(validation), now, now);
      return this.store.draft(id);
    });
  }
  snapshot(id: string) {
    const draft = this.store.draft(id), tree = this.store.files.readTree(draft.artifactPath), conversations = this.conversations.list(id);
    return { ...draft, files: tree.files, messages: this.store.messages(id), turns: this.store.turns(id), conversations: conversations.items, currentConversation: conversations.currentId };
  }
  private ensureEditable(id: string, revision: number, allowTurn = false) {
    const draft = this.store.draft(id);
    check(draft.revision === revision, "REVISION_CONFLICT", "草稿已更新，请刷新后重试");
    check(draft.status === "draft" && (allowTurn || !this.store.turns(id).some(t => (ACTIVE_TURN_STATUSES as readonly string[]).includes(t.status))), "DRAFT_BUSY", "草稿正在生成或发布，或已经发布");
    return draft;
  }
  private identity(files: SourceFiles) {
    const definition = JSON.parse(files["workflow.json"]!);
    check(typeof definition.id === "string", "INVALID_WORKFLOW", "缺少固定工作流 ID"); return definition.id;
  }
  async update(id: string, revision: number, files: SourceFiles) {
    const draft = this.ensureEditable(id, revision), before = this.store.files.readTree(draft.artifactPath).files;
    checkFiles(files); check(this.identity(files) === this.identity(before), "IDENTITY_CHANGED", "不能修改工作流 ID");
    const validation = await validateFiles(files), tree = this.store.files.saveTree(files);
    this.store.transaction(() => {
      this.ensureEditable(id, revision);
      this.store.exec("UPDATE drafts SET artifact_path=?,validation_json=?,revision=revision+1,updated_at=? WHERE id=?", tree.path, json(validation), Date.now(), id);
    });
    return this.snapshot(id);
  }
  async start(id: string, input: AgentChoice & { prompt: string; expectedRevision: number; requestId: string; conversationId?: string; mode?: "single" | "multi" }) {
    const prior = this.store.one("SELECT * FROM command_receipts WHERE scope=? AND request_id=?", `turn:${id}`, input.requestId);
    if (prior) return this.store.command(`turn:${id}`, input.requestId, input, () => { throw new Error("unreachable"); });
    check(input.prompt.trim().length > 0 && Buffer.byteLength(input.prompt) <= 100000, "INVALID_PROMPT", "请输入需求，最多 100 KiB");
    this.ensureEditable(id, input.expectedRevision);
    const selection = await this.providers.ready(input);
    // 在构造上下文前确定实际逻辑会话；后续事务使用相同 conversationId，避免静默切换上下文。
    const conversation = this.store.transaction(() => this.conversations.ensureForTurn(id, {
      providerId: selection.providerId, modelId: selection.modelId, mode: input.mode ?? "multi", conversationId: input.conversationId ?? null,
    }));
    const snapshot = this.snapshot(id);
    const previous = this.store.turnsOfConversation(conversation.id).at(-1);
    const previousOutcome = previous ? {
      turnId: previous.id,
      status: previous.status as import("../domain/types.js").AuthoringTurnStatus,
      appliedRevision: previous.status === "succeeded" ? (previous.baseRevision === this.store.draft(id).revision ? this.store.draft(id).revision : null) : null,
      errorCode: previous.error?.code ?? null,
    } : null;
    const history: ContextHistoryMessage[] = conversation.contextMode === "reconstructed" ? this.store.messages(id, conversation.id).map(message => ({ sequence: message.sequence, role: message.role, content: message.content })) : [];
    const context = buildAuthoringContext({
      kind: conversation.backendRef === null ? "initial" : "continuation", draftId: id, baseRevision: input.expectedRevision,
      files: snapshot.files, providers: this.providers.views(), previousOutcome,
      history: conversation.contextMode === "reconstructed" ? history : undefined,
      historySource: conversation.rebuildFromId ? "explicit_rebuild" : "legacy", userRequest: input.prompt,
    });
    const prompt = composeAuthoringPrompt(this.providers.views(), context);
    const turn = this.store.command(`turn:${id}`, input.requestId, input, () => this.store.transaction(() => {
      this.ensureEditable(id, input.expectedRevision);
      const conversation = this.conversations.ensureForTurn(id, {
        providerId: selection.providerId, modelId: selection.modelId, mode: input.mode ?? "multi", conversationId: input.conversationId ?? null,
      });
      const turnId = randomUUID(), now = Date.now();
      this.store.insertTurn({ id: turnId, draftId: id, providerId: selection.providerId, modelId: selection.modelId, providerRevision: selection.setting.revision, baseRevision: input.expectedRevision, conversationId: conversation.id, status: "queued", createdAt: now });
      this.store.transitionTurn(turnId, ["queued"], { status: "running", connectionGeneration: 0 });
      this.store.message(id, turnId, "user", { text: input.prompt, providerId: selection.providerId, modelId: selection.modelId }, conversation.id);
      // 首条用户消息确定性生成标题；用户已手动命名则不覆盖。
      this.store.setTitleIfUnset(conversation.id, titleFromPrompt(input.prompt));
      this.store.exec("UPDATE drafts SET updated_at=? WHERE id=?", now, id);
      this.store.append("authoring_turn", turnId, "turn.queued", { conversationId: conversation.id, mode: conversation.mode, contextMode: conversation.contextMode });
      this.store.append("authoring_turn", turnId, "turn.started", { conversationId: conversation.id, connectionGeneration: 0 });
      return this.store.turn(turnId);
    }));
    if (this.jobs.has(turn.id)) return turn;
    const controller = new AbortController();
    const promise = this.generate(turn.id, prompt, snapshot.files, controller).finally(() => this.jobs.delete(turn.id));
    this.jobs.set(turn.id, { controller, promise }); return turn;
  }
  private async generate(turnId: string, prompt: string, before: SourceFiles, controller: AbortController) {
    const turn = this.store.turn(turnId);
    try {
      const emit = (event: { type: string; payload: unknown }) => {
        const current = this.store.turn(turnId);
        if ((current.status === "running" || current.status === "cancel_requested") && !controller.signal.aborted) this.store.append("authoring_turn", turnId, event.type, event.payload);
      };
      const conversation = turn.conversationId ? this.store.conversation(turn.conversationId) : undefined;
      const setting = this.providers.setting(turn.providerId);
      const adapter = this.providers.adapter(turn.providerId);
      const useNativeConversation = !!conversation && conversation.mode === "multi" && transportOf(setting.config) === "native" && !!adapter.sessionProvider;
      let result;
      if (useNativeConversation) {
        const workspace = this.store.files.path(`agent-workspaces/${conversation!.id}`);
        mkdirSync(workspace, { recursive: true, mode: 0o700 });
        const handle = await adapter.sessionProvider!.openSession(setting, {
          key: conversation!.id, modelId: turn.modelId, cwd: workspace, persistent: true,
          signal: controller.signal, resumeRef: conversation!.backendRef ?? undefined,
        });
        this.sessionHandles.set(conversation!.id, { providerId: turn.providerId, handle });
        check(handle.ref !== null, "PROTOCOL_STATE_INVALID", "原生会话未返回后端引用");
        check(this.store.saveBackendRef(conversation!.id, handle.ref, handle.generation), "CONVERSATION_CONFLICT", "会话后端引用保存失败", 409);
        this.store.transitionTurn(turnId, ["running"], { submissionState: "sending", connectionGeneration: handle.generation });
        this.store.append("authoring_turn", turnId, "provider.session", { conversationId: conversation!.id, state: conversation!.backendRef ? "resuming" : "creating" });
        this.store.append("authoring_turn", turnId, "provider.started", { providerId: turn.providerId, requestedModel: turn.modelId, revision: turn.providerRevision, transport: "native" });
        result = await adapter.sessionProvider!.sendTurn(handle, {
          modelId: turn.modelId, prompt, schema: AUTHORING_SCHEMA, cwd: workspace, signal: controller.signal, timeoutMs: 600000,
          hostTurnId: turnId, emit,
          onAccepted: async backendTurnId => {
            check(this.store.transitionTurn(turnId, ["running"], { submissionState: "accepted", backendTurnId }), "TURN_INTERRUPTED", "轮次在后端接受前已结束");
            this.store.append("authoring_turn", turnId, "provider.accepted", { conversationId: conversation!.id, backendTurnId });
          },
        });
        this.store.transitionTurn(turnId, ["running"], { submissionState: "settled" });
        this.store.append("authoring_turn", turnId, "provider.session", { conversationId: conversation!.id, state: "ready" });
        this.store.touchConversation(conversation!.id, turn.baseRevision);
        this.store.append("authoring_turn", turnId, "provider.completed", result);
      } else {
        result = await this.providers.run({ providerId: turn.providerId, modelId: turn.modelId }, {
          prompt, schema: AUTHORING_SCHEMA, cwd: this.store.root, signal: controller.signal, timeoutMs: 600000, emit,
        });
      }
      assertSchema(result.output, AUTHORING_SCHEMA, "创作输出");
      const response = result.output as { summary: string; changes: AuthoringChange[] };
      // 纯准备阶段（§19.3）：应用文件变更并静态检查；后续 validateFiles 诊断不通过仍可保存待修复草稿。
      const files = applyAuthoringChanges(before, response.changes);
      check(this.identity(files) === this.identity(before), "IDENTITY_CHANGED", "不能修改工作流 ID");
      const validation = await validateFiles(files), tree = this.store.files.saveTree(files);
      this.store.transaction(() => {
        controller.signal.throwIfAborted();
        check(this.store.turn(turnId).status === "running", "TURN_CANCELLED", "本轮已取消");
        this.ensureEditable(turn.draftId, turn.baseRevision, true);
        if (response.changes.length) this.store.exec("UPDATE drafts SET artifact_path=?,validation_json=?,revision=revision+1,updated_at=? WHERE id=?", tree.path, json(validation), Date.now(), turn.draftId);
        this.store.message(turn.draftId, turnId, "assistant", { text: response.summary, files: response.changes.map(c => c.path), validation, providerId: result.providerId, modelId: result.modelId }, turn.conversationId ?? null);
        this.store.transitionTurn(turnId, ["running"], { status: "succeeded", submissionState: "settled", end: true });
        this.store.append("authoring_turn", turnId, "turn.succeeded", { summary: response.summary, validation });
      });
    } catch (error) {
      if (ACTIVE_TURN_STATUSES.includes(this.store.turn(turnId).status as typeof ACTIVE_TURN_STATUSES[number])) this.store.transaction(() => {
        const current = this.store.turn(turnId), detail = failure(error);
        const cancelled = current.status === "cancel_requested" || controller.signal.aborted;
        const finalDetail = cancelled ? { code: "CANCELLED", message: "已取消生成" } : detail;
        if (!cancelled && turn.conversationId && ["PROCESS_EXITED_UNEXPECTEDLY", "SESSION_REBUILD_REQUIRED", "TURN_INTERRUPTED", "INTERRUPT_UNCONFIRMED"].includes(detail.code)) {
          this.store.markConversation(turn.conversationId, "needs_rebuild");
        }
        this.store.transitionTurn(turnId, [current.status], { status: cancelled ? "cancelled" : "failed", error: finalDetail, end: true });
        this.store.message(turn.draftId, turnId, "error", finalDetail, turn.conversationId ?? null);
        this.store.append("authoring_turn", turnId, cancelled ? "turn.cancelled" : "turn.failed", finalDetail);
      });
    }
  }
  cancel(id: string, turnId: string) {
    const turn = this.store.turn(turnId);
    check(turn.draftId === id, "NOT_FOUND", "此草稿没有该轮次");
    if (turn.status === "queued" || turn.status === "running") {
      this.store.transaction(() => {
        this.store.transitionTurn(turnId, [turn.status], { status: turn.status === "queued" ? "cancelled" : "cancel_requested" , end: turn.status === "queued" });
        this.store.append("authoring_turn", turnId, turn.status === "queued" ? "turn.cancelled" : "turn.cancel_requested", { reason: "user" });
      });
      this.jobs.get(turnId)?.controller.abort();
    }
    return this.store.turn(turnId);
  }
  async publish(id: string, revision: number, requestId: string) {
    const input = { revision }, scope = `publish:${id}`;
    if (this.store.one("SELECT * FROM command_receipts WHERE scope=? AND request_id=?", scope, requestId)) return this.store.command(scope, requestId, input, () => { throw new Error("unreachable"); });
    const draft = this.store.transaction(() => {
      const current = this.ensureEditable(id, revision); check(current.validation.valid, "INVALID_WORKFLOW", "请先修复校验错误");
      this.store.exec("UPDATE drafts SET status='publishing' WHERE id=?", id); return current;
    });
    try {
      const original = this.store.files.readTree(draft.artifactPath).files;
      const definition = await this.providers.freeze(readDefinition(original));
      const files = { ...original, "workflow.json": JSON.stringify(definition, null, 2) };
      const compiled = await compileScripts(files, definition), layout = readLayout(files);
      this.store.assertWorkflowScripts(definition);
      const tree = this.store.files.saveTree(files, compiled);
      return this.store.command(scope, requestId, input, () => {
        const current = this.store.draft(id);
        check(current.revision === revision && current.status === "publishing", "REVISION_CONFLICT", "草稿已改变");
        const now = Date.now(), workflowId = definition.id;
        if (draft.workflowId) {
          const workflow = this.store.workflows().find(w => w.id === workflowId);
          check(workflow && workflow.currentVersionId === draft.baseVersionId, "BASELINE_CONFLICT", "工作流已有新版本，请基于最新版本修改");
        } else {
          check(!this.store.one("SELECT id FROM workflows WHERE id=?", workflowId), "IDENTITY_CONFLICT", "工作流 ID 已存在");
          this.store.exec("INSERT INTO workflows VALUES(?,?,NULL,?,?)", workflowId, definition.name, now, now);
        }
        for (const node of definition.nodes) if (node.type === "agent") this.providers.resolve(node.config);
        const versionId = randomUUID(), number = Number(this.store.one("SELECT coalesce(max(version_no),0)+1 AS n FROM workflow_versions WHERE workflow_id=?", workflowId)!.n);
        this.store.exec("INSERT INTO workflow_versions VALUES(?,?,?,?,?,?,?,?)", versionId, workflowId, number, json(definition), json(layout), tree.path, tree.hash, now);
        this.store.exec("UPDATE workflows SET name=?,current_version_id=?,updated_at=? WHERE id=?", definition.name, versionId, now, workflowId);
        this.store.exec("UPDATE drafts SET status='published',published_version_id=?,updated_at=? WHERE id=?", versionId, now, id);
        return this.store.version(versionId);
      });
    } catch (error) {
      this.store.exec("UPDATE drafts SET status='draft' WHERE id=? AND status='publishing'", id); throw error;
    }
  }
  async wait(turnId: string) { await this.jobs.get(turnId)?.promise; }
  async close() {
    for (const [id] of this.jobs) this.cancel(this.store.turn(id).draftId, id);
    await Promise.all([...this.jobs.values()].map(job => job.promise));
    for (const [conversationId, entry] of this.sessionHandles) {
      try { await this.providers.adapter(entry.providerId).sessionProvider?.releaseSession(entry.handle); } catch { /* 关闭时继续清理其他资源 */ }
      this.sessionHandles.delete(conversationId);
    }
  }
}
