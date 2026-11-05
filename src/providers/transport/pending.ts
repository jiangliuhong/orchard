import { AppError } from "../../domain/errors.js";

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/**
 * 请求 ID 关联表（设计文档 §8）：
 * - 请求 ID 在单个连接内唯一递增；
 * - 每个请求有独立的响应确认超时；
 * - 连接关闭时统一 reject，避免悬挂 Promise。
 */
export class PendingRequests {
  private next = 0;
  private readonly entries = new Map<number, PendingEntry>();
  private closed = false;

  constructor(private readonly defaultAckTimeoutMs: number, private readonly maxPending = Number.POSITIVE_INFINITY) {}

  get size() { return this.entries.size; }

  /** 分配新请求 ID 并登记待响应 Promise；连接关闭或超时后拒绝。 */
  create(label: string, timeoutMs = this.defaultAckTimeoutMs): { id: number; promise: Promise<unknown> } {
    if (this.closed) throw new AppError("PROTOCOL_STATE_INVALID", "连接已关闭，不能发送新请求");
    if (this.entries.size >= this.maxPending) throw new AppError("OUTPUT_LIMIT", `连接上未完成请求过多: ${label}`);
    const id = ++this.next;
    let entry!: PendingEntry;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.entries.get(id) === entry && !entry.settled) {
          entry.settled = true;
          this.entries.delete(id);
          reject(new AppError("TIMEOUT", `请求等待响应超时: ${label}`));
        }
      }, timeoutMs);
      timer.unref();
      entry = { resolve, reject, timer, settled: false };
      this.entries.set(id, entry);
    });
    return { id, promise };
  }

  resolve(id: unknown, value: unknown): boolean {
    if (typeof id !== "number") return false;
    const entry = this.entries.get(id);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    entry.resolve(value);
    return true;
  }

  reject(id: unknown, error: unknown): boolean {
    if (typeof id !== "number") return false;
    const entry = this.entries.get(id);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    entry.reject(error);
    return true;
  }

  /** 关闭时统一拒绝所有未完成请求；重复调用安全。 */
  close(error: Error = new AppError("PROCESS_EXITED_UNEXPECTEDLY", "连接已关闭")) {
    this.closed = true;
    for (const entry of this.entries.values()) {
      entry.settled = true;
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.entries.clear();
  }
}
