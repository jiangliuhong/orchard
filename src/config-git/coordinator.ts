import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "../domain/errors.js";

/** In-process barrier; the data directory lease supplies inter-process exclusion. */
export class ConfigWriteCoordinator {
  generation = 0;
  private readers = 0;
  private writer: symbol | null = null;
  private context = new AsyncLocalStorage<symbol>();
  private exclusive: symbol | null = null;
  private activities = new Map<symbol, string>();
  private maintenanceReason: string | null = null;
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
  private finish<T>(action: () => T, release: () => void): T {
    try {
      const result = action();
      if (result && typeof (result as { then?: unknown }).then === "function") return Promise.resolve(result).finally(release) as T;
      release(); return result;
    } catch (error) { release(); throw error; }
  }
  withWrite<T>(action: () => T): T {
    this.assertAvailable();
    if (this.exclusive && this.exclusive === this.context.getStore() || this.writer && this.writer === this.context.getStore()) return action();
    if (this.writer || this.readers) throw new AppError("CONFIG_BUSY", "配置正在读写", 409);
    const owner = Symbol(); this.writer = owner;
    return this.context.run(owner, () => this.finish(action, () => { this.generation++; this.writer = null; }));
  }
  withRead<T>(action: () => T): T {
    this.assertAvailable();
    if (this.writer || this.activities.size) throw new AppError("CONFIG_BUSY", "配置活动尚未结束", 409);
    this.readers++;
    return this.finish(action, () => { this.readers--; });
  }
  withExclusive<T>(action: () => T, recovery = false): T {
    if (!recovery) this.assertAvailable();
    if (this.exclusive || this.writer || this.readers || this.activities.size) throw new AppError("CONFIG_BUSY", "请等待配置写入或执行活动结束", 409);
    const owner = Symbol(); this.exclusive = owner;
    return this.context.run(owner, () => this.finish(action, () => { this.generation++; this.exclusive = null; }));
  }
}
const coordinators = new WeakMap<object, ConfigWriteCoordinator>();
export function configCoordinator(store: object): ConfigWriteCoordinator {
  let value = coordinators.get(store);
  if (!value) { value = new ConfigWriteCoordinator(); coordinators.set(store, value); }
  return value;
}
export function registerConfigCoordinator(store: object, coordinator: ConfigWriteCoordinator) { coordinators.set(store, coordinator); }
