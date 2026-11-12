import type { Store } from "../persistence/store.js";
import { configCoordinator } from "../config-git/coordinator.js";
import type { MaintenanceService } from "./maintenance-service.js";
import { projectionState } from "./workspace-state.js";
import { requireWorkspaceBusinessTracking } from "./workspace-business-hooks.js";

/** DB-backed platform worker. Never invokes a Provider/model, never waits on an
 * Agent-held reader, and never infers stop proof from an empty task table. */
export class MaintenanceApplyWorker {
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private requested = false;
  private scheduled = false;
  private started = false;
  constructor(private readonly store: Store, private readonly service: MaintenanceService, private readonly options: { synchronize?: boolean } = {}) {}
  /** Production lifecycle; existing queues recover even without a new request. */
  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    requireWorkspaceBusinessTracking(this.store); this.started = true;
    this.store.events.on("maintenance-work", this.notify);
    this.store.events.on("workspace-dirty", this.notify);
    this.wake();
  }
  private readonly notify = () => {
    if (this.controller.signal.aborted || this.scheduled) return;
    this.scheduled = true;
    configCoordinator(this.store).withoutWriteOwnership(() => queueMicrotask(() => {
      this.scheduled = false;
      if (!this.controller.signal.aborted) this.wake();
    }));
  };
  wake(): void {
    if (this.controller.signal.aborted) return;
    this.requested = true;
    if (this.running) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.running = configCoordinator(this.store).withoutWriteOwnership(() => this.drain().finally(() => {
      this.running = undefined;
      if (this.controller.signal.aborted) return;
      if (this.requested) this.wake();
      else if (this.needsWork()) {
        this.timer = setTimeout(() => { this.timer = undefined; this.wake(); }, 1000); this.timer.unref();
      }
    }));
    void this.running.catch(() => {});
  }
  private needsWork(): boolean {
    return !!this.store.one("SELECT id FROM agent_maintenance_apply_requests WHERE state='queued' LIMIT 1") ||
      !!this.options.synchronize && projectionState(this.store).state !== "ready";
  }
  private async drain() {
    this.requested = false;
    if (this.store.one("SELECT id FROM agent_maintenance_tasks WHERE status IN ('queued','running','stopping') LIMIT 1")) return;
    const rows = this.store.all<{ id: string; actor_key: string }>("SELECT id,actor_key FROM agent_maintenance_apply_requests WHERE state='queued' AND (retry_at IS NULL OR retry_at<=?) ORDER BY created_at,id LIMIT 20", Date.now());
    for (const row of rows) {
      if (this.controller.signal.aborted) return;
      try { await this.service.process(row.actor_key, row.id, this.controller.signal); } catch { /* Preserve durable authority/results; never leak raw failures. */ }
    }
    if (this.options.synchronize && !this.controller.signal.aborted && !this.store.one("SELECT id FROM agent_maintenance_apply_requests WHERE state='queued' LIMIT 1")) {
      try { await this.service.synchronizePending(this.controller.signal); } catch { /* Pending/failed projection stays closed to new model tasks. */ }
    }
  }
  async idle(): Promise<void> {
    while (this.scheduled || this.running) {
      if (this.scheduled) await new Promise<void>(resolve => queueMicrotask(resolve));
      try { await this.running; } catch { /* Later wake/recovery may retry. */ }
    }
  }
  async close(): Promise<void> {
    this.controller.abort();
    if (this.started) {
      this.started = false; this.store.events.off("maintenance-work", this.notify); this.store.events.off("workspace-dirty", this.notify);
    }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.idle();
  }
}
