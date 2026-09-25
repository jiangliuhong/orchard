export interface QueueTask<T> {
  readonly id: string;
  readonly run: (signal: AbortSignal) => Promise<T>;
}

interface Pending<T> extends QueueTask<T> {
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly controller: AbortController;
}

export class RunQueue {
  private readonly pending: Pending<unknown>[] = [];
  private readonly active = new Map<string, Pending<unknown>>();
  private closed = false;

  constructor(private readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Queue concurrency must be a positive integer");
  }

  get activeCount(): number { return this.active.size; }
  get queuedCount(): number { return this.pending.length; }

  enqueue<T>(task: QueueTask<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Run queue is closed"));
    if (this.active.has(task.id) || this.pending.some((item) => item.id === task.id)) return Promise.reject(new Error(`Run ${task.id} is already queued`));
    return new Promise<T>((resolve, reject) => {
      const item: Pending<T> = { ...task, resolve, reject, controller: new AbortController() };
      this.pending.push(item as Pending<unknown>);
      this.pump();
    });
  }

  cancel(id: string, reason = "Run cancelled"): boolean {
    const queued = this.pending.findIndex((item) => item.id === id);
    if (queued >= 0) {
      const item = this.pending.splice(queued, 1)[0];
      if (!item) return false;
      item.controller.abort(reason);
      item.reject(new Error(reason));
      return true;
    }
    const active = this.active.get(id);
    if (!active) return false;
    active.controller.abort(reason);
    return true;
  }

  close(reason = "Run queue closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.splice(0)) {
      item.controller.abort(reason);
      item.reject(new Error(reason));
    }
    for (const item of this.active.values()) item.controller.abort(reason);
  }

  private pump(): void {
    while (!this.closed && this.active.size < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift();
      if (!item) break;
      this.active.set(item.id, item);
      void item.run(item.controller.signal).then(item.resolve, item.reject).finally(() => {
        this.active.delete(item.id);
        this.pump();
      });
    }
  }
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs?: (attemptNo: number) => number;
  readonly sideEffects: "read_only" | "idempotent" | "non_idempotent" | "unknown";
}

export function canAutoRetry(policy: RetryPolicy, attemptNo: number): boolean {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw new Error("maxAttempts must include the first attempt");
  if (attemptNo < 1 || attemptNo >= policy.maxAttempts) return false;
  return policy.sideEffects === "read_only" || policy.sideEffects === "idempotent";
}

export async function executeWithRetry<T>(task: (signal: AbortSignal, attemptNo: number) => Promise<T>, policy: RetryPolicy, signal = new AbortController().signal): Promise<T> {
  for (let attemptNo = 1; ; attemptNo += 1) {
    signal.throwIfAborted();
    try { return await task(signal, attemptNo); } catch (error) {
      if (!canAutoRetry(policy, attemptNo)) throw error;
      const wait = Math.max(0, Math.floor(policy.backoffMs?.(attemptNo) ?? Math.min(30_000, 100 * 2 ** (attemptNo - 1))));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, wait);
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("Retry cancelled")); };
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
}
