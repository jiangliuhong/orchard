import { WorkflowSuspended } from './suspension.js';
import type { TaskLeaseRecord, WorkflowTaskRecord } from "../storage/repository.js";
import { WorkflowTaskRepository } from "../storage/repository.js";

export interface WorkerTaskContext {
  readonly task: WorkflowTaskRecord;
  readonly lease: TaskLeaseRecord;
  readonly signal: AbortSignal;
}

export type WorkerTaskHandler = (context: WorkerTaskContext) => Promise<unknown>;

/** In-process server/worker loop with durable leases and bounded concurrency. */
export class WorkerLoop {
  private readonly controllers = new Map<string, AbortController>();
  private running = 0;
  private started = false;
  private readonly active = new Set<Promise<void>>();
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tasks: WorkflowTaskRepository,
    private readonly handler: WorkerTaskHandler,
    private readonly options: { workerId: string; concurrency?: number; leaseMs?: number; pollMs?: number; maxPerWorkflow?: number; maxPerRun?: number; policyKey?: string; maxPerKey?: number } ,
  ) {
    for (const value of [options.concurrency ?? 1, options.leaseMs ?? 30_000, options.pollMs ?? 100]) if (!Number.isInteger(value) || value < 1) throw new Error('Worker limits must be positive integers');
  }

  start(): void {
    if (this.closed) throw new Error("Worker loop is closed");
    if (this.started) return;
    this.started = true;
    void this.poll().catch(() => {});
  }

  /** Request cancellation of user code currently executing for a run. The
   * durable repository remains the source of truth; this is the in-process
   * fast path that makes cancellation reach an active worker immediately. */
  cancel(runId: string, reason = "Run cancelled"): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled(this.active);
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    // Recovery is deliberately performed outside user-code execution and on
    // every poll, so a restarted worker can reclaim expired leases without a
    // separate coordinator process.
    try {
    this.tasks.recoverExpired();
    this.tasks.heartbeatWorker(this.options.workerId, this.running);
    const limit = this.options.concurrency ?? 1;
    while (!this.closed && this.running < limit) {
      const claimed = this.tasks.claim(this.options.workerId, this.options.leaseMs ?? 30_000, Date.now(), {
        ...(this.options.maxPerWorkflow === undefined ? {} : { maxPerWorkflow: this.options.maxPerWorkflow }),
        ...(this.options.maxPerRun === undefined ? {} : { maxPerRun: this.options.maxPerRun }),
        ...(this.options.policyKey === undefined ? {} : { policyKey: this.options.policyKey }),
        ...(this.options.maxPerKey === undefined ? {} : { maxPerKey: this.options.maxPerKey }),
      });
      if (!claimed) break;
      this.running += 1;
      const execution = this.execute(claimed.task, claimed.lease).catch(() => { /* Recover the lease after a storage/reporting failure. */ }).finally(() => { this.running -= 1; this.active.delete(execution); });
      this.active.add(execution);
    }
    } finally {
      if (!this.closed) this.timer = setTimeout(() => void this.poll().catch(() => {}), this.options.pollMs ?? 100);
    }
  }

  private async execute(task: WorkflowTaskRecord, lease: TaskLeaseRecord): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.runId, controller);
    const heartbeatMs = Math.max(10, Math.floor((this.options.leaseMs ?? 30_000) / 2));
    let leaseVersion = lease.leaseVersion;
    const heartbeat = setInterval(() => {
      try {
        if (this.tasks.heartbeat(lease.id, lease.workerId, leaseVersion, this.options.leaseMs ?? 30_000)) leaseVersion += 1;
        else controller.abort("Worker lease expired");
      } catch (error) { controller.abort(error); }
    }, heartbeatMs);
    try {
      const output = await this.handler({ task, lease, signal: controller.signal });
      const current = this.tasks.acceptResult({ taskId: task.id, runId: task.runId, attemptId: lease.attemptId, leaseId: lease.id, workerId: lease.workerId, leaseVersion, status: 'succeeded', output });
      if (!current && !controller.signal.aborted) throw new Error("Task completion rejected by lease state");
    } catch (error) {
      if (error instanceof WorkflowSuspended && !controller.signal.aborted) {
        this.tasks.acceptResult({ taskId: task.id, runId: task.runId, attemptId: lease.attemptId, leaseId: lease.id, workerId: lease.workerId, leaseVersion, status: 'succeeded' });
        return;
      }
      this.tasks.acceptResult({ taskId: task.id, runId: task.runId, attemptId: lease.attemptId, leaseId: lease.id, workerId: lease.workerId, leaseVersion, status: controller.signal.aborted ? 'cancelled' : 'failed', error: { message: error instanceof Error ? error.message : String(error), ...(error && typeof error === 'object' && 'retryable' in error ? { retryable: error.retryable !== false } : {}) } });
    } finally {
      clearInterval(heartbeat);
      if (this.controllers.get(task.runId) === controller) this.controllers.delete(task.runId);
    }
  }
}
