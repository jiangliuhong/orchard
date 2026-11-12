import { check } from "../domain/errors.js";
import type { Store } from "../persistence/store.js";

export const WORKSPACE_TABLES = Object.freeze(["bridge_configuration", "agent_workspace_workflow_bindings", "agent_workspace_projection_state",
  "agent_maintenance_sessions", "agent_maintenance_tasks", "agent_maintenance_proposals", "agent_maintenance_decisions", "agent_maintenance_apply_requests"]);
export interface ProjectionState {
  target_generation: number; synced_generation: number; target_knowledge_hash: string; synced_knowledge_hash: string | null;
  content_hash: string | null; state: "pending" | "syncing" | "ready" | "failed"; error_code: string | null;
}
export function requireWorkspaceSchema(store: Store): void {
  check(WORKSPACE_TABLES.every(name => store.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name)),
    "WORKSPACE_MIGRATION_REQUIRED", "维护工作区结构尚未安装，须先审核并执行数据迁移", 503);
}
export function projectionState(store: Store): ProjectionState {
  const state = store.one<ProjectionState>("SELECT * FROM agent_workspace_projection_state WHERE id='maintenance'");
  check(state, "WORKSPACE_NOT_READY", "维护工作区尚未初始化", 503); return state;
}
/** Must run INSIDE the caller's business transaction, never after its commit. */
export function markWorkspaceDirty(store: Store): number {
  const state = projectionState(store);
  check(state.target_generation < Number.MAX_SAFE_INTEGER, "WORKSPACE_GENERATION_EXHAUSTED", "投影代次已耗尽", 503);
  const result = store.exec("UPDATE agent_workspace_projection_state SET target_generation=target_generation+1,state='pending',error_code=NULL,updated_at=? WHERE id='maintenance' AND target_generation=?", Date.now(), state.target_generation);
  check(Number(result.changes) === 1, "REVISION_CONFLICT", "投影目标已变化", 409);
  return state.target_generation + 1;
}
