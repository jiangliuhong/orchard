import { bridgeAgentSystemPrompt } from "../authoring/default-prompts.js";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError, check, failure } from "../domain/errors.js";
import type { AgentChoice, Failure } from "../domain/types.js";
import { canonicalJson, digest, FileStore } from "../persistence/files.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { WebBridgeConfig } from "./config.js";
import { BRIDGE_PROPOSAL_SCHEMA, prepareBridgeProposal, type BridgeProposal } from "./authoring.js";

export interface BridgeAgentTurn {
  id: string; application: string; conversationId: string; prompt: string; choice: AgentChoice;
  snapshot: ReturnType<WebBridgeConfig["authoringSnapshot"]>; requestHash: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  proposal?: BridgeProposal; error?: Failure; appliedHash?: string;
  createdAt: number; endedAt?: number;
}
export interface BridgeAgentRequest extends AgentChoice {
  requestId: string; conversationId: string; prompt: string; toolId?: string; testContext?: string;
}
export class BridgeAgentService {
  onSaved?: (turn: BridgeAgentTurn) => void;
  private jobs = new Map<string, { application: string; controller: AbortController; job: Promise<void> }>();
  private closed = false;
  constructor(readonly files: FileStore, readonly config: WebBridgeConfig, readonly providers: ProviderRegistry) {
    const directory = files.path("web-bridge-agent");
    if (existsSync(directory)) for (const application of readdirSync(directory).filter(name => /^[a-z][a-z0-9-]{0,49}$/.test(name))) {
      for (const turn of this.records(application)) if (["queued", "running"].includes(turn.status)) {
        this.save({ ...turn, status: "interrupted", error: { code: "INTERRUPTED", message: "服务已重启，请重新提交" }, endedAt: Date.now() });
      }
    }
  }
  private directory(application: string) {
    check(/^[a-z][a-z0-9-]{0,49}$/.test(application), "INVALID_APPLICATION", "应用 ID 无效");
    return this.files.path(`web-bridge-agent/${application}`);
  }
  private path(application: string, id: string) {
    this.directory(application);
    check(/^[a-f0-9]{64}$/.test(id), "NOT_FOUND", "Agent 轮次不存在", 404);
    return this.files.path(`web-bridge-agent/${application}/${id}.json`);
  }
  private read(application: string, id: string): BridgeAgentTurn | undefined {
    const path = this.path(application, id);
    if (!existsSync(path)) return;
    check(lstatSync(path).isFile() && lstatSync(path).size <= 2 * 1024 * 1024, "INVALID_RECORD", "会话记录超过大小限制");
    const turn = JSON.parse(readFileSync(path, "utf8")) as BridgeAgentTurn;
    check(turn.application === application && turn.id === id, "INVALID_RECORD", "会话记录归属无效");
    return turn;
  }
  private records(application: string) {
    const directory = this.directory(application);
    return existsSync(directory) ? readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => this.read(application, name.slice(0, -5))!).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)) : [];
  }
  private save(turn: BridgeAgentTurn) {
    const path = this.path(turn.application, turn.id), temporary = this.files.path(`web-bridge-agent/${turn.application}/${randomUUID()}.tmp`);
    check(Buffer.byteLength(JSON.stringify(turn)) <= 2 * 1024 * 1024, "OUTPUT_LIMIT", "Agent 输出超过大小限制");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(temporary, JSON.stringify(turn), { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
    this.onSaved?.(turn);
  }
  private view(turn: BridgeAgentTurn) {
    const { snapshot, requestHash, ...view } = turn;
    return { ...view, baseHash: snapshot.hash, base: turn.proposal?.changes.length ? snapshot.tools.filter(tool => turn.proposal!.changes.some(change => change.toolId === tool.toolId)) : undefined };
  }
  list(application: string, conversationId?: string) {
    this.config.authoringSnapshot(application);
    const records = this.records(application), conversations = new Map<string, { id: string; title: string; updatedAt: number }>();
    for (const turn of records) {
      const prior = conversations.get(turn.conversationId);
      conversations.set(turn.conversationId, { id: turn.conversationId, title: prior?.title ?? turn.prompt.slice(0, 80), updatedAt: turn.createdAt });
    }
    return {
      items: records.filter(turn => !conversationId || turn.conversationId === conversationId).map(turn => this.view(turn)),
      conversations: [...conversations.values()].sort((left, right) => right.updatedAt - left.updatedAt),
      active: records.find(turn => ["queued", "running"].includes(turn.status))?.id,
    };
  }
  start(application: string, input: BridgeAgentRequest) {
    this.config.coordinator.assertAvailable();
    check(!this.closed, "SERVICE_CLOSED", "Agent 已关闭");
    check(typeof input.requestId === "string" && input.requestId.length > 0 && input.requestId.length <= 200, "INVALID_REQUEST", "请求 ID 无效");
    check(typeof input.conversationId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(input.conversationId), "INVALID_REQUEST", "对话 ID 无效");
    check(typeof input.prompt === "string" && input.prompt.trim().length > 0 && input.prompt.length <= 20000, "INVALID_REQUEST", "请输入维护需求（最多 20000 字）");
    check(input.testContext === undefined || typeof input.testContext === "string" && input.testContext.length <= 16000, "INVALID_REQUEST", "测试上下文超过 16000 字");
    const snapshot = this.config.authoringSnapshot(application);
    const id = digest(input.requestId), requestHash = digest(canonicalJson(input)), prior = this.read(application, id);
    if (prior) { check(prior.requestHash === requestHash, "REQUEST_CONFLICT", "请求标识已用于其他内容", 409); return this.view(prior); }
    check(![...this.jobs.values()].some(job => job.application === application), "TURN_ACTIVE", "此应用已有生成任务", 409);
    check(this.jobs.size < 4, "AGENT_QUEUE_FULL", "Agent 任务已满，请稍后重试", 409);
    check(!input.toolId || snapshot.tools.some(tool => tool.toolId === input.toolId), "UNKNOWN_TOOL", "工具不存在");
    check(Buffer.byteLength(canonicalJson(snapshot)) <= 300 * 1024, "CONTEXT_LIMIT", "应用配置超过 Agent 上下文限制");
    const choice = this.providers.resolve(input);
    const turn: BridgeAgentTurn = { id, application, conversationId: input.conversationId, prompt: input.prompt, choice, snapshot, requestHash, status: "queued", createdAt: Date.now() };
    const release = this.config.coordinator.beginActivity("web-bridge-agent");
    try { this.save(turn); } catch (error) { release(); throw error; }
    const controller = new AbortController();
    const job = Promise.resolve().then(() => this.run(turn, input, controller)).finally(() => { this.jobs.delete(`${application}:${id}`); release(); });
    this.jobs.set(`${application}:${id}`, { application, controller, job });
    return this.view(turn);
  }
  private async run(turn: BridgeAgentTurn, input: BridgeAgentRequest, controller: AbortController) {
    const timer = setTimeout(() => controller.abort(new AppError("TIMEOUT", "Agent 生成超时")), 120000);
    const cwd = this.files.path(`runtime/web-bridge-agent/${turn.application}/${turn.id}`);
    try {
      controller.signal.throwIfAborted();
      this.save({ ...turn, status: "running" });
      const history = this.records(turn.application).filter(item => item.id !== turn.id && item.conversationId === turn.conversationId)
        .map(item => ({ user: item.prompt, assistant: item.proposal, status: item.status, error: item.error, applied: !!item.appliedHash }));
      const prompt = [
        bridgeAgentSystemPrompt(turn.application),
        "User context:", canonicalJson({ snapshot: turn.snapshot, selectedTool: input.toolId, testContext: input.testContext, history, request: turn.prompt }),
      ].join("\n");
      check(Buffer.byteLength(prompt) <= 512 * 1024, "CONTEXT_LIMIT", "对话上下文过长，请新建对话");
      const revision = this.providers.setting(turn.choice.providerId!).revision;
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const result = await this.providers.run(turn.choice, { prompt, schema: BRIDGE_PROPOSAL_SCHEMA, cwd, signal: controller.signal, timeoutMs: 120000, emit: () => {} });
      controller.signal.throwIfAborted();
      check(this.providers.setting(turn.choice.providerId!).revision === revision, "SETTINGS_CONFLICT", "Provider 配置已变化，请重试", 409);
      const { proposal } = prepareBridgeProposal(turn.application, turn.snapshot.tools, result.output);
      this.save({ ...turn, status: "succeeded", proposal, endedAt: Date.now() });
    } catch (error) {
      const reason = controller.signal.reason instanceof AppError ? controller.signal.reason : error;
      this.save({ ...turn, status: controller.signal.aborted && !(reason instanceof AppError && reason.code === "TIMEOUT") ? "cancelled" : "failed", error: failure(reason), endedAt: Date.now() });
    } finally { clearTimeout(timer); rmSync(cwd, { force: true, recursive: true }); }
  }
  apply(application: string, id: string) {
    return this.config.coordinator.withWrite(() => {
      const turn = this.read(application, id);
      check(turn?.status === "succeeded" && turn.proposal, "INVALID_STATE", "没有可应用的变更");
      const current = this.config.authoringSnapshot(application);
      if (turn.appliedHash) return { hash: turn.appliedHash };
      const prepared = prepareBridgeProposal(application, turn.snapshot.tools, turn.proposal);
      check(prepared.proposal.changes.length, "NO_CHANGES", "此回复没有变更");
      const candidateHash = digest(canonicalJson({ application: turn.snapshot.application, environments: turn.snapshot.environments, tools: prepared.candidate }));
      if (current.hash !== candidateHash) this.config.applyProposal(application, turn.snapshot.hash, turn.proposal);
      const hash = this.config.authoringSnapshot(application).hash;
      this.save({ ...turn, appliedHash: hash });
      return { hash };
    });
  }
  cancel(application: string, id: string) {
    this.config.coordinator.assertAvailable();
    check(this.read(application, id), "NOT_FOUND", "Agent 轮次不存在", 404);
    this.jobs.get(`${application}:${id}`)?.controller.abort(new AppError("CANCELLED", "用户取消生成"));
    return { ok: true };
  }
  deleteApplication(application: string) {
    return this.config.coordinator.withWrite(() => {
      check(![...this.jobs.values()].some(job => job.application === application), "TURN_ACTIVE", "请先停止此应用的 Agent 生成任务", 409);
      const result = this.config.deleteApplication(application);
      rmSync(this.directory(application), { recursive: true, force: true });
      return result;
    });
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new AppError("CANCELLED", "服务关闭"));
    await Promise.allSettled([...this.jobs.values()].map(job => job.job));
  }
}
