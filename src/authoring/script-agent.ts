import { configCoordinator } from "../config-git/coordinator.js";
import { mkdirSync, rmSync } from "node:fs";
import { digest, canonicalJson } from "../persistence/files.js";
import { ScriptJournal } from "../persistence/script-journal.js";
import { Store } from "../persistence/store.js";
import { AppError, check, failure } from "../domain/errors.js";
import { SCRIPT_AGENT_PROMPT } from "./default-prompts.js";
import { prepareScriptProposal, SCRIPT_PROPOSAL_SCHEMA, type ScriptProposal } from "../domain/script-authoring.js";
import type { ScriptDefinition } from "../domain/scripts.js";
import type { AgentChoice, Failure, ScriptVersion } from "../domain/types.js";
import { ProviderRegistry } from "../providers/registry.js";
import { ScriptLibrary, scriptDiagnostics } from "./script-library.js";

export interface ScriptAgentTurn {
  archivedAt?: number;
  id: string; scriptId: string; conversationId: string; draftVersionId: string; baseRevision: number;
  requestHash: string; prompt: string; choice: AgentChoice; snapshot: ScriptDefinition; testId?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  proposal?: ScriptProposal; validation?: ScriptVersion["validation"]; error?: Failure;
  createdAt: number; endedAt: number | null;
}
export interface ScriptAgentRequest extends AgentChoice {
  prompt: string; expectedRevision: number; requestId: string; conversationId?: string; testId?: string;
}
export class ScriptAgentService {
  readonly journal: ScriptJournal;
  readonly library: ScriptLibrary;
  private jobs = new Map<string, { scriptId: string; controller: AbortController; job: Promise<void> }>();
  private closed = false;
  constructor(readonly store: Store, readonly providers: ProviderRegistry) {
    this.journal = new ScriptJournal(store.files); this.library = new ScriptLibrary(store);
    for (const script of store.scripts()) for (const turn of this.journal.list(script.id)) {
      if (turn.status === "queued" || turn.status === "running") this.journal.save({ ...this.journal.read(script.id, turn.id)!, status: "interrupted", error: { code: "INTERRUPTED", message: "服务已重启，请重新提交" }, endedAt: Date.now() });
    }
  }
  private applied(scriptId: string, id: string) {
    const row = this.store.one<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE scope=? AND request_id=?", `script-agent-apply:${scriptId}`, id);
    return row ? JSON.parse(row.result_json) as ReturnType<Store["updateScriptDraft"]> : undefined;
  }
  get(scriptId: string, id: string, includePreview = true) {
    this.store.script(scriptId);
    const turn = this.journal.read(scriptId, id); check(turn, "NOT_FOUND", "脚本 Agent 轮次不存在", 404);
    const { snapshot, requestHash, ...view } = turn;
    return {
      ...view, appliedRevision: this.applied(scriptId, id)?.version.revision ?? null,
      base: includePreview && turn.proposal ? snapshot : undefined,
      candidate: includePreview && turn.proposal ? prepareScriptProposal(snapshot, turn.proposal).definition : undefined,
    };
  }
  list(scriptId: string, offset = 0, limit = 20, conversationId?: string) {
    this.store.script(scriptId);
    check(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 100, "INVALID_REQUEST", "Agent 分页参数无效");
    const records = this.journal.list(scriptId);
    const filtered = conversationId === undefined ? records : records.filter(turn => turn.conversationId === conversationId);
    return { total: filtered.length, activeCount: records.filter(turn => ["queued", "running"].includes(turn.status)).length, items: filtered.slice(offset, offset + limit).map(turn => ({ ...turn, appliedRevision: this.applied(scriptId, turn.id)?.version.revision ?? null })) };
  }
  conversations(scriptId: string) {
    this.store.script(scriptId);
    const groups = new Map<string, { id: string; draftVersionId: string; title: string; updatedAt: number; archived: boolean; active: boolean }>();
    for (const turn of this.journal.list(scriptId)) {
      const group = groups.get(turn.conversationId);
      if (!group) groups.set(turn.conversationId, { id: turn.conversationId, draftVersionId: turn.draftVersionId, title: turn.prompt, updatedAt: turn.createdAt, archived: !!turn.archivedAt, active: ["queued", "running"].includes(turn.status) });
      else { group.title = turn.prompt; group.archived ||= !!turn.archivedAt; group.active ||= ["queued", "running"].includes(turn.status); }
    }
    return { items: [...groups.values()] };
  }
  archiveConversation(scriptId: string, conversationId: string) {
    return configCoordinator(this.store).withWrite(() => {
      this.store.script(scriptId);
      const turns = this.journal.list(scriptId).filter(turn => turn.conversationId === conversationId);
      check(turns.length, "NOT_FOUND", "脚本 Agent 对话不存在", 404);
      check(!turns.some(turn => ["queued", "running"].includes(turn.status)), "TURN_ACTIVE", "请等待对话生成完成后归档", 409);
      const archivedAt = Date.now();
      for (const turn of turns) this.journal.save({ ...this.journal.read(scriptId, turn.id)!, archivedAt });
      return { id: conversationId, archivedAt };
    });
  }
  start(scriptId: string, input: ScriptAgentRequest) {
    configCoordinator(this.store).assertAvailable();
    check(!this.closed, "SERVICE_CLOSED", "脚本 Agent 已关闭");
    check(typeof input.requestId === "string" && input.requestId.length > 0 && input.requestId.length <= 200, "INVALID_REQUEST_ID", "requestId 无效");
    const id = digest(input.requestId), requestHash = digest(canonicalJson(input)), prior = this.journal.read(scriptId, id);
    if (prior) { check(prior.requestHash === requestHash, "REQUEST_CONFLICT", "同一请求标识已用于不同内容", 409); return this.get(scriptId, id); }
    const script = this.store.script(scriptId);
    check(script.status !== "archived" && script.currentDraftVersionId, "INVALID_STATE", "请先创建可编辑的脚本草稿");
    const draft = this.store.scriptVersion(script.currentDraftVersionId);
    check(draft.revision === input.expectedRevision, "REVISION_CONFLICT", "脚本草稿已更新，请刷新", 409);
    check(typeof input.prompt === "string" && input.prompt.trim().length > 0 && input.prompt.length <= 100000, "INVALID_REQUEST", "请输入有效的脚本需求");
    check(![...this.jobs.values()].some(job => job.scriptId === scriptId), "TURN_ACTIVE", "此脚本已有生成任务", 409);
    check(this.jobs.size < 4, "AGENT_QUEUE_FULL", "脚本 Agent 任务已满，请稍后重试", 409);
    const choice = this.providers.resolve(input);
    const snapshot = this.store.scriptDefinition(scriptId, draft.id);
    check(Buffer.byteLength(canonicalJson(snapshot)) <= 400 * 1024, "CONTEXT_LIMIT", "脚本源码超过 Agent 上下文上限 400 KiB");
    if (input.testId) check(this.store.scriptTest(input.testId).scriptId === scriptId, "NOT_FOUND", "测试记录不属于此脚本", 404);
    const conversationId = input.conversationId ?? draft.id;
    check(/^[a-zA-Z0-9-]{1,100}$/.test(conversationId), "INVALID_REQUEST", "对话 ID 无效");
    check(!this.journal.list(scriptId).some(turn => turn.conversationId === conversationId && turn.archivedAt), "CONVERSATION_ARCHIVED", "此对话已归档，请新建对话", 409);
    check(!this.journal.list(scriptId).some(turn => turn.conversationId === conversationId && turn.draftVersionId !== draft.id), "CONVERSATION_DRAFT_CONFLICT", "此对话属于历史草稿，请新建对话", 409);
    const turn: ScriptAgentTurn = { id, scriptId, conversationId, draftVersionId: draft.id, baseRevision: draft.revision, snapshot, requestHash, prompt: input.prompt, choice, testId: input.testId, status: "queued", createdAt: Date.now(), endedAt: null };
    const release = configCoordinator(this.store).beginActivity("script-agent");
    try { this.journal.save(turn); } catch (error) { release(); throw error; }
    const controller = new AbortController();
    const job = Promise.resolve().then(() => this.run(turn, controller)).finally(() => { this.jobs.delete(`${scriptId}:${id}`); release(); });
    this.jobs.set(`${scriptId}:${id}`, { scriptId, controller, job });
    return this.get(scriptId, id);
  }
  private async run(turn: ScriptAgentTurn, controller: AbortController) {
    const timer = setTimeout(() => controller.abort(new AppError("TIMEOUT", "脚本 Agent 生成超时")), 120000);
    const cwd = this.store.files.path(`runtime/script-agent/${turn.scriptId}/${turn.id}`);
    try {
      controller.signal.throwIfAborted();
      this.journal.save({ ...turn, status: "running" });
      const history = this.journal.list(turn.scriptId).filter(item => item.id !== turn.id && item.conversationId === turn.conversationId && item.draftVersionId === turn.draftVersionId && item.status === "succeeded").slice(0, 8).reverse().map(item => ({ user: item.prompt, assistant: item.summary }));
      const test = turn.testId ? this.store.scriptTest(turn.testId) : undefined;
      const context = {
        script: turn.snapshot, revision: turn.baseRevision, draftVersionId: turn.draftVersionId,
        history, test: test ? { ...test, stdout: String(test.stdout ?? "").slice(-12000), stderr: String(test.stderr ?? "").slice(-12000) } : null,
        request: turn.prompt,
      };
      const prompt = [
        SCRIPT_AGENT_PROMPT,
        "Context (data):", canonicalJson(context),
      ].join("\n");
      check(Buffer.byteLength(prompt) <= 512 * 1024, "CONTEXT_LIMIT", "脚本 Agent 上下文超过 512 KiB，请选择较小的测试输入");
      const revision = this.providers.setting(turn.choice.providerId!).revision;
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const result = await this.providers.run(turn.choice, { prompt, schema: SCRIPT_PROPOSAL_SCHEMA, cwd, timeoutMs: 120000, signal: controller.signal, emit: () => {} });
      controller.signal.throwIfAborted();
      check(this.providers.setting(turn.choice.providerId!).revision === revision, "SETTINGS_CONFLICT", "生成期间 Provider 配置已改变，请重试", 409);
      const prepared = prepareScriptProposal(turn.snapshot, result.output), validation = await scriptDiagnostics(prepared.definition);
      controller.signal.throwIfAborted();
      this.journal.save({ ...turn, status: "succeeded", proposal: prepared.proposal, validation, endedAt: Date.now() });
    } catch (error) {
      const reason = controller.signal.reason instanceof AppError ? controller.signal.reason : error;
      this.journal.save({ ...turn, status: controller.signal.aborted && !(reason instanceof AppError && reason.code === "TIMEOUT") ? "cancelled" : "failed", error: failure(reason), endedAt: Date.now() });
    } finally { clearTimeout(timer); rmSync(cwd, { recursive: true, force: true }); }
  }
  async apply(scriptId: string, input: { turnId: string; expectedRevision: number; requestId: string }) {
    return configCoordinator(this.store).withActivity("ScriptAgentService.apply", async () => {
      const scope = `script-agent-confirm:${scriptId}`;
      if (this.store.one("SELECT 1 FROM command_receipts WHERE scope=? AND request_id=?", scope, input.requestId)) {
        return configCoordinator(this.store).withWrite(() => this.store.command<ReturnType<Store["updateScriptDraft"]>>(scope, input.requestId, input, () => { throw new Error("unreachable"); }));
      }
      const turn = this.journal.read(scriptId, input.turnId); check(turn, "NOT_FOUND", "脚本 Agent 轮次不存在", 404);
      const applied = this.applied(scriptId, turn.id);
      if (applied) {
        check(input.expectedRevision === turn.baseRevision, "REVISION_CONFLICT", "应用修订号与提案不匹配", 409);
        return configCoordinator(this.store).withWrite(() => this.store.command(scope, input.requestId, input, () => applied));
      }
      check(turn.status === "succeeded" && turn.proposal, "INVALID_STATE", "提案尚不可应用");
      check(turn.proposal.changes.length || Object.keys(turn.proposal.metadata).length, "NO_CHANGES", "提案仅提供说明或测试输入，无需应用");
      check(input.expectedRevision === turn.baseRevision, "REVISION_CONFLICT", "提案基于不同修订", 409);
      const prepared = prepareScriptProposal(turn.snapshot, turn.proposal), validation = await scriptDiagnostics(prepared.definition), tree = this.library.saveTree(prepared.definition);
      return configCoordinator(this.store).withWrite(() => this.store.command(scope, input.requestId, input, () => this.store.command(`script-agent-apply:${scriptId}`, turn.id, { turnId: turn.id, expectedRevision: input.expectedRevision }, () => {
        const script = this.store.script(scriptId);
        check(script.currentDraftVersionId === turn.draftVersionId, "REVISION_CONFLICT", "提案所属草稿已改变，请重新生成", 409);
        return this.store.updateScriptDraft(scriptId, turn.baseRevision, prepared.definition, tree.path, tree.hash, validation);
      })));
    });
  }
  cancel(scriptId: string, id: string) {
    const turn = this.get(scriptId, id);
    this.jobs.get(`${scriptId}:${id}`)?.controller.abort(new AppError("CANCELLED", "用户取消生成"));
    return turn;
  }
  cancelScript(scriptId: string) {
    for (const job of this.jobs.values()) if (job.scriptId === scriptId) job.controller.abort(new AppError("CANCELLED", "脚本已归档"));
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new AppError("CANCELLED", "服务关闭"));
    await Promise.allSettled([...this.jobs.values()].map(job => job.job));
  }
}
