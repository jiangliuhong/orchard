import type { RunRecord, RunRepository } from "../storage/repository.js";
import { RunQueue } from "../scheduler/run-queue.js";

export interface RunHandler {
  (run: RunRecord, signal: AbortSignal): Promise<{ outputRef?: string }>;
}

export class RunCoordinator {
  private readonly queue: RunQueue;
  private readonly controllers = new Map<string, AbortController>();
  private generation = 0;

  constructor(private readonly runs: RunRepository, options: { concurrency?: number; owner?: string; leaseMs?: number } = {}) {
    this.queue = new RunQueue(options.concurrency ?? 2);
    this.owner = options.owner ?? `coordinator-${process.pid}`;
    this.leaseMs = options.leaseMs ?? 60_000;
  }

  private readonly owner: string;
  private readonly leaseMs: number;

  submit(runId: string, handler: RunHandler): Promise<{ runId: string; outputRef?: string }> {
    return this.queue.enqueue({ id: runId, run: async (signal) => {
      const run = this.runs.claimRun(runId, this.owner, this.leaseMs, ++this.generation);
      if (!run) throw new Error(`Run ${runId} is not claimable`);
      const controller = new AbortController();
      this.controllers.set(runId, controller);
      const relay = () => controller.abort(signal.reason);
      signal.addEventListener("abort", relay, { once: true });
      try {
        const result = await handler(run, controller.signal);
        controller.signal.throwIfAborted();
        this.runs.finish(runId, "succeeded", result.outputRef);
        return { runId, ...(result.outputRef === undefined ? {} : { outputRef: result.outputRef }) };
      } catch (error) {
        if (controller.signal.aborted || signal.aborted) this.runs.finish(runId, "cancelled");
        else this.runs.finish(runId, "failed");
        throw error;
      } finally {
        signal.removeEventListener("abort", relay);
        this.controllers.delete(runId);
      }
    } });
  }

  cancel(runId: string, reason = "User requested cancellation"): boolean {
    const changed = this.runs.requestCancel(runId, reason);
    if (!changed) return false;
    this.queue.cancel(runId, reason);
    this.controllers.get(runId)?.abort(reason);
    return true;
  }

  close(): void { this.queue.close(); }
}
