import { check } from "../domain/errors.js";
import type { Store } from "../persistence/store.js";
import { PrivateMaintenanceBridge } from "./maintenance-ipc.js";
import { MaintenanceProcessRegistry, type MaintenanceProcessLease } from "./maintenance-processes.js";
import type { MaintenanceProcessBinding, MaintenanceSessions } from "./maintenance-sessions.js";
import { MaintenanceStopJournal } from "./maintenance-stop-journal.js";
import type { MaintenanceToolGateway } from "./maintenance-tools.js";
import type { WorkspaceInstaller } from "./workspace-installer.js";

interface ActiveTask {
  lease: MaintenanceProcessLease;
  bridge?: PrivateMaintenanceBridge;
  cancellation: AbortController;
}

type Claim = ReturnType<MaintenanceSessions["claim"]>;

/** Owns task-local execution and both parts of the stop proof. */
export class MaintenanceTaskHost {
  private readonly journal: MaintenanceStopJournal;
  private readonly registry: MaintenanceProcessRegistry;
  private readonly active = new Map<string, ActiveTask>();
  private readonly runs = new Set<Promise<unknown>>();
  private closing = false;

  constructor(private readonly store: Store) {
    this.journal = new MaintenanceStopJournal(store.root, () => store.directoryLease.assert());
    this.registry = new MaintenanceProcessRegistry(this.journal);
  }

  assertStopped(binding: MaintenanceProcessBinding) {
    const task = this.active.get(binding.taskId);
    if (task) {
      task.bridge?.assertClosed();
      this.registry.assertOwnedStopped(task.lease, binding);
    } else {
      // This runs under the exclusive data-directory lease. The old listener
      // and its callbacks belonged to the dead host, while the durable journal
      // proves the corresponding detached child groups have also exited.
      this.journal.assertRestartStopped(binding);
    }
  }

  revokeTask(taskId: string) { this.active.get(taskId)?.cancellation.abort(); }

  assertQuiescent() {
    check(this.active.size === 0, "PROCESS_STOP_UNCONFIRMED", "维护任务仍持有进程或私有工具通道", 503);
  }

  recover(sessions: MaintenanceSessions) {
    this.assertQuiescent();
    sessions.recoverUncertain();
    const interrupted = this.store.all<{ id: string; session_id: string; generation: number }>(
      "SELECT id,session_id,generation FROM agent_maintenance_tasks WHERE status='stopping' AND process_state='unknown'");
    if (!interrupted.length) return;
    // Check before opening the transaction so a failed proof leaves the
    // durable stop barrier set by recoverUncertain().
    for (const row of interrupted) this.assertStopped({ taskId: row.id, sessionId: row.session_id, generation: row.generation });
    this.store.transaction(() => {
      for (const row of interrupted) sessions.reconcileStopped(row.id, row.generation);
      this.store.exec(`UPDATE agent_workspace_projection_state SET state='pending',error_code=NULL,updated_at=?
        WHERE id='maintenance' AND error_code='PROCESS_STOP_UNCONFIRMED'`, Date.now());
    });
    for (const row of interrupted) {
      this.journal.remove({ taskId: row.id, sessionId: row.session_id, generation: row.generation });
    }
  }

  run(input: {
    actor: string; sessionId: string; taskId: string; generation: number;
    sessions: MaintenanceSessions; installer: WorkspaceInstaller; gateway: MaintenanceToolGateway;
    execute(task: Claim, context: { registry: MaintenanceProcessRegistry; lease: MaintenanceProcessLease; bridge: PrivateMaintenanceBridge; signal: AbortSignal }): Promise<void>;
  }) {
    check(!this.closing, "MAINTENANCE_PROCESS_BUSY", "维护宿主正在关闭", 503);
    const cancellation = new AbortController();
    const work = input.installer.withReader(cancellation.signal, async reader => {
      check(!this.closing, "MAINTENANCE_PROCESS_BUSY", "维护宿主正在关闭", 503);
      const binding = { taskId: input.taskId, sessionId: input.sessionId, generation: input.generation };
      const owner = this.store.one("SELECT 1 FROM agent_maintenance_tasks t JOIN agent_maintenance_sessions s ON s.id=t.session_id WHERE t.id=? AND s.id=? AND s.actor_key=? AND t.generation=? AND t.status='queued'",
        binding.taskId, binding.sessionId, input.actor, binding.generation);
      check(owner, "TASK_NOT_QUEUED", "维护任务不可启动", 409);
      const lease = this.registry.reserve(binding);
      const active: ActiveTask = { lease, cancellation };
      this.active.set(binding.taskId, active);
      let task: Claim | undefined;
      let outcome: "failed" | "succeeded" | "cancelled" = "failed";
      try {
        task = input.sessions.claim(binding.taskId);
        const bridge = await PrivateMaintenanceBridge.open({ reader, gateway: input.gateway, actor: input.actor,
          sessionId: binding.sessionId, taskId: binding.taskId, signal: cancellation.signal });
        active.bridge = bridge;
        input.sessions.started(task.handle);
        await this.registry.track(lease, () => input.execute(task!, { registry: this.registry, lease, bridge, signal: cancellation.signal }));
        outcome = cancellation.signal.aborted ? "cancelled" : "succeeded";
      } finally {
        cancellation.abort();
        const stopped = await Promise.allSettled([active.bridge?.close(), this.registry.stop(lease)]);
        if (task) input.sessions.settle(task.handle, outcome);
        for (const result of stopped) if (result.status === "rejected") throw result.reason;
        this.assertStopped(binding);
        this.registry.forget(lease);
        this.active.delete(binding.taskId);
      }
    });
    this.runs.add(work);
    void work.then(() => this.runs.delete(work), () => this.runs.delete(work));
    return work;
  }

  async close() {
    this.closing = true;
    for (const task of this.active.values()) task.cancellation.abort();
    await this.registry.close();
    await Promise.allSettled(this.runs);
    this.assertQuiescent();
  }
}
