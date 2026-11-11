import { AppError } from "../domain/errors.js";

type Release = () => void;
interface Waiter {
  mode: "read" | "write";
  signal: AbortSignal;
  resolve(release: Release): void;
  reject(reason: unknown): void;
  abort(): void;
}

/** FIFO 读写锁：同批读者可并发，已排队写者不会被后来读者饿死。
 * 取消只移除等待者，不能强制释放运行中 action 的租约；释放必须在 finally 中完成。
 * 进程内锁不能替代数据目录单写者锁或持久化 operation 状态。
 */
export class AsyncReadWriteLock {
  private readers = 0;
  private writer = false;
  private readonly queue: Waiter[] = [];

  private acquire(mode: Waiter["mode"], signal: AbortSignal): Promise<Release> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        mode, signal, resolve, reject,
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", waiter.abort);
          reject(signal.reason ?? new AppError("CANCELLED", "锁等待已取消"));
          this.drain();
        },
      };
      this.queue.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
      this.drain();
    });
  }

  private drain(): void {
    if (this.writer) return;
    while (this.queue.length) {
      const waiter = this.queue[0]!;
      if (waiter.mode === "write" && this.readers) return;
      this.queue.shift();
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.mode === "read") this.readers++;
      else this.writer = true;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        if (waiter.mode === "read") this.readers--;
        else this.writer = false;
        this.drain();
      });
      if (waiter.mode === "write") return;
    }
  }

  private async run<T>(mode: Waiter["mode"], signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const release = await this.acquire(mode, signal);
    try { signal.throwIfAborted(); return await action(); }
    finally { release(); }
  }

  read<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> { return this.run("read", signal, action); }
  write<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> { return this.run("write", signal, action); }
}

/** 发送、切模型、删除与提案应用须使用同一个实例/对话键。不允许同键重入。 */
export class ConversationLocks {
  private readonly entries = new Map<string, { lock: AsyncReadWriteLock; users: number }>();

  async run<T>(conversationId: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let entry = this.entries.get(conversationId);
    if (!entry) { entry = { lock: new AsyncReadWriteLock(), users: 0 }; this.entries.set(conversationId, entry); }
    entry.users++;
    try { return await entry.lock.write(signal, action); }
    finally { if (--entry.users === 0) this.entries.delete(conversationId); }
  }
}
