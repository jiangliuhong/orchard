import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { AppError, check } from "../domain/errors.js";
import { canonical, hash, present, readJson, safe, writeJson } from "../migrations/journal.js";

export interface ConfigOperation {
  id: string; operationId: string; kind: string; requestId: string; inputHash: string;
  phase: "accepted" | "running" | "completed" | "failed" | "interrupted";
  createdAt: number; updatedAt: number; result?: unknown;
  error?: { code: string; message: string };
}
/** Durable API receipts are separate from the restore engine's transactional journal. */
export class ConfigOperations {
  private readonly active = new Map<string, Promise<void>>();
  private closed = false;
  constructor(readonly root: string) {
    for (const operation of this.list()) if (["accepted", "running"].includes(operation.phase)) {
      operation.phase = "interrupted";
      operation.error = { code: "OPERATION_INTERRUPTED", message: "服务已重启，请重试相同请求以确认结果" };
      this.save(operation);
    }
  }
  private path(id: string) {
    check(/^[a-f0-9-]{36}$/.test(id), "NOT_FOUND", "操作不存在", 404);
    return safe(this.root, `config-git/api-operations/${id}.json`);
  }
  private save(operation: ConfigOperation) { operation.updatedAt = Date.now(); writeJson(this.path(operation.id), operation); }
  get(id: string) { const path = this.path(id); check(present(path), "NOT_FOUND", "操作不存在", 404); return readJson<ConfigOperation>(path); }
  list() {
    const directory = safe(this.root, "config-git/api-operations");
    if (!present(directory)) return [];
    return readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => this.get(name.slice(0, -5))).sort((a, b) => b.createdAt - a.createdAt);
  }
  start(kind: string, requestId: string, input: unknown, action: () => unknown | Promise<unknown>) {
    check(!this.closed, "CONFIG_BUSY", "服务正在关闭", 503);
    check(typeof requestId === "string" && requestId.length > 0 && requestId.length <= 200, "INVALID_REQUEST_ID", "缺少有效 requestId", 422);
    const inputHash = hash(canonical(JSON.parse(JSON.stringify(input))));
    let operation = this.list().find(item => item.kind === kind && item.requestId === requestId);
    if (operation) {
      check(operation.inputHash === inputHash, "REQUEST_CONFLICT", "同一 requestId 已用于不同请求", 409);
      if (operation.phase !== "interrupted") return this.accepted(operation);
    } else {
      const id = randomUUID();
      operation = { id, operationId: id, kind, requestId, inputHash, phase: "accepted", createdAt: Date.now(), updatedAt: Date.now() };
    }
    operation.phase = "accepted"; delete operation.error; this.save(operation);
    const current = operation;
    const promise = Promise.resolve().then(async () => {
      current.phase = "running"; this.save(current);
      try { current.result = await action(); current.phase = "completed"; }
      catch (error) {
        current.phase = "failed";
        current.error = error instanceof AppError ? { code: error.code, message: error.message } : { code: "CONFIG_OPERATION_FAILED", message: "操作失败，请检查仓库状态后重试" };
      }
      this.save(current);
    }).finally(() => this.active.delete(current.id));
    this.active.set(current.id, promise);
    return this.accepted(current);
  }
  private accepted(operation: ConfigOperation) { return { operationId: operation.id, phase: operation.phase, statusUrl: `/api/config-git/operations/${operation.id}` }; }
  async close() { this.closed = true; await Promise.allSettled(this.active.values()); }
}
