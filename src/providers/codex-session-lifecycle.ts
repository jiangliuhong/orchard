import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ManagedSessionStore } from "./managed-session-store.js";
import { AppError, check } from "../domain/errors.js";
import { validateSessionReference, type DeleteResult, type NativeSessionState, type ProviderSessionLifecycle, type ProviderSessionReference, type SessionLifecycleGuard } from "../agent/provider-contract.js";
import { TOOL_POLICY_ARGS } from "./codex-app-server.js";
import { SessionManager } from "./session-manager.js";
import { JsonlConnection } from "./transport/jsonl.js";
import { PendingRequests } from "./transport/pending.js";

const SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
type Request = (method: string, params: unknown) => Promise<unknown>;

/** P0 独立适配器；不从旧业务入口开放删除，不修改原生文件或平台数据库。
 * storageHome 必须与创建会话时的 CODEX_HOME 一致且由宿主确认归属。
 */
export class CodexSessionLifecycle implements ProviderSessionLifecycle {
  private readonly storage: ManagedSessionStore;
  constructor(private readonly options: {
    executable: string;
    storageHome: string;
    manager: SessionManager;
    guard: SessionLifecycleGuard;
    providerId?: string;
  }) {
    check(isAbsolute(options.executable) && isAbsolute(options.storageHome), "BACKEND_REFERENCE_INVALID", "Codex 路径必须是绝对路径");
    check(realpathSync(options.storageHome) === options.storageHome, "BACKEND_REFERENCE_INVALID", "Codex 存储根不能包含符号链接");
    const info = lstatSync(options.storageHome);
    check(info.isDirectory(), "BACKEND_REFERENCE_INVALID", "Codex 存储根必须是目录");
    this.storage = ManagedSessionStore.open(options.storageHome, options.providerId ?? "codex-cli");
  }

  private threadId(reference: ProviderSessionReference): string {
    const validated = validateSessionReference(reference, {
      providerId: this.options.providerId ?? "codex-cli", supportedVersions: [1],
      validatePayload: value => {
        check(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 3,
          "BACKEND_REFERENCE_INVALID", "Codex 引用 payload 无效");
        check(typeof value.threadId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.threadId) && value.storageHome === this.options.storageHome,
          "BACKEND_REFERENCE_INVALID", "Codex 原生身份或存储范围不匹配");
        check(typeof value.storeId === "string", "BACKEND_REFERENCE_INVALID", "Codex 存储身份缺失");
        this.storage.assert(value.storeId);
      },
    });
    return (validated.opaque as { threadId: string }).threadId;
  }

  private verifyHome(): void {
    this.storage.assert();
  }

  private async control<T>(signal: AbortSignal, action: (request: Request) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    this.verifyHome();
    const { manager } = this.options;
    const slot = await manager.acquire(null, signal, "codex-lifecycle");
    const pending = new PendingRequests(manager.limits.requestAckTimeoutMs, manager.limits.maxPendingRequestsPerConnection);
    let conn: JsonlConnection | undefined;
    const abort = () => { pending.close(new AppError("CANCELLED", "Codex 生命周期操作已取消，删除交付状态需核对")); void conn?.close(); };
    try {
      signal.throwIfAborted();
      conn = JsonlConnection.start({
        executable: this.options.executable, args: ["app-server", ...TOOL_POLICY_ARGS], cwd: this.options.storageHome,
        env: { CODEX_HOME: this.options.storageHome }, limits: manager.limits,
        onDiagnostic: () => {}, onBroken: error => pending.close(error),
        onRecord: record => {
          check(record !== null && typeof record === "object" && !Array.isArray(record), "PROTOCOL_STATE_INVALID", "Codex 控制响应无效");
          const message = record as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
          // 控制连接绝不接受工具/审批请求，也不把不相关通知当作删除确认。
          if (message.method !== undefined) {
            if (message.id !== undefined) pending.close(new AppError("PROTOCOL_STATE_INVALID", "Codex 控制连接收到非预期服务端请求"));
            return;
          }
          if (message.error !== undefined || Object.hasOwn(message, "result")) pending.resolve(message.id, message);
          else pending.close(new AppError("PROTOCOL_STATE_INVALID", "Codex 控制响应缺少结果"));
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const request: Request = async (method, params) => {
        signal.throwIfAborted();
        this.verifyHome();
        const { id, promise } = pending.create(method, method === "initialize" ? manager.limits.initializeTimeoutMs : undefined);
        // 先消费 promise，避免同步写入失败时留下未处理的拒绝。
        void conn!.write(JSON.stringify({ id, method, params })).catch(error => pending.reject(id, error));
        const response = await promise as { result?: unknown; error?: { code?: unknown; message?: unknown } };
        if (response.error !== undefined) {
          const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
          // 0.167.0 实测：精确读取不存在目标返回该错误。不得将任意错误/权限失败归为不存在。
          if (method === "thread/read" && response.error?.code === -32600 && typeof threadId === "string" && response.error.message === `thread not loaded: ${threadId}`) {
            throw new AppError("NATIVE_SESSION_NOT_FOUND", "Codex 未找到精确原生目标");
          }
          throw new AppError("NATIVE_DELETE_FAILED", "Codex 控制请求失败，需核对原生状态");
        }
        return response.result;
      };
      await request("initialize", { clientInfo: { name: "orchard-lifecycle", version: "0.1.0" } });
      await conn.write(JSON.stringify({ method: "initialized", params: {} }));
      return await action(request);
    } finally {
      signal.removeEventListener("abort", abort);
      pending.close();
      try { await conn?.close(); } finally { slot.finish(); }
    }
  }

  /** 列表可隐藏无普通轮次的会话；先精确读取。明确缺失错误后仍核对完整列表。
   * 不按 cwd/模型/默认交互来源过滤；权限、格式及其他协议错误均不是“不存在”。
   */
  private async state(request: Request, threadId: string): Promise<"present" | "absent"> {
    try {
      const result = await request("thread/read", { threadId, includeTurns: false }) as { thread?: { id?: unknown } } | null;
      check(result !== null && typeof result === "object" && result.thread?.id === threadId, "PROTOCOL_STATE_INVALID", "Codex 精确读取返回了不同或无效的会话");
      return "present";
    } catch (error) {
      if (!(error instanceof AppError && error.code === "NATIVE_SESSION_NOT_FOUND")) throw error;
    }
    for (const archived of [false, true]) {
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; ; page++) {
        check(page < 1000, "OUTPUT_LIMIT", "Codex 会话状态核对超过分页预算");
        const result = await request("thread/list", { archived, cursor, limit: 100, modelProviders: [], sourceKinds: SOURCE_KINDS });
        check(result !== null && typeof result === "object", "PROTOCOL_STATE_INVALID", "Codex 会话列表无效");
        const list = result as { data?: unknown; nextCursor?: unknown };
        check(Array.isArray(list.data) && Object.hasOwn(list, "nextCursor") && (list.nextCursor === null || (typeof list.nextCursor === "string" && list.nextCursor.length > 0)),
          "PROTOCOL_STATE_INVALID", "Codex 分页响应无效");
        for (const item of list.data) {
          check(item !== null && typeof item === "object" && typeof item.id === "string", "PROTOCOL_STATE_INVALID", "Codex 会话条目无效");
          if (item.id === threadId) return "present";
        }
        if (list.nextCursor === null) break;
        check(!seen.has(list.nextCursor as string), "PROTOCOL_STATE_INVALID", "Codex 分页游标循环");
        cursor = list.nextCursor as string;
        seen.add(cursor);
      }
    }
    this.verifyHome();
    return "absent";
  }

  async inspect(reference: ProviderSessionReference, signal: AbortSignal): Promise<NativeSessionState> {
    signal.throwIfAborted();
    try {
      const threadId = this.threadId(reference);
      return { status: await this.control(signal, request => this.state(request, threadId)) };
    }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof AppError && ["BACKEND_REFERENCE_INVALID", "BACKEND_PROVIDER_MISMATCH", "BACKEND_REFERENCE_VERSION_UNSUPPORTED"].includes(error.code)) throw error;
      return { status: "unknown", reason: error instanceof AppError ? error.code : "BACKEND_STORAGE_UNAVAILABLE" };
    }
  }

  async deleteSession(reference: ProviderSessionReference, signal: AbortSignal): Promise<DeleteResult> {
    this.threadId(reference);
    signal.throwIfAborted();
    return this.options.guard.withStoppedSession(reference, signal, () => this.control(signal, async request => {
      const threadId = this.threadId(reference);
      if (await this.state(request, threadId) === "absent") return { status: "already_absent" };
      await request("thread/delete", { threadId });
      check(await this.state(request, threadId) === "absent", "NATIVE_DELETE_UNCONFIRMED", "Codex 删除后目标仍存在，不能报告成功");
      return { status: "deleted" };
    }));
  }
}
