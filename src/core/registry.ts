import type { NodeExecutor, ToolAdapter, TriggerAdapter } from "./contracts.js";

function ensureId(id: string, label: string): void {
  if (!/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/.test(id)) throw new Error(`Invalid ${label} type: ${id}`);
}

export class NodeRegistry {
  private readonly executors = new Map<string, NodeExecutor>();
  register<Config, Input, Output>(executor: NodeExecutor<Config, Input, Output>): this {
    ensureId(executor.type, "node");
    if (!executor.version?.trim()) throw new Error(`Node ${executor.type} must declare a version`);
    if (this.executors.has(executor.type)) throw new Error(`Node ${executor.type} is already registered`);
    this.executors.set(executor.type, executor as NodeExecutor);
    return this;
  }
  get(type: string): NodeExecutor {
    const executor = this.executors.get(type);
    if (!executor) throw new Error(`Node type ${type} is not registered`);
    return executor;
  }
  has(type: string): boolean { return this.executors.has(type); }
  list(): readonly NodeExecutor[] { return [...this.executors.values()]; }
}

export class ToolRegistry {
  private readonly adapters = new Map<string, ToolAdapter>();
  register<Input, Output>(adapter: ToolAdapter<Input, Output>): this {
    ensureId(adapter.type, "tool");
    if (!adapter.version?.trim()) throw new Error(`Tool ${adapter.type} must declare a version`);
    if (!["read_only", "idempotent", "non_idempotent", "unknown"].includes(adapter.sideEffects)) {
      throw new Error(`Tool ${adapter.type} must declare a valid side effect class`);
    }
    if (this.adapters.has(adapter.type)) throw new Error(`Tool ${adapter.type} is already registered`);
    this.adapters.set(adapter.type, adapter as ToolAdapter);
    return this;
  }
  get(type: string): ToolAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) throw new Error(`Tool type ${type} is not registered`);
    return adapter;
  }
  list(): readonly ToolAdapter[] { return [...this.adapters.values()]; }
}

export class TriggerRegistry {
  private readonly adapters = new Map<string, TriggerAdapter>();
  register<Config>(adapter: TriggerAdapter<Config>): this {
    ensureId(adapter.type, "trigger");
    if (this.adapters.has(adapter.type)) throw new Error(`Trigger ${adapter.type} is already registered`);
    this.adapters.set(adapter.type, adapter as TriggerAdapter);
    return this;
  }
  get(type: string): TriggerAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) throw new Error(`Trigger type ${type} is not registered`);
    return adapter;
  }
  list(): readonly TriggerAdapter[] { return [...this.adapters.values()]; }
}
