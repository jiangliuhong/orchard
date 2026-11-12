import { check } from "../domain/errors.js";
import type { Store } from "../persistence/store.js";
import { projectionSegment } from "./workspace-projection.js";

/** Read-only identity preflight. No implicit schema install, binding backfill or
 * source repair. New-mode startup must separately require the approved schema. */
export function workflowProjectionIdentity(store: Store, draft: ReturnType<Store["draft"]>, files: Readonly<Record<string, string>>): string {
  const installed = !!store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_workspace_workflow_bindings'");
  const binding = installed ? store.one<{ resource_id: string }>("SELECT resource_id FROM agent_workspace_workflow_bindings WHERE draft_id=?", draft.id) : undefined;
  check(!installed || binding, "PROJECTION_IDENTITY_UNAVAILABLE", "工作流草稿缺少持久身份绑定", 409);
  let declared: unknown;
  try { declared = JSON.parse(files["workflow.json"]!).id; } catch { /* A bound incomplete draft is still readable. */ }
  const id = binding?.resource_id ?? draft.workflowId ?? declared;
  check(typeof id === "string", "PROJECTION_IDENTITY_UNAVAILABLE", "工作流稳定身份无法确认", 409);
  projectionSegment(id);
  check((!draft.workflowId || draft.workflowId === id) && (declared === undefined || declared === id), "PROJECTION_IDENTITY_CONFLICT", "工作流身份绑定与源码不一致", 409);
  if (draft.publishedVersionId) check(store.version(draft.publishedVersionId).workflowId === id, "PROJECTION_IDENTITY_CONFLICT", "草稿发布记录的身份不一致", 409);
  return id;
}
