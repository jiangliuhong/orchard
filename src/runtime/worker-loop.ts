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
  private readonly controllers = new Set<AbortController>();
  private running = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tasks: WorkflowTaskRepository,
    private readonly handler: WorkerTaskHandler,
    private readonly options: { workerId: string; concurrency?: number; leaseMs?: number; pollMs?: number } ,
  ) {}

  start(): void {
    if (this.closed) throw new Error("Worker loop is closed");
    void this.poll();
  }

  close(reason = "Worker stopped"): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const controller of this.controllers) controller.abort(reason);
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    const limit = this.options.concurrency ?? 1;
    while (!this.closed && this.running < limit) {
      const claimed = this.tasks.claim(this.options.workerId, this.options.leaseMs ?? 30_000);
      if (!claimed) break;
      this.running += 1;
      void this.execute(claimed.task, claimed.lease).finally(() => { this.running -= 1; });
    }
    if (!this.closed) this.timer = setTimeout(() => void this.poll(), this.options.pollMs ?? 100);
  }

  private async execute(task: WorkflowTaskRecord, lease: TaskLeaseRecord): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const heartbeatMs = Math.max(10, Math.floor((this.options.leaseMs ?? 30_000) / 2));
    let leaseVersion = lease.leaseVersion;
    const heartbeat = setInterval(() => {
      if (this.tasks.heartbeat(lease.id, lease.workerId, leaseVersion, this.options.leaseMs ?? 30_000)) leaseVersion += 1;
      else controller.abort("Worker lease expired");
    }, heartbeatMs);
    try {
      const output = await this.handler({ task, lease, signal: controller.signal });
      const current = this.tasks.complete(lease.id, lease.workerId, leaseVersion, "succeeded", output);
      if (!current && !controller.signal.aborted) throw new Error("Task completion rejected by lease state");
    } catch (error) {
      this.tasks.complete(lease.id, lease.workerId, leaseVersion, controller.signal.aborted ? "cancelled" : "failed", undefined, { message: error instanceof Error ? error.message : String(error) });
    } finally {
      clearInterval(heartbeat);
      this.controllers.delete(controller);
    }
  }
}
