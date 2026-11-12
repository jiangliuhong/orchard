import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "../domain/errors.js";

export type DefinitionWritePurpose = "business" | "maintenance.apply" | "recovery" | "workspace.sync";

/** In-process barrier; the data directory lease supplies inter-process exclusion. */
export class ConfigWriteCoordinator {
  generation = 0;
  private readers = 0;
  private writer: symbol | null = null;
  private admissions = 0;
  private context = new AsyncLocalStorage<symbol>();
  private exclusive: symbol | null = null;
  private activities = new Map<symbol, string>();
  private maintenanceReason: string | null = null;
  private writeGuards = new Set<(purpose: DefinitionWritePurpose) => void>();
  private exclusivePurpose: DefinitionWritePurpose = "business";
  /** Internal resource gates; never supplied by HTTP or Agent arguments. */
  addWriteGuard(guard: (purpose: DefinitionWritePurpose) => void) { this.writeGuards.add(guard); return () => { this.writeGuards.delete(guard); }; }
  inheritWriteGuards(other: ConfigWriteCoordinator) {
    for (const guard of this.writeGuards) other.writeGuards.add(guard);
    this.writeGuards = other.writeGuards;
  }
  assertDefinitionWritable() {
    this.assertAvailable();
    const own = this.context.getStore();
    if (this.readers || this.admissions || !(this.exclusive && this.exclusive === own || this.writer && this.writer === own) && (this.writer || this.exclusive))
      throw new AppError("WORKSPACE_BUSY", "共享维护读取或配置写入尚未结束", 409);
    if (this.definitionWritePurpose === "workspace.sync") throw new AppError("WORKSPACE_SYNC_RESOURCE_WRITE", "投影同步不能修改业务事实源", 409);
    for (const guard of this.writeGuards) guard(this.definitionWritePurpose);
  }
  get definitionWritePurpose(): DefinitionWritePurpose {
    return this.exclusive && this.exclusive === this.context.getStore() ? this.exclusivePurpose : "business";
  }
  /** Background jobs must not borrow an emitter's reentrant write authority. */
  withoutWriteOwnership<T>(action: () => T): T { return this.context.exit(action); }
  get ownsDefinitionWrite() { const own = this.context.getStore(); return !!(this.writer && this.writer === own || this.exclusive && this.exclusive === own); }
  get maintenance() { return this.maintenanceReason; }
  get activeCount() { return this.activities.size; }
  setMaintenance(reason: string | null) { this.maintenanceReason = reason; }
  assertAvailable() {
    if (this.exclusive && this.exclusive === this.context.getStore()) return;
    if (this.maintenanceReason) throw new AppError("RECOVERY_REQUIRED", this.maintenanceReason, 503);
    if (this.exclusive) throw new AppError("CONFIG_BUSY", "配置恢复正在进行", 409);
  }
  beginActivity(label: string) {
    this.assertAvailable();
    if (this.exclusive || this.readers || this.writer && this.writer !== this.context.getStore()) throw new AppError("CONFIG_BUSY", "配置正在读写", 409);
    const id = Symbol(label); this.activities.set(id, label);
    return () => { this.activities.delete(id); };
  }
  withActivity<T>(label: string, action: () => T): T {
    const release = this.beginActivity(label);
    return this.finish(action, release);
  }
  /**
   * 同步入队保护（设计 §5.1）：与现有 queued/running activity 共存，
   * 与配置 reader、writer、另一入队保护和恢复 exclusive 互斥；
   * 入队本身不递增配置 generation。仅接受同步回调，检测到 Promise 返回
   * 即视为编程错误，不能把异步工作放入其中。
   */
  withAdmission<T>(action: () => T): T {
    if (this.maintenanceReason) throw new AppError("RECOVERY_REQUIRED", this.maintenanceReason, 503);
    if (this.exclusive || this.writer || this.readers || this.admissions) throw new AppError("CONFIG_BUSY", "配置恢复或读写正在进行，入队保护未取得", 409);
    this.admissions++;
    try {
      const result = action();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("编程错误：withAdmission 回调必须同步返回，禁止在入队保护内执行异步工作");
      return result;
    } finally { this.admissions--; }
  }
  private finish<T>(action: () => T, release: () => void): T {
    try {
      const result = action();
      if (result && typeof (result as { then?: unknown }).then === "function") return Promise.resolve(result).finally(release) as T;
      release(); return result;
    } catch (error) { release(); throw error; }
  }
  withWrite<T>(action: () => T): T {
    this.assertAvailable();
    if (this.readers || this.admissions) throw new AppError("CONFIG_BUSY", "配置正在读取或入队", 409);
    if (this.exclusive && this.exclusive === this.context.getStore() || this.writer && this.writer === this.context.getStore()) return action();
    if (this.writer) throw new AppError("CONFIG_BUSY", "配置正在读写或入队", 409);
    for (const guard of this.writeGuards) guard("business");
    const owner = Symbol(); this.writer = owner;
    return this.context.run(owner, () => this.finish(action, () => { this.generation++; this.writer = null; }));
  }
  withRead<T>(action: () => T): T {
    this.assertAvailable();
    if (this.writer || this.activities.size || this.admissions) throw new AppError("CONFIG_BUSY", "配置活动尚未结束", 409);
    this.readers++;
    return this.finish(action, () => { this.readers--; });
  }
  withExclusive<T>(action: () => T, recovery = false): T { return this.exclusiveAction(action, recovery, "business"); }
  /** Platform-only intents. These are not user/Agent request flags or stop proofs. */
  withMaintenanceApply<T>(action: () => T): T { return this.exclusiveAction(action, false, "maintenance.apply"); }
  withRecovery<T>(action: () => T): T { return this.exclusiveAction(action, true, "recovery"); }
  withWorkspaceSynchronization<T>(action: () => T): T {
    if (this.exclusive && this.exclusive === this.context.getStore()) {
      const previous = this.exclusivePurpose; this.exclusivePurpose = "workspace.sync";
      return this.finish(action, () => { this.exclusivePurpose = previous; });
    }
    return this.exclusiveAction(action, false, "workspace.sync");
  }
  private exclusiveAction<T>(action: () => T, recovery: boolean, purpose: DefinitionWritePurpose): T {
    if (!recovery) this.assertAvailable();
    if (this.exclusive || this.writer || this.readers || this.activities.size || this.admissions) throw new AppError("CONFIG_BUSY", "请等待配置写入、入队保护或执行活动结束", 409);
    if (!recovery || purpose !== "business") for (const guard of this.writeGuards) guard(purpose);
    const owner = Symbol(); this.exclusive = owner; this.exclusivePurpose = purpose;
    return this.context.run(owner, () => this.finish(action, () => { this.generation++; this.exclusive = null; this.exclusivePurpose = "business"; }));
  }
}
const coordinators = new WeakMap<object, ConfigWriteCoordinator>();
export function configCoordinator(store: object): ConfigWriteCoordinator {
  let value = coordinators.get(store);
  if (!value) { value = new ConfigWriteCoordinator(); coordinators.set(store, value); }
  return value;
}
export function registerConfigCoordinator(store: object, coordinator: ConfigWriteCoordinator) {
  const previous = coordinators.get(store);
  if (previous && previous !== coordinator) coordinator.inheritWriteGuards(previous);
  coordinators.set(store, coordinator);
}
