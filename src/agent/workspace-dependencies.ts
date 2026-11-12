import { check } from "../domain/errors.js";
import type { Store } from "../persistence/store.js";
import { workflowProjectionDependencies } from "./workspace-projection.js";

export function assertBrowserToolsUnused(store: Store, removed: ReadonlySet<string>): void {
  if (!removed.size) return;
  const trees = store.all<{ artifact_path: string }>(
    "SELECT artifact_path FROM drafts UNION SELECT artifact_path FROM workflow_versions",
  );
  for (const { artifact_path: path } of trees) {
    const workflow = store.files.readTree(path).files["workflow.json"];
    const parsed = workflow === undefined ? { complete: false, items: [] } : workflowProjectionDependencies(workflow);
    check(parsed.complete, "DEPENDENCY_UNKNOWN", "存在不完整工作流，不能证明工具无依赖", 409);
    check(!parsed.items.some(item => item.kind === "bridge_tool" && removed.has(item.id)),
      "RESOURCE_IN_USE", "工具仍被工作流引用，禁止删除", 409);
  }
}
