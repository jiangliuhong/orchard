import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { AppError, check } from "../domain/errors.js";
import type { ProviderCapabilities, ProviderSetting } from "../domain/types.js";
import { assertSchema } from "../domain/validation.js";
import type { AgentLimits } from "./agent-limits.js";
import type { BackendRef, NativeAdapter, ProviderEvent, ProviderSessionHandle, SessionOpenRequest, SessionProvider, SessionTurnRequest } from "./session.js";
import { SessionManager, type SessionSlot } from "./session-manager.js";
import { PendingRequests } from "./transport/pending.js";
import { JsonlConnection } from "./transport/jsonl.js";
import type { ProviderResult } from "./registry.js";

/**
 * Pi RPC 适配器（设计文档 §7、§21.3）。
 *
 * - 启动 `pi --mode rpc --no-extensions --no-mcp --no-tools --thinking off --model <id>`，
 *   参数由数组构造不拼 shell；临时会话加 `--no-session`；
 * - 新持久会话使用受控 `--session-dir` 与宿主 UUID `--session-id`；恢复使用已验证的绝对
 *   `--session <file>`（realpath 层校验，拒绝越界 symlink、缺失文件、目录冒充文件与超预算文件）；
 * - 新进程先 `get_state` 确认模型、sessionId 与 isStreaming=false，恢复后同样检查；
 * - `prompt` 成功只表示接受/排队/处理：disposition=started 才接受为本轮执行；
 *   queued/handed 在本 feature 的无扩展、禁并发前提下属于非预期 → PROTOCOL_STATE_INVALID 并清理连接；
 * - 执行中的最终空闲边界是 `agent_settled`，不能只根据一次 agent_end 结束轮次；
 * - 中断先 `clear_queue`（响应后再 abort）；即使 clear_queue 失败仍尝试 abort，
 *   最终无法确认 settled 时终止进程；中断使用独立控制路径，不复用生成 signal；
 * - sessionFile 延迟创建时允许“尚未生成”，首轮接受后经 get_state 补充实际文件。
 */

interface AssistantCapture {
  text: string;
  model?: string;
  usage?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

interface TurnState {
  hostTurnId: string;
  promptId: string;
  /** 排队/重试期间的临时错误不能提前当最终错误。 */
  lastAssistant: AssistantCapture | null;
  settled: boolean;
  interruptedByUs: boolean;
  timedOut: boolean;
  textBytes: number;
  protocolBytes: number;
  emit: (event: ProviderEvent) => void;
  done: Promise<string>;
  finish: (error?: AppError, text?: string) => void;
}

interface PiSession {
  conn: JsonlConnection;
  pending: PendingRequests;
  sessionId: string;
  /** get_state 返回的实际会话文件；Pi 延迟创建时可能尚未生成。 */
  sessionFile: string | null;
  modelId: string;
  cwd: string;
  sessionDir: string | null;
  generation: number;
  managerKey: string | null;
  slot: SessionSlot;
  slotFinished: boolean;
  broken: AppError | undefined;
  turn: TurnState | null;
  /** 首轮 prompt 接受后需要通过 get_state 刷新会话引用。 */
  needsStateRefresh: boolean;
  handle: ProviderSessionHandle | null;
}

function createTurn(hostTurnId: string, promptId: string, emit: (event: ProviderEvent) => void): TurnState {
  const state = {} as TurnState;
  state.hostTurnId = hostTurnId;
  state.promptId = promptId;
  state.lastAssistant = null;
  state.settled = false;
  state.interruptedByUs = false;
  state.timedOut = false;
  state.textBytes = 0;
  state.protocolBytes = 0;
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
  void state.done.catch(() => {});
  return state;
}

export class PiRpcProvider implements SessionProvider {
  private readonly sessions = new Map<string, PiSession>();

  constructor(private readonly manager: SessionManager, private readonly limits: AgentLimits) {}

  private executable(setting: ProviderSetting) {
    const executable = setting.config.executable;
    check(typeof executable === "string" && executable.length > 0 && executable.startsWith("/"), "INVALID_EXECUTABLE", "CLI 路径必须为绝对路径");
    return executable;
  }

  /**
   * 校验恢复用的 Pi 会话文件：必须位于宿主管理目录内（realpath 层），
   * 拒绝越界 symlink、缺失文件、目录冒充文件与超出大小预算的文件。
   */
  private validateSessionFile(file: string, managedRoot: string): string {
    check(typeof file === "string" && file.length > 0 && isAbsolute(file), "PROTOCOL_STATE_INVALID", "Pi 会话文件必须是绝对路径");
    let real: string;
    try {
      real = realpathSync(file);
    } catch {
      // Pi 延迟创建 sessionFile 时允许“尚未生成”；但服务重启后不能把缺失文件当成功恢复。
      throw new AppError("SESSION_REBUILD_REQUIRED", "Pi 会话文件不存在，不能恢复，需要重建上下文", 409);
    }
    const root = realpathSync(managedRoot);
    check(real.startsWith(root + "/"), "PROTOCOL_STATE_INVALID", "Pi 会话文件超出宿主管理目录");
    const info = lstatSync(real);
    check(info.isFile() && !info.isSymbolicLink(), "PROTOCOL_STATE_INVALID", "Pi 会话文件不是常规文件");
    check(info.size <= this.limits.maxSessionFileBytes, "OUTPUT_LIMIT", "Pi 会话文件超过大小预算");
    return real;
  }

  private spawn(setting: ProviderSetting, session: PiSession, args: string[]): void {
    const pending = new PendingRequests(this.limits.requestAckTimeoutMs, this.limits.maxPendingRequestsPerConnection);
    const conn = JsonlConnection.start({
      executable: this.executable(setting),
      args,
      cwd: session.cwd,
      limits: this.limits,
      onRecord: record => this.routeRecord(session, record),
      onDiagnostic: text => this.captureDiagnostic(session, text),
      onBroken: error => this.handleBroken(session, error),
    });
    session.conn = conn;
    session.pending = pending;
  }

  private baseArgs(modelId: string): string[] {
    // 继续关闭 tools、extensions 和 MCP；不引入 Pi SDK 依赖。
    return ["--mode", "rpc", "--no-extensions", "--no-mcp", "--no-tools", "--thinking", "off", "--model", modelId];
  }

  async openSession(setting: ProviderSetting, request: SessionOpenRequest): Promise<ProviderSessionHandle> {
    const managerKey = request.persistent ? request.key : null;
    // 复用既有空闲连接：同一逻辑会话、同代次、同模型、连接健康。
    if (managerKey !== null) {
      const existing = this.sessions.get(managerKey);
      if (existing && !existing.broken && existing.modelId === request.modelId && this.manager.isCurrent(managerKey, existing.generation)) {
        const slot = await this.manager.acquire(managerKey, request.signal, "pi-reuse");
        if (slot.reused && !existing.broken) {
          slot.finish();
          return { key: request.key, generation: existing.generation, ref: this.refOf(existing) };
        }
        slot.finish();
        this.sessions.delete(managerKey);
      }
    }
    const slot = await this.manager.acquire(managerKey, request.signal, "pi-open");
    let session: PiSession | undefined;
    let registered = false;
    try {
      const args = this.baseArgs(request.modelId);
      let sessionDir: string | null = null, sessionId: string = randomUUID(), resumeFile: string | undefined;
      if (request.persistent) {
        if (request.resumeRef?.kind === "pi") {
          check(request.resumeRef.cwd === request.cwd, "PROTOCOL_STATE_INVALID", "恢复会话的工作目录与记录不一致");
          // 恢复使用已经验证的绝对 --session <file>，不使用“最新会话”或模糊 ID。
          resumeFile = this.validateSessionFile(request.resumeRef.sessionFile, this.piSessionsRoot(request.cwd));
          sessionId = request.resumeRef.sessionId;
          args.push("--session", resumeFile);
        } else {
          // 新持久会话：受控 session 存储目录（0700）+ 宿主 UUID；cwd 为专属工作目录。
          sessionDir = join(this.piSessionsRoot(request.cwd), request.key);
          mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
          args.push("--session-dir", sessionDir, "--session-id", sessionId);
        }
      } else {
        args.push("--no-session");
      }
      session = {
        conn: undefined!, pending: undefined!, sessionId, sessionFile: resumeFile ?? null,
        modelId: request.modelId, cwd: request.cwd, sessionDir, generation: slot.generation,
        managerKey, slot, slotFinished: false, broken: undefined, turn: null, needsStateRefresh: true, handle: null,
      };
      this.spawn(setting, session, args);
      await this.verifyState(session);
      if (managerKey !== null) {
        slot.register(() => session!.conn.close());
        registered = true;
        slot.finish();
      }
      const handle: ProviderSessionHandle = { key: request.key, generation: slot.generation, ref: this.refOf(session) };
      session.handle = handle;
      this.sessions.set(managerKey ?? request.key, session);
      return handle;
    } catch (error) {
      if (session?.conn) await session.conn.close().catch(() => {});
      if (managerKey !== null && registered) await this.manager.closeSession(managerKey).catch(() => {});
      if (session) this.sessions.delete(managerKey ?? request.key);
      slot.finish();
      throw error;
    }
  }

  /** cwd 为 <root>/agent-workspaces/<conversationId>；Pi 会话根为其同级目录 <root>/agent-sessions/pi。 */
  private piSessionsRoot(cwd: string): string {
    const workspaceRoot = cwd.split("/").slice(0, -1).join("/");
    const root = workspaceRoot.split("/").slice(0, -1).join("/");
    return join(root || "/", "agent-sessions", "pi");
  }

  private refOf(session: PiSession): BackendRef {
    // Pi 延迟创建 sessionFile 时先报告预分配路径（尚未生成的占位），首轮接受后刷新。
    return { version: 1, kind: "pi", sessionId: session.sessionId, sessionFile: session.sessionFile ?? this.preallocatedFile(session), cwd: session.cwd };
  }

  private preallocatedFile(session: PiSession): string {
    return session.sessionDir ? join(session.sessionDir, `${session.sessionId}.jsonl`) : join(session.cwd, `${session.sessionId}.jsonl`);
  }

  /** 新进程与恢复后的第一件事：get_state 确认模型、sessionId 与 isStreaming=false。 */
  private async verifyState(session: PiSession): Promise<void> {
    const response = await this.command(session, "get_state", "get_state", this.limits.initializeTimeoutMs);
    const data = (response as { data?: Record<string, unknown> }).data;
    check(data && typeof data === "object", "PROTOCOL_STATE_INVALID", "Pi get_state 未返回状态");
    const model = data.model as { id?: unknown; provider?: unknown } | undefined;
    // 模型目录保存 provider/id，而 Pi get_state 将 provider 与 id 分开返回。
    // 同时兼容手动配置的原始 id；不可按 / 截断，因为 provider 和 id 都可能包含 /。
    const actualModel = typeof model?.provider === "string" && model.provider
      ? `${model.provider}/${String(model.id)}` : String(model?.id);
    check(!model || typeof model.id !== "string" || model.id === session.modelId || actualModel === session.modelId,
      "PROTOCOL_STATE_INVALID", `Pi 实际模型与请求不一致: 请求 ${session.modelId}，实际 ${actualModel}`);
    check(data.isStreaming !== true, "PROTOCOL_STATE_INVALID", "Pi 新会话不能处于流式执行状态");
    if (typeof data.sessionId === "string" && data.sessionId) session.sessionId = data.sessionId;
    if (typeof data.sessionFile === "string" && data.sessionFile) {
      // 受控目录内的实际文件；越界路径不接受。
      try {
        const real = realpathSync(data.sessionFile);
        if (session.sessionDir ? real.startsWith(realpathSync(session.sessionDir) + "/") : true) session.sessionFile = real;
      } catch { /* 文件可能尚未生成 */ }
    }
  }

  private command(session: PiSession, type: string, label: string, timeoutMs = this.limits.requestAckTimeoutMs, extra: Record<string, unknown> = {}): Promise<unknown> {
    const { id, promise } = session.pending.create(label, timeoutMs);
    void session.conn.write(JSON.stringify({ id, type, ...extra })).catch(error => session.pending.reject(id, error));
    return promise;
  }

  private captureDiagnostic(session: PiSession, text: string) {
    const turn = session.turn;
    if (!turn || turn.settled) return;
    turn.protocolBytes += Buffer.byteLength(text);
    if (turn.protocolBytes > this.limits.maxTurnProtocolBytes) turn.finish(new AppError("OUTPUT_LIMIT", "本轮诊断与协议累计超过上限"));
    else if (turn.protocolBytes <= this.limits.maxTurnDiagnosticBytes) turn.emit({ type: "provider.diagnostic", payload: { text } });
  }

  private handleBroken(session: PiSession, error: AppError) {
    session.broken = error;
    session.pending.close(error);
    const turn = session.turn;
    if (turn && !turn.settled) {
      turn.finish(turn.timedOut ? new AppError("TIMEOUT", "Pi 轮次超时且进程已回收")
        : turn.interruptedByUs ? new AppError("CANCELLED", "Pi 轮次中断且进程已回收")
          : error);
    }
    if (session.managerKey !== null) void this.manager.closeSession(session.managerKey).catch(() => {});
  }

  private routeRecord(session: PiSession, record: unknown) {
    if (!record || typeof record !== "object") return;
    const value = record as { id?: unknown; type?: unknown; command?: unknown; success?: unknown; data?: unknown; error?: unknown; assistantMessageEvent?: unknown; message?: unknown; aborted?: unknown };
    if (value.type === "response") {
      if (typeof value.id === "string" || typeof value.id === "number") {
        if (value.success === false) session.pending.reject(value.id, new AppError("PROVIDER_FAILED", String(value.error ?? "Pi 命令失败")));
        else session.pending.resolve(value.id, value);
      }
      // 无 id 的 parse 响应表示对端收到非法 JSON：记录诊断，连接交由上层判断。
      return;
    }
    const turn = session.turn;
    if (!turn || turn.settled) return;
    turn.protocolBytes += Buffer.byteLength(JSON.stringify(record));
    if (turn.protocolBytes > this.limits.maxTurnProtocolBytes) {
      turn.finish(new AppError("OUTPUT_LIMIT", "本轮协议累计超过上限"));
      return;
    }
    switch (value.type) {
      case "message_update": {
        const event = value.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
        if (event?.type !== "text_delta" || typeof event.delta !== "string" || !event.delta) return;
        const bytes = Buffer.byteLength(event.delta);
        if (turn.textBytes + bytes > this.limits.maxTurnTextBytes) {
          turn.finish(new AppError("OUTPUT_LIMIT", "本轮文本超过 8 MiB 上限"));
          return;
        }
        turn.emit({ type: "provider.text", payload: { text: event.delta, offset: turn.textBytes } });
        turn.textBytes += bytes;
        return;
      }
      case "message_end":
      case "turn_end": {
        // 保留最后一个 assistant 消息；重试过程中的中间消息会被后续覆盖。
        const message = value.message as { role?: unknown; content?: { type: string; text?: string }[]; model?: unknown; usage?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
        if (!message || message.role !== "assistant") return;
        const text = (message.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("");
        turn.lastAssistant = {
          text,
          ...(typeof message.model === "string" ? { model: message.model } : {}),
          ...(message.usage !== undefined ? { usage: message.usage } : {}),
          ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
          ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
        };
        return;
      }
      case "agent_end":
        return; // 低层运行结束；重试/恢复仍可能继续，等待 agent_settled
      case "agent_settled": {
        // 执行中的最终空闲边界：settled 后检查最终 assistant 消息与 stopReason。
        if (turn.interruptedByUs || value.aborted === true) {
          turn.finish(turn.timedOut ? new AppError("TIMEOUT", "Pi 轮次超时被中止") : new AppError("CANCELLED", "Pi 轮次已中止"));
          return;
        }
        const last = turn.lastAssistant;
        if (last?.stopReason === "error") {
          turn.finish(new AppError("PROVIDER_FAILED", last.errorMessage ?? "Pi 模型执行失败"));
          return;
        }
        if (!last || !last.text) {
          turn.finish(new AppError("INVALID_AGENT_OUTPUT", "Pi 未返回最终消息"));
          return;
        }
        turn.finish(undefined, last.text);
        return;
      }
      default:
        return; // 其他会话事件（重试、压缩等）不影响轮次边界
    }
  }

  async sendTurn(handle: ProviderSessionHandle, request: SessionTurnRequest): Promise<ProviderResult> {
    const session = this.sessions.get(handle.key);
    check(session && session.generation === handle.generation, "PROTOCOL_STATE_INVALID", "会话句柄已失效");
    if (session.managerKey !== null && !this.manager.isCurrent(session.managerKey, session.generation)) throw new AppError("SESSION_REBUILD_REQUIRED", "会话连接已回收，需要重新打开", 409);
    check(!session.broken, "SESSION_REBUILD_REQUIRED", "会话连接已断开，需要重建上下文");
    if (session.turn) throw new AppError("PROVIDER_BUSY", "该会话已有轮次在执行", 409);
    let busySlot: SessionSlot | undefined;
    if (session.managerKey !== null) {
      busySlot = await this.manager.acquire(session.managerKey, request.signal, "pi-turn");
      if (!busySlot.reused) {
        busySlot.finish();
        throw new AppError("SESSION_REBUILD_REQUIRED", "会话连接已轮换，需要重新打开", 409);
      }
    }
    const promptId = `p${randomUUID()}`;
    const turn = createTurn(request.hostTurnId, promptId, request.emit);
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
      let disposition: unknown;
      try {
        const response = await this.command(session, "prompt", "prompt", this.limits.requestAckTimeoutMs, { message: request.prompt }) as { data?: { disposition?: unknown } };
        disposition = response.data?.disposition;
        // disposition=started 才接受为本轮执行；queued/handled 属非预期，清理连接。
        check(disposition === "started", "PROTOCOL_STATE_INVALID", `Pi prompt 未启动执行（disposition=${String(disposition)}）`);
        await request.onAccepted(promptId);
      } catch (error) {
        if (error instanceof AppError && error.code === "PROTOCOL_STATE_INVALID") {
          // 协议状态异常：清理连接，不等待永远不会到来的完成事件。
          await this.killSession(session, error);
        } else {
          turn.interruptedByUs = true;
          void this.stopActive(session, turn);
        }
        throw error;
      }
      const text = await turn.done;
      let output: unknown = text;
      if (request.schema !== undefined) {
        try { output = JSON.parse(text); } catch { throw new AppError("INVALID_AGENT_OUTPUT", `Agent 结果不是合法 JSON: ${text.slice(0, 200)}`); }
        assertSchema(output, request.schema, "Agent 输出");
      }
      const last = turn.lastAssistant;
      // 首轮接受后通过 get_state 补充实际会话文件（Pi 延迟创建 sessionFile）。
      if (session.needsStateRefresh) {
        session.needsStateRefresh = false;
        void this.refreshStateQuietly(session);
      }
      return {
        output,
        modelId: last?.model ?? session.modelId,
        modelSource: last?.model ? "reported" : "requested",
        providerId: "pi-cli",
        backendTurnId: promptId,
        ...(last?.usage !== undefined ? { usage: last.usage, usageScope: "turn" as const } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) request.signal.removeEventListener("abort", onAbort);
      session.turn = null;
      busySlot?.finish();
    }
  }

  /** 标记会话损坏并清理连接（协议状态异常时使用，不等待永远不会到来的完成事件）。 */
  private async killSession(session: PiSession, reason: AppError): Promise<void> {
    session.broken = reason;
    session.pending.close(reason);
    await session.conn.close().catch(() => {});
    if (session.managerKey !== null) await this.manager.closeSession(session.managerKey).catch(() => {});
  }

  private async refreshStateQuietly(session: PiSession) {
    try {
      await this.command(session, "get_state", "get_state-refresh", this.limits.requestAckTimeoutMs);
      if (session.handle && session.managerKey !== null) session.handle.ref = this.refOf(session);
    } catch { /* 刷新失败不影响已完成的轮次 */ }
  }

  /** 中断：clear_queue 响应后才能 abort；即使 clear_queue 失败仍尝试 abort；无法确认 settled 时终止进程。 */
  private async stopActive(session: PiSession, turn: TurnState): Promise<void> {
    if (turn.settled) return;
    try {
      await this.command(session, "clear_queue", "clear_queue", Math.min(this.limits.requestAckTimeoutMs, this.limits.interruptGraceMs));
    } catch { /* 即使 clear_queue 失败仍尝试 abort */ }
    if (turn.settled) return;
    try {
      await this.command(session, "abort", "abort", Math.min(this.limits.requestAckTimeoutMs, this.limits.interruptGraceMs));
    } catch { /* 最终通过宽限回收兜底 */ }
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

  /** 无模型握手探测：get_state 成功即退出，不发 prompt。 */
  async probe(setting: ProviderSetting, signal: AbortSignal): Promise<void> {
    const slot = await this.manager.acquire(null, signal, "pi-probe");
    const pending = new PendingRequests(this.limits.requestAckTimeoutMs, this.limits.maxPendingRequestsPerConnection);
    const conn = JsonlConnection.start({
      executable: this.executable(setting),
      // 探测不依赖具体模型，避免因模型目录问题误判协议可用性。
      args: ["--mode", "rpc", "--no-extensions", "--no-mcp", "--no-tools", "--thinking", "off", "--no-session"],
      cwd: tmpdir(),
      limits: this.limits,
      onRecord: record => {
        const value = record as { id?: unknown; type?: unknown; success?: unknown; error?: unknown };
        if (value && typeof value === "object" && value.type === "response" && value.id !== undefined) {
          if (value.success === false) pending.reject(value.id, new AppError("PROTOCOL_UNSUPPORTED", String(value.error ?? "Pi 探测命令失败"), 503));
          else pending.resolve(value.id, value);
        }
      },
      onDiagnostic: () => {},
      onBroken: error => pending.close(error),
    });
    try {
      const { id, promise } = pending.create("get_state", this.limits.initializeTimeoutMs);
      await conn.write(JSON.stringify({ id, type: "get_state" }));
      const response = await promise as { success?: unknown; error?: unknown };
      check(response.success === true, "PROTOCOL_UNSUPPORTED", `Pi RPC 握手失败: ${String(response.error ?? "无结果")}`, 503);
    } finally {
      pending.close();
      await conn.close().catch(() => {});
      slot.finish();
    }
  }
}

export function piNativeAdapter(manager: SessionManager, limits: AgentLimits): NativeAdapter {
  const provider = new PiRpcProvider(manager, limits);
  return {
    sessionProvider: provider,
    capabilities: (): ProviderCapabilities => ({ modelCatalog: true, structuredOutput: "validated", tools: false, nativeResume: true, textStream: true, sessions: "persistent" }),
    probe: (setting, signal) => provider.probe(setting, signal),
  };
}
