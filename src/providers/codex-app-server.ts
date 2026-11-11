import { tmpdir } from "node:os";
import { AppError, check } from "../domain/errors.js";
import type { ProviderCapabilities, ProviderSetting } from "../domain/types.js";
import { assertSchema } from "../domain/validation.js";
import type { AgentLimits } from "./agent-limits.js";
import type { NativeAdapter, ProviderEvent, ProviderSessionHandle, SessionOpenRequest, SessionProvider, SessionTurnRequest } from "./session.js";
import { SessionManager, type SessionSlot } from "./session-manager.js";
import { PendingRequests } from "./transport/pending.js";
import { JsonlConnection } from "./transport/jsonl.js";
import type { ProviderResult } from "./registry.js";

/**
 * Codex App Server 适配器（设计文档 §6、§21.1、§21.2）。
 *
 * - 启动本机 `codex app-server`（协议基线 0.165.0/0.166.0，v2 API），stdio JSON-RPC；
 * - initialize / initialized 握手后 thread/start（ephemeral 按持久性）或 thread/resume；
 * - 先注册事件处理再调用 turn/start；响应前到达的通知暂存，接受后按 thread/turn 校验归属；
 * - item/agentMessage/delta 增量仅用于展示；最终文本以 completed item 的完整 text 为准，
 *   completed item 覆盖该 item 的增量缓冲，不能再拼一次造成重复；
 * - turn/completed 按 turn.status 区分成功、失败、中断，不能只看通知名；
 * - 服务端带 id 请求必须处理：已知审批／工具请求返回协议错误并终止本轮 TOOLS_DISABLED，
 *   未知方法返回 method-not-found；不得默认批准、调用工具或无限等待；
 * - 工具限制通过 -c 配置覆盖传入（0.165.0 已验证可解析）；
 * - 同一 thread 一次只允许一个 turn。
 */

const DISABLED_FEATURES = ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "multi_agent", "browser_use", "computer_use", "in_app_browser", "image_generation"];

/** Codex 严格结构化输出仅支持的关键字；其余（maxLength、anyOf、$ref 等）一律视为不兼容。 */
const STRICT_KEYWORDS = new Set(["type", "description", "enum", "properties", "required", "items", "additionalProperties", "format"]);
/** 仅当 schema 完全满足 Codex response_format 严格限制时才随 turn/start 发送。 */
function strictOutputSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  const node = schema as Record<string, unknown>;
  if (typeof node.type !== "string" || !["object", "array", "string", "number", "integer", "boolean"].includes(node.type)) return false;
  if (Object.keys(node).some(key => !STRICT_KEYWORDS.has(key))) return false;
  if (node.additionalProperties === true) return false;
  if (node.type === "object") {
    if (typeof node.properties !== "object" || node.properties === null || Array.isArray(node.properties)) return false;
    const required = Array.isArray(node.required) ? node.required.map(String) : [];
    if (Object.keys(node.properties).some(key => !required.includes(key))) return false;
    return Object.values(node.properties).every(strictOutputSchema);
  }
  if (node.type === "array") return typeof node.items !== "undefined" && strictOutputSchema(node.items);
  return true;
}
const PROJECT_POLICY_ARGS: string[] = [
  "-c", "mcp_servers={}", "-c", "notify=[]", "-c", 'web_search="disabled"',
  ...DISABLED_FEATURES.filter(feature => feature !== "shell_tool" && feature !== "unified_exec")
    .flatMap(feature => ["-c", `features.${feature}=false`]),
];
const TOOL_POLICY_ARGS: string[] = [
  "-c", "mcp_servers={}",
  "-c", "notify=[]",
  "-c", 'web_search="disabled"',
  ...DISABLED_FEATURES.flatMap(feature => ["-c", `features.${feature}=false`]),
];

/** 基线中会被主动拒绝的服务端请求方法；不在名单内的未知方法返回 method-not-found。 */
const KNOWN_TOOL_REQUESTS = new Set([
  "execCommandApproval",
  "applyPatchApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/call",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

type CodexRecord = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
type Notification = { method: string; params: Record<string, unknown> };

interface ItemBuffer { deltas: string; final: string | null; order: number; phase?: string }

interface TurnState {
  hostTurnId: string;
  turnId: string | null;
  /** 用户/宿主主动中断（区分后端自主中断）；timeout 进一步区分 TIMEOUT。 */
  interruptedByUs: boolean;
  timedOut: boolean;
  buffered: Notification[];
  items: Map<string, ItemBuffer>;
  itemOrder: number;
  toolItems: Set<string>;
  protocolBytes: number;
  textBytes: number;
  usageLast: unknown;
  usageSeen: boolean;
  emit: (event: ProviderEvent) => void;
  done: Promise<string>;
  /** 终态回调：成功携带最终文本，失败携带错误；只能调用一次。 */
  finish: (error?: AppError, text?: string) => void;
  settled: boolean;
}

interface CodexSession {
  project: boolean;
  conn: JsonlConnection;
  pending: PendingRequests;
  threadId: string;
  modelId: string;
  cwd: string;
  sessionDirectory?: string;
  generation: number;
  /** SessionManager 登记键；null 表示匿名单次进程（容量由 slot 持有至 release）。 */
  managerKey: string | null;
  slot: SessionSlot;
  slotFinished: boolean;
  broken: AppError | undefined;
  turn: TurnState | null;
}

function createTurn(hostTurnId: string, emit: (event: ProviderEvent) => void): TurnState {
  const state = {} as TurnState;
  state.hostTurnId = hostTurnId;
  state.turnId = null;
  state.interruptedByUs = false;
  state.timedOut = false;
  state.buffered = [];
  state.items = new Map();
  state.itemOrder = 0;
  state.toolItems = new Set();
  state.protocolBytes = 0;
  state.textBytes = 0;
  state.usageLast = undefined;
  state.usageSeen = false;
  state.emit = emit;
  state.done = new Promise<string>((resolve, reject) => {
    state.finish = (error?: AppError, text?: string) => {
      if (state.settled) return;
      state.settled = true;
      if (error) reject(error);
      else resolve(text ?? "");
    };
  });
  state.settled = false;
  // done 的回调在 promise 构造后被赋值；确保未处理拒绝不告警。
  void state.done.catch(() => {});
  return state;
}

export class CodexAppServerProvider implements SessionProvider {
  private readonly sessions = new Map<string, CodexSession>();

  constructor(private readonly manager: SessionManager, private readonly limits: AgentLimits) {}

  private executable(setting: ProviderSetting) {
    const executable = setting.config.executable;
    check(typeof executable === "string" && executable.length > 0 && executable.startsWith("/"), "INVALID_EXECUTABLE", "CLI 路径必须为绝对路径");
    return executable;
  }

  private spawn(setting: ProviderSetting, session: CodexSession): void {
    const pending = new PendingRequests(this.limits.requestAckTimeoutMs, this.limits.maxPendingRequestsPerConnection);
    const conn = JsonlConnection.start({
      executable: this.executable(setting),
      args: ["app-server", ...(session.project ? PROJECT_POLICY_ARGS : TOOL_POLICY_ARGS)],
      cwd: session.cwd,
      processDirectory: session.sessionDirectory,
      env: session.sessionDirectory ? { TMPDIR: session.sessionDirectory, TMP: session.sessionDirectory, TEMP: session.sessionDirectory } : undefined,
      limits: this.limits,
      onRecord: record => this.routeRecord(session, record),
      onDiagnostic: text => this.captureDiagnostic(session, text),
      onBroken: error => this.handleBroken(session, error),
    });
    session.conn = conn;
    session.pending = pending;
  }

  private request(session: CodexSession, method: string, params: unknown, label: string, timeoutMs = this.limits.requestAckTimeoutMs): Promise<CodexRecord> {
    const { id, promise } = session.pending.create(label, timeoutMs);
    void session.conn.write(JSON.stringify({ id, method, params })).catch(error => session.pending.reject(id, error));
    return promise as Promise<CodexRecord>;
  }

  private async initialize(session: CodexSession): Promise<void> {
    const response = await this.request(session, "initialize", { clientInfo: { name: "orchard", version: "0.1.0" } }, "initialize", this.limits.initializeTimeoutMs);
    check(response.result !== undefined && !response.error, "PROTOCOL_UNSUPPORTED", `Codex initialize 失败: ${String(response.error?.message ?? "无结果")}`, 503);
    await session.conn.write(JSON.stringify({ method: "initialized", params: {} }));
  }

  async openSession(setting: ProviderSetting, request: SessionOpenRequest): Promise<ProviderSessionHandle> {
    check(request.executionContext !== "project" || (!request.persistent && !request.resumeRef), "PROTOCOL_STATE_INVALID", "项目分析仅支持一次性会话");
    const managerKey = request.persistent ? request.key : null;
    // 复用既有空闲连接：同一逻辑会话、同代次、同模型、连接健康。
    if (managerKey !== null) {
      const existing = this.sessions.get(managerKey);
      if (existing && !existing.broken && existing.modelId === request.modelId && this.manager.isCurrent(managerKey, existing.generation)) {
        const slot = await this.manager.acquire(managerKey, request.signal, "codex-reuse");
        if (slot.reused && !existing.broken) {
          slot.finish();
          return { key: request.key, generation: existing.generation, ref: { version: 1, kind: "codex", threadId: existing.threadId, cwd: existing.cwd } };
        }
        slot.finish();
        this.sessions.delete(managerKey); // 旧会话已被回收或损坏，重建新进程
      }
    }
    const slot = await this.manager.acquire(managerKey, request.signal, "codex-open");
    let session: CodexSession | undefined;
    let registered = false;
    try {
      session = {
        conn: undefined!, pending: undefined!, threadId: "", modelId: request.modelId, cwd: request.cwd,
        project: request.executionContext === "project", sessionDirectory: request.sessionDirectory,
        generation: slot.generation, managerKey, slot, slotFinished: false, broken: undefined, turn: null,
      };
      this.spawn(setting, session);
      await this.initialize(session);
      let threadId: string;
      if (request.resumeRef?.kind === "codex") {
        check(request.resumeRef.cwd === request.cwd, "PROTOCOL_STATE_INVALID", "恢复会话的工作目录与记录不一致");
        threadId = this.threadIdOf(await this.request(session, "thread/resume", {
          threadId: request.resumeRef.threadId, model: request.modelId, cwd: request.cwd,
          sandbox: "read-only", approvalPolicy: "never", excludeTurns: false,
        }, "thread/resume").catch(error => { throw classifyResumeError(error); }), "thread/resume");
      } else {
        threadId = this.threadIdOf(await this.request(session, "thread/start", {
          model: request.modelId, cwd: request.cwd, ephemeral: !request.persistent,
          sandbox: session.project ? "workspace-write" : "read-only", approvalPolicy: "never",
        }, "thread/start"), "thread/start");
      }
      session.threadId = threadId;
      if (managerKey !== null) {
        slot.register(() => session!.conn.close());
        registered = true;
        slot.finish(); // 登记后转空闲，容量由登记项持有
      }
      this.sessions.set(managerKey ?? request.key, session);
      return { key: request.key, generation: slot.generation, ref: { version: 1, kind: "codex", threadId, cwd: request.cwd } };
    } catch (error) {
      if (session?.conn) await session.conn.close().catch(() => {});
      if (managerKey !== null && registered) await this.manager.closeSession(managerKey).catch(() => {});
      if (session) this.sessions.delete(managerKey ?? request.key);
      slot.finish(); // 匿名未登记：归还容量；已登记：closeEntry 已归还，finish 幂等
      throw error;
    }
  }

  private threadIdOf(response: CodexRecord, label: string) {
    const thread = (response.result as { thread?: { id?: unknown } } | undefined)?.thread;
    check(thread && typeof thread.id === "string" && thread.id.length > 0, "PROTOCOL_STATE_INVALID", `${label} 未返回有效线程标识`);
    return thread.id;
  }

  private captureDiagnostic(session: CodexSession, text: string) {
    const turn = session.turn;
    if (!turn || turn.settled) return;
    turn.protocolBytes += Buffer.byteLength(text);
    if (turn.protocolBytes > this.limits.maxTurnProtocolBytes) {
      turn.finish(new AppError("OUTPUT_LIMIT", "本轮诊断与协议累计超过上限"));
      return;
    }
    if (turn.protocolBytes <= this.limits.maxTurnDiagnosticBytes) turn.emit({ type: "provider.diagnostic", payload: { text } });
  }

  private handleBroken(session: CodexSession, error: AppError) {
    session.broken = error;
    session.pending.close(error);
    const turn = session.turn;
    if (turn && !turn.settled) {
      turn.finish(turn.timedOut ? new AppError("TIMEOUT", "Codex 轮次超时且进程已回收")
        : turn.interruptedByUs ? new AppError("CANCELLED", "Codex 轮次中断且进程已回收")
          : error);
    }
    if (session.managerKey !== null) void this.manager.closeSession(session.managerKey).catch(() => {});
  }

  /** stdout 协议记录路由：响应按 id 关联；带 id 的服务端请求必须应答；通知按方法分发。 */
  private routeRecord(session: CodexSession, record: unknown) {
    if (!record || typeof record !== "object") return;
    const value = record as CodexRecord;
    if (value.method !== undefined && value.id !== undefined) {
      this.handleServerRequest(session, value);
      return;
    }
    if (value.id !== undefined && (value.result !== undefined || value.error !== undefined)) {
      if (value.error) session.pending.reject(value.id, new AppError("PROVIDER_FAILED", String(value.error.message ?? "Codex 请求失败")));
      else session.pending.resolve(value.id, value);
      return;
    }
    if (typeof value.method === "string") this.dispatchNotification(session, { method: value.method, params: (value.params ?? {}) as Record<string, unknown> });
    // 其余格式有效但无法识别的记录：忽略（有限诊断）。
  }

  private handleServerRequest(session: CodexSession, record: CodexRecord) {
    const method = String(record.method);
    const respond = (body: unknown) => { void session.conn.write(JSON.stringify(body)).catch(() => { /* 连接已断开 */ }); };
    if (session.project && KNOWN_TOOL_REQUESTS.has(method)) {
      // never 策略不自动批准提权；原生工具无需宿主工具桥。意外交互及时失败。
      respond({ id: record.id, error: { code: -32000, message: "PROJECT_INTERACTION_UNSUPPORTED: unattended project analysis" } });
      session.turn?.finish(new AppError("PROJECT_INTERACTION_UNSUPPORTED", "项目分析不支持交互审批或外部工具请求"));
      return;
    }
    if (KNOWN_TOOL_REQUESTS.has(method)) {
      respond({ id: record.id, error: { code: -32000, message: "TOOLS_DISABLED: orchard 以无工具模式运行" } });
      session.turn?.finish(new AppError("TOOLS_DISABLED", "Codex 请求了被禁用的工具或审批，本轮已终止"));
      return;
    }
    respond({ id: record.id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  /** 提取通知归属的后端轮次 ID（item/* 与 usage 在 params.turnId，turn/* 在 params.turn.id）。 */
  private static notificationTurnId(method: string, params: Record<string, unknown>): string | undefined {
    if (typeof params.turnId === "string") return params.turnId;
    const turn = params.turn as { id?: unknown } | undefined;
    if (method.startsWith("turn/") && turn && typeof turn.id === "string") return turn.id;
    return undefined;
  }

  private dispatchNotification(session: CodexSession, notification: Notification) {
    const { method, params } = notification;
    if (typeof params.threadId === "string" && params.threadId !== session.threadId) return; // 异 thread 不归入
    const turn = session.turn;
    if (!turn || turn.settled) return;
    const backendTurnId = CodexAppServerProvider.notificationTurnId(method, params);
    if (backendTurnId !== undefined) {
      // 响应前到达（turnId 尚未知）→ 暂存；接受后重放；异 ID → 丢弃。
      if (turn.turnId === null) { turn.buffered.push(notification); return; }
      if (backendTurnId !== turn.turnId) return;
    }
    this.processNotification(session, turn, method, params);
  }

  private bindTurnId(session: CodexSession, turn: TurnState, turnId: string) {
    turn.turnId = turnId;
    for (const buffered of turn.buffered.splice(0)) this.dispatchNotification(session, buffered);
  }

  private processNotification(session: CodexSession, turn: TurnState, method: string, params: Record<string, unknown>) {
    turn.protocolBytes += Buffer.byteLength(JSON.stringify({ method, params }));
    if (turn.protocolBytes > this.limits.maxTurnProtocolBytes) {
      turn.finish(new AppError("OUTPUT_LIMIT", "本轮协议累计超过上限"));
      return;
    }
    switch (method) {
      case "turn/started":
        return; // 轮次标识已在 bindTurnId 使用
      case "item/agentMessage/delta": {
        const itemId = typeof params.itemId === "string" ? params.itemId : "";
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!itemId || !delta) return;
        const bytes = Buffer.byteLength(delta);
        if (turn.textBytes + bytes > this.limits.maxTurnTextBytes) {
          turn.finish(new AppError("OUTPUT_LIMIT", "本轮文本超过 8 MiB 上限"));
          return;
        }
        turn.emit({ type: "provider.text", payload: { text: delta, itemId, offset: turn.textBytes } });
        turn.textBytes += bytes;
        let item = turn.items.get(itemId);
        if (!item) { item = { deltas: "", final: null, order: turn.itemOrder++ }; turn.items.set(itemId, item); }
        item.deltas += delta;
        return;
      }
      case "item/completed": {
        const item = params.item as { id?: unknown; type?: unknown; text?: unknown; phase?: unknown } | undefined;
        if (!item || typeof item.id !== "string" || !item.id) return;
        if (["commandExecution", "fileChange"].includes(String(item.type))) {
          turn.toolItems.add(item.id);
          turn.emit({ type: "provider.tool_completed", payload: { count: turn.toolItems.size } }); return;
        }
        if (item.type !== "agentMessage") return;
        let buffer = turn.items.get(item.id);
        if (!buffer) { buffer = { deltas: "", final: null, order: turn.itemOrder++ }; turn.items.set(item.id, buffer); }
        // completed item 的完整文本覆盖增量缓冲，不能再拼一次造成重复。
        if (typeof item.text === "string") buffer.final = item.text;
        if (typeof item.phase === "string") buffer.phase = item.phase;
        return;
      }
      case "thread/tokenUsage/updated": {
        // 线程级用量：保存后端原始 usage 并注明范围，不把线程总量冒充单轮用量。
        const usage = params.tokenUsage as { last?: unknown; total?: unknown } | undefined;
        if (!usage || typeof usage !== "object") return;
        turn.usageSeen = true;
        turn.usageLast = usage.last;
        turn.emit({ type: "provider.usage", payload: { usage, scope: "session" } });
        return;
      }
      case "turn/completed": {
        const backendTurn = params.turn as { status?: unknown; error?: { message?: unknown } | string | null; items?: unknown[] } | undefined;
        const status = backendTurn?.status;
        if (Array.isArray(backendTurn?.items)) {
          for (const raw of backendTurn.items) {
            const item = raw as { id?: unknown; type?: unknown; text?: unknown; phase?: unknown };
            if (!item || item.type !== "agentMessage" || typeof item.id !== "string" || !item.id) continue;
            let buffer = turn.items.get(item.id);
            if (!buffer) { buffer = { deltas: "", final: null, order: turn.itemOrder++ }; turn.items.set(item.id, buffer); }
            if (typeof item.text === "string") buffer.final = item.text;
            if (typeof item.phase === "string") buffer.phase = item.phase;
          }
        }
        if (status === "completed") { turn.finish(undefined, this.assembleFinalText(turn)); return; }
        if (status === "failed") {
          const message = typeof backendTurn?.error === "string" ? backendTurn.error : String(backendTurn?.error?.message ?? "Codex 轮次失败");
          turn.finish(new AppError("PROVIDER_FAILED", message));
          return;
        }
        if (status === "interrupted") {
          turn.finish(turn.timedOut ? new AppError("TIMEOUT", "Codex 轮次超时被中断")
            : turn.interruptedByUs ? new AppError("CANCELLED", "Codex 轮次已中断")
              : new AppError("TURN_INTERRUPTED", "Codex 中断了本轮执行"));
          return;
        }
        return; // inProgress 等非终态忽略
      }
      default:
        return; // 未知但格式有效的通知（如 remoteControl/status/changed）忽略
    }
  }

  /** 从当前轮的最终 assistant 消息组装结果；不从推理摘要或 stderr 抽取 JSON。 */
  private assembleFinalText(turn: TurnState): string {
    const items = [...turn.items.values()].sort((a, b) => a.order - b.order);
    // 所有场景的 commentary 都仅用于展示，不属于最终结果；旧协议无 phase 时取最后一条消息。
    const final = items.filter(item => item.phase === "final_answer").at(-1)
      ?? items.filter(item => item.phase !== "commentary").at(-1);
    return final ? final.final ?? final.deltas : "";
  }

  async sendTurn(handle: ProviderSessionHandle, request: SessionTurnRequest): Promise<ProviderResult> {
    const session = this.sessions.get(handle.key);
    check(session && session.generation === handle.generation, "PROTOCOL_STATE_INVALID", "会话句柄已失效");
    if (session.managerKey !== null && !this.manager.isCurrent(session.managerKey, session.generation)) throw new AppError("SESSION_REBUILD_REQUIRED", "会话连接已回收，需要重新打开", 409);
    check(!session.broken, "SESSION_REBUILD_REQUIRED", "会话连接已断开，需要重建上下文");
    if (session.turn) throw new AppError("PROVIDER_BUSY", "该会话已有轮次在执行", 409);
    // 持久会话在轮次期间标记忙碌，避免空闲回收；复用失败说明连接已被轮换。
    let busySlot: SessionSlot | undefined;
    if (session.managerKey !== null) {
      busySlot = await this.manager.acquire(session.managerKey, request.signal, "codex-turn");
      if (!busySlot.reused) {
        busySlot.finish();
        throw new AppError("SESSION_REBUILD_REQUIRED", "会话连接已轮换，需要重新打开", 409);
      }
    }
    const turn = createTurn(request.hostTurnId, request.emit);
    session.turn = turn;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const beginInterrupt = (timedOut: boolean) => {
      turn.timedOut = turn.timedOut || timedOut;
      turn.interruptedByUs = true;
      void this.stopActive(session, turn);
    };
    try {
      timer = setTimeout(() => beginInterrupt(true), request.timeoutMs ?? this.limits.authoringTurnTimeoutMs);
      timer.unref();
      onAbort = () => beginInterrupt(false);
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
      const params: Record<string, unknown> = { threadId: session.threadId, input: [{ type: "text", text: request.prompt, text_elements: [] }] };
      // Codex response_format 为严格结构化输出：required 需覆盖全部 properties，且仅支持少数关键字。
      // 宿主 schema 常含可选属性或 maxLength 等（如 AUTHORING_SCHEMA），不兼容时省略，仅依赖宿主校验。
      if (request.schema !== undefined && strictOutputSchema(request.schema)) params.outputSchema = request.schema;
      let backendTurnId: string | null = null;
      try {
        const response = await this.request(session, "turn/start", params, "turn/start");
        const id = (response.result as { turn?: { id?: unknown } } | undefined)?.turn?.id;
        check(id === undefined || typeof id === "string", "PROTOCOL_STATE_INVALID", "turn/start 返回无效轮次标识");
        backendTurnId = typeof id === "string" ? id : null;
        if (backendTurnId) this.bindTurnId(session, turn, backendTurnId);
        // onAccepted 必须 await；回调失败时立即中断、本轮归为不确定。
        await request.onAccepted(backendTurnId);
      } catch (error) {
        turn.interruptedByUs = true;
        void this.stopActive(session, turn);
        throw error;
      }
      const text = await turn.done;
      check(text.length > 0, "INVALID_AGENT_OUTPUT", "Codex 未返回最终消息");
      let output: unknown = text;
      if (request.schema !== undefined) {
        try { output = JSON.parse(text); } catch { throw new AppError("INVALID_AGENT_OUTPUT", `Agent 结果不是合法 JSON: ${text.slice(0, 200)}`); }
        assertSchema(output, request.schema, "Agent 输出");
      }
      return {
        output, modelId: session.modelId, modelSource: "requested", providerId: "codex-cli", toolCallCount: turn.toolItems.size,
        ...(backendTurnId ? { backendTurnId } : {}),
        ...(turn.usageSeen ? { usage: turn.usageLast, usageScope: "turn" as const } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) request.signal.removeEventListener("abort", onAbort);
      session.turn = null;
      busySlot?.finish();
    }
  }

  /** 中断活动轮：turn/interrupt → 等待终态 → 宽限后回收连接。取消确认前不允许下一轮。 */
  private async stopActive(session: CodexSession, turn: TurnState): Promise<void> {
    if (turn.settled) return;
    const turnId = turn.turnId;
    if (turnId) {
      try {
        await this.request(session, "turn/interrupt", { threadId: session.threadId, turnId }, "turn/interrupt", Math.min(this.limits.requestAckTimeoutMs, this.limits.interruptGraceMs));
      } catch { /* 中断请求失败则直接进入宽限回收 */ }
    }
    if (turn.settled) return;
    const confirmed = await Promise.race([
      turn.done.then(() => true, () => true),
      new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(false), this.limits.interruptGraceMs); timer.unref(); }),
    ]);
    if (!confirmed && !turn.settled) await session.conn.close().catch(() => {});
  }

  async interruptTurn(handle: ProviderSessionHandle, hostTurnId: string, signal: AbortSignal): Promise<void> {
    void signal;
    const session = this.sessions.get(handle.key);
    if (!session || session.generation !== handle.generation) return;
    const turn = session.turn;
    if (!turn || turn.hostTurnId !== hostTurnId || turn.settled) return;
    turn.interruptedByUs = true;
    await this.stopActive(session, turn);
  }

  getConnectionState(handle: ProviderSessionHandle): import("../domain/types.js").ConnectionState {
    const session = this.sessions.get(handle.key);
    if (!session || session.generation !== handle.generation) return "absent";
    if (session.managerKey && !this.manager.isCurrent(session.managerKey, handle.generation)) return "absent";
    if (session.broken) return "broken";
    return "ready";
  }

  async releaseSession(handle: ProviderSessionHandle): Promise<void> {
    const session = this.sessions.get(handle.key);
    if (!session || session.generation !== handle.generation) return;
    this.sessions.delete(handle.key);
    try {
      if (session.managerKey !== null) await this.manager.closeSession(session.managerKey);
      else await session.conn.close();
    } finally {
      session.pending.close(new AppError("CANCELLED", "会话已释放"));
      if (!session.slotFinished) { session.slotFinished = true; session.slot.finish(); }
    }
  }

  /** 无模型握手探测：握手后立即退出，不发 prompt、不初始化持久草稿对话。 */
  async probe(setting: ProviderSetting, signal: AbortSignal): Promise<void> {
    const slot = await this.manager.acquire(null, signal, "codex-probe");
    const pending = new PendingRequests(this.limits.requestAckTimeoutMs, this.limits.maxPendingRequestsPerConnection);
    const conn = JsonlConnection.start({
      executable: this.executable(setting),
      args: ["app-server", ...TOOL_POLICY_ARGS],
      cwd: tmpdir(),
      limits: this.limits,
      onRecord: record => {
        const value = record as CodexRecord;
        if (value && typeof value === "object" && value.id !== undefined && (value.result !== undefined || value.error !== undefined)) {
          if (value.error) pending.reject(value.id, new AppError("PROTOCOL_UNSUPPORTED", String(value.error.message ?? "Codex 探测请求失败"), 503));
          else pending.resolve(value.id, value);
        }
      },
      onDiagnostic: () => {},
      onBroken: error => pending.close(error),
    });
    try {
      const { id, promise } = pending.create("initialize", this.limits.initializeTimeoutMs);
      await conn.write(JSON.stringify({ id, method: "initialize", params: { clientInfo: { name: "orchard", version: "0.1.0" } } }));
      const response = await promise as CodexRecord;
      check(response.result !== undefined && !response.error, "PROTOCOL_UNSUPPORTED", `Codex app-server 握手失败: ${String(response.error?.message ?? "无结果")}`, 503);
      await conn.write(JSON.stringify({ method: "initialized", params: {} }));
    } finally {
      pending.close();
      await conn.close().catch(() => {});
      slot.finish();
    }
  }
}

/** thread/resume 失败分类：明确不存在或不兼容 → 重建；临时启动故障保持原引用，由调用方重试。 */
function classifyResumeError(error: unknown): AppError {
  if (error instanceof AppError && error.code === "TIMEOUT") return error;
  const message = error instanceof Error ? error.message : String(error);
  // 实测 codex-cli 0.165.0：不存在与格式非法的 threadId 均为永久性错误（后者报 "invalid session id"）。
  if (/not\s*found|unknown\s*thread|no\s*such\s*thread|invalid\s+(session|thread)|不存在|无法找到|非法/i.test(message)) {
    return new AppError("SESSION_REBUILD_REQUIRED", "Codex 线程不存在或已不兼容，需要重建上下文", 409);
  }
  return error instanceof AppError ? error : new AppError("PROVIDER_FAILED", message);
}

export function codexNativeAdapter(manager: SessionManager, limits: AgentLimits): NativeAdapter {
  const provider = new CodexAppServerProvider(manager, limits);
  return {
    sessionProvider: provider,
    capabilities: (): ProviderCapabilities => ({ modelCatalog: true, structuredOutput: "validated", tools: false, projectAnalysis: true, nativeResume: true, textStream: true, sessions: "persistent" }),
    probe: (setting, signal) => provider.probe(setting, signal),
  };
}
