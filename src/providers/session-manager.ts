import { AppError, check } from "../domain/errors.js";
import { agentLimits, type AgentLimits } from "./agent-limits.js";

/**
 * 会话专属进程的调度器（设计文档 §8、§23.1）：
 * - 全局进程上限，含探测、模型验证、单次与多轮进程；
 * - FIFO 等待队列（有界 + 超时 + 可取消）；
 * - 无空槽时先回收最久空闲连接，不等待 idleTtl 耗尽；
 * - 空闲进程按 idleTtl 回收；
 * - 连接代次：每次启动新进程前递增；复用现有进程沿用原代次；
 *   回收后同 key+generation 不得重复，晚到回调按代次拒收。
 */
interface EntryState {
  generation: number;
  close: () => Promise<void>;
  idleSince: number | null;
  closing: Promise<void> | null;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SessionSlot {
  /** true 表示复用了既有空闲连接，无需新进程。 */
  readonly reused: boolean;
  /** 复用连接的当前代次，或新进程将使用的代次。 */
  readonly generation: number;
  /** 登记新启动的进程（仅在 !reused 时调用一次）。 */
  register(close: () => Promise<void>): void;
  /**
   * 释放占用：匿名/未登记 → 直接释放槽位（调用方须先结束进程）；
   * 已登记 → 连接转为空闲（继续占用槽位，直到回收或显式关闭）。
   */
  finish(): void;
}

export class SessionManager {
  readonly limits: AgentLimits;
  private active = 0;
  private readonly entries = new Map<string, EntryState>();
  private readonly generations = new Map<string, number>();
  private readonly waiters: Waiter[] = [];
  private closed = false;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(overrides: Partial<AgentLimits> = {}) {
    this.limits = agentLimits(overrides);
    this.sweeper = setInterval(() => this.sweepIdle(), Math.min(this.limits.idleTtlMs, 30_000));
    this.sweeper.unref();
  }

  /** key 为 null 表示匿名单次进程。 */
  async acquire(key: string | null, signal: AbortSignal, purpose: string): Promise<SessionSlot> {
    check(!this.closed, "PROVIDER_UNAVAILABLE", "会话管理器已关闭");
    signal.throwIfAborted();
    if (key !== null) {
      const existing = this.entries.get(key);
      if (existing && !existing.closing) {
        check(existing.idleSince !== null, "PROVIDER_BUSY", "该会话连接正被占用");
        existing.idleSince = null; // 标记为忙，禁止回收
        const self = this;
        let finished = false;
        return {
          reused: true,
          generation: existing.generation,
          register() { throw new AppError("PROTOCOL_STATE_INVALID", "复用连接不能重复登记进程"); },
          finish() {
            if (finished) return;
            finished = true;
            if (self.entries.get(key) === existing && !existing.closing) existing.idleSince = Date.now();
          },
        };
      }
    }
    await this.reserve(signal, purpose);
    const self = this;
    let registered: EntryState | null = null;
    let finished = false;
    const generation = key !== null ? (self.generations.get(key) ?? 0) + 1 : 1;
    if (key !== null) self.generations.set(key, generation);
    const slot: SessionSlot = {
      reused: false,
      generation,
      register(close: () => Promise<void>) {
        check(key !== null && !registered && !finished, "PROTOCOL_STATE_INVALID", "会话进程登记无效");
        registered = { generation, close, idleSince: null, closing: null };
        self.entries.set(key!, registered);
      },
      finish() {
        if (finished) return;
        finished = true;
        if (registered) {
          if (self.entries.get(key!) === registered && !registered.closing) {
            registered.idleSince = Date.now();
            // 有等待者时立即尝试回收空闲连接释放容量，不等待 idleTtl 耗尽（§23.1）。
            if (self.waiters.length) self.recycleOldestIdle();
          }
        } else {
          self.active--; // 未登记进程：调用方已自行结束进程，直接归还槽位
          self.wake();
        }
      },
    };
    return slot;
  }

  /** 复用之外的容量预留：等待空槽，必要时回收最久空闲连接。 */
  private async reserve(signal: AbortSignal, purpose: string) {
    if (this.active < this.limits.maxAgentProcesses) {
      this.active++;
      return;
    }
    // 无空槽：先回收最久空闲连接再启动，不等待 idleTtl 耗尽。
    this.recycleOldestIdle();
    if (this.active < this.limits.maxAgentProcesses) {
      this.active++;
      return;
    }
    if (this.waiters.length >= this.limits.maxQueuedTurns) throw new AppError("AGENT_QUEUE_FULL", "Agent 执行队列已满，请稍后重试", 503);
    await new Promise<void>((resolve, reject) => {
      const remove = () => { const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1); };
      const waiter: Waiter = {
        resolve: () => { remove(); clearTimeout(waiter.timer); signal.removeEventListener("abort", waiter.onAbort); resolve(); },
        reject: error => { remove(); clearTimeout(waiter.timer); signal.removeEventListener("abort", waiter.onAbort); reject(error); },
        onAbort: () => waiter.reject(signal.reason instanceof AppError ? signal.reason : new AppError("CANCELLED", "等待 Agent 资源时已取消")),
        timer: setTimeout(() => waiter.reject(new AppError("TIMEOUT", `等待 Agent 进程槽位超时（${purpose}）`, 503)), this.limits.queueWaitTimeoutMs),
      };
      waiter.timer.unref();
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
    // 被唤醒的 waiter 已在 wake() 中取得槽位（active 已预增），无需再次计数。
  }

  private wake() {
    while (this.waiters.length && this.active < this.limits.maxAgentProcesses) {
      const waiter = this.waiters.shift()!;
      this.active++;
      waiter.resolve(); // 槽位已预增，唤醒后由 acquire 构建实际 slot
    }
  }

  private recycleOldestIdle() {
    let oldest: { key: string; state: EntryState; since: number } | undefined;
    for (const [key, state] of this.entries) {
      if (state.closing || state.idleSince === null) continue;
      if (!oldest || state.idleSince < oldest.since) oldest = { key, state, since: state.idleSince };
    }
    if (oldest) void this.closeEntry(oldest.key, oldest.state);
  }

  private async closeEntry(key: string, state: EntryState): Promise<void> {
    if (state.closing) return state.closing;
    state.idleSince = null;
    state.closing = (async () => {
      try { await state.close(); } finally {
        if (this.entries.get(key) === state) this.entries.delete(key);
        this.active--;
        this.wake();
      }
    })();
    return state.closing;
  }

  private sweepIdle() {
    const now = Date.now();
    for (const [key, state] of this.entries) {
      if (state.closing || state.idleSince === null) continue;
      if (now - state.idleSince >= this.limits.idleTtlMs) void this.closeEntry(key, state);
    }
  }

  /** 当前代次校验：回收或轮换后旧代次回调不得写入新轮次。 */
  isCurrent(key: string, generation: number): boolean {
    const state = this.entries.get(key);
    return !!state && !state.closing && state.generation === generation;
  }

  /** 关闭指定会话连接（若仍存活），释放槽位。 */
  async closeSession(key: string): Promise<void> {
    const state = this.entries.get(key);
    if (state) await this.closeEntry(key, state);
  }

  /** 停止接收新任务并清理所有连接；任一失败也继续清理其他连接，最后汇总错误。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweeper);
    const errors: unknown[] = [];
    for (const waiter of this.waiters.splice(0)) waiter.reject(new AppError("CANCELLED", "服务关闭，等待中的任务已取消"));
    for (const [key, state] of [...this.entries]) {
      try { await this.closeEntry(key, state); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AppError("PROVIDER_UNAVAILABLE", `关闭 Agent 连接时发生 ${errors.length} 个错误`);
  }
}
