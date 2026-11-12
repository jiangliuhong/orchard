import { closeSync, constants, fsyncSync, lstatSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { AppError, check } from "../domain/errors.js";
import { syncDirectory } from "../migrations/journal.js";
import type { SourceFiles } from "../domain/types.js";
import { validateScript } from "../domain/scripts.js";
import { validateWorkflowDictionaries, validateScriptDictionaries } from "../dictionaries/validation.js";
import { canonicalJson, checkFiles, readDefinition, safeFile, validateFiles } from "../persistence/files.js";
import type { Store } from "../persistence/store.js";
import { checkScriptSource } from "../runtime/script.js";
import type { WebBridgeConfig } from "../web-bridge/config.js";
import { prepareBridgeProposal } from "../web-bridge/authoring.js";
import { assertTarget, onlyKeys, type MaintenanceTarget } from "./maintenance-protocol.js";
import { workflowProjectionIdentity } from "./workspace-identity.js";
import { assertProjectedToolSafe, workflowProjectionDependencies } from "./workspace-projection.js";
import { assertBrowserToolsUnused } from "./workspace-dependencies.js";

export interface MaintenanceSnapshot { baseline: Record<string, unknown>; before: Record<string, unknown> }
export interface PreparedMaintenanceChange {
  change: Record<string, unknown>; after: Record<string, unknown>;
  /** Only the application service calls this inside its business transaction. */
  commit(): Record<string, unknown>;
}
export interface MaintenanceBusinessHost {
  capture(target: MaintenanceTarget): MaintenanceSnapshot;
  prepare(target: MaintenanceTarget, change: Record<string, unknown>, snapshot: MaintenanceSnapshot): Promise<PreparedMaintenanceChange>;
  refresh(): void;
}
const withoutLayout = (files: Readonly<SourceFiles>) => Object.fromEntries(Object.entries(files).filter(([path]) => path !== "layout.json"));

/** Existing resource validators and immutable artifact storage, not a second
 * authoring implementation. No candidate source is ever executed. */
export class MaintenanceAssets implements MaintenanceBusinessHost {
  constructor(private readonly store: Store, private readonly bridge: WebBridgeConfig) {}
  refresh() { if (this.bridge.databaseRevision !== undefined) this.bridge.reloadAfterRestore(); }
  capture(target: MaintenanceTarget): MaintenanceSnapshot {
    assertTarget(target);
    if (target.kind === "workflow_draft") {
      const draft = this.store.draft(target.scope.draftId), tree = this.store.files.readTree(draft.artifactPath);
      check(draft.status === "draft" && workflowProjectionIdentity(this.store, draft, tree.files) === target.id, "OWNER_UNAVAILABLE", "固定工作流草稿已发布、删除或改变身份", 409);
      return { baseline: { draftId: draft.id, revision: draft.revision, contentHash: draft.artifactPath.split("/")[2]! }, before: { files: withoutLayout(tree.files) } };
    }
    if (target.kind === "script_draft") {
      const script = this.store.script(target.id);
      check(script.status !== "archived" && script.currentDraftVersionId === target.scope.draftVersionId, "OWNER_UNAVAILABLE", "固定脚本草稿已被替换或归档", 409);
      const selected = script.currentDraftVersionId ?? script.currentPublishedVersionId;
      check(selected, "OWNER_UNAVAILABLE", "脚本没有可维护版本", 409);
      const version = this.store.scriptVersion(selected), definition = this.store.scriptDefinition(script.id, selected);
      return { baseline: { draftVersionId: script.currentDraftVersionId, revision: script.currentDraftVersionId ? version.revision : 0,
        publishedVersionId: script.currentPublishedVersionId, contentHash: version.contentHash }, before: { definition } };
    }
    check(this.bridge.databaseRevision !== undefined, "WORKSPACE_MIGRATION_REQUIRED", "浏览器配置尚未迁入数据库，禁止统一应用", 503);
    this.refresh();
    const snapshot = this.bridge.authoringSnapshot(target.id);
    return { baseline: { revision: this.bridge.databaseRevision, applicationHash: snapshot.hash }, before: { tools: snapshot.tools } };
  }

  async prepare(target: MaintenanceTarget, change: Record<string, unknown>, snapshot: MaintenanceSnapshot): Promise<PreparedMaintenanceChange> {
    assertTarget(target);
    if (target.kind === "workflow_draft") {
      onlyKeys(change, ["operation", "files"]); check(change.operation === "replace", "INVALID_PROPOSAL", "工作流只支持完整业务文件替换");
      const files = structuredClone(change.files) as SourceFiles; checkFiles(files);
      for (const path of Object.keys(files)) { safeFile(path); check(path !== "layout.json", "INVALID_PROPOSAL", "Agent 不能修改页面布局"); }
      const definition = readDefinition(files); check(definition.id === target.id, "IDENTITY_CONFLICT", "不能修改工作流身份", 409);
      const validation = await validateFiles(files); check(validation.valid, "INVALID_PROPOSAL", "候选工作流或源码校验失败");
      this.store.assertWorkflowScriptContracts(definition); validateWorkflowDictionaries(this.store, definition);
      this.checkBrowserDependencies(files);
      // Preserve layout from the exact baseline; the service checks that baseline
      // again after asynchronous validation and before committing.
      const current = this.store.draft(target.scope.draftId), old = this.store.files.readTree(current.artifactPath).files;
      const complete = { ...files, ...(old["layout.json"] !== undefined ? { "layout.json": old["layout.json"] } : {}) };
      const tree = this.store.files.saveTree(complete);
      this.store.files.readTree(tree.path); this.durableArtifact(tree.path);
      return { change: { operation: "replace", files }, after: { files }, commit: () => {
        const updated = this.store.exec("UPDATE drafts SET artifact_path=?,validation_json=?,revision=revision+1,updated_at=? WHERE id=? AND status='draft' AND revision=?", tree.path, canonicalJson(validation), Date.now(), target.scope.draftId, Number(snapshot.baseline.revision));
        check(Number(updated.changes) === 1, "REVISION_CONFLICT", "工作流草稿已变化", 409);
        return { kind: target.kind, id: target.id, draftId: target.scope.draftId, revision: Number(snapshot.baseline.revision) + 1 };
      } };
    }
    if (target.kind === "script_draft") {
      onlyKeys(change, ["operation", "definition"]); check(change.operation === "replace", "INVALID_PROPOSAL", "脚本只支持完整定义替换");
      onlyKeys(change.definition, ["id", "name", "description", "runtime", "entryFile", "inputSchema", "outputSchema", "timeoutMs", "resultMode", "dictionaryBindings", "files"],
        ["id", "name", "description", "runtime", "entryFile", "inputSchema", "outputSchema", "files"]);
      const definition = validateScript(change.definition), original = snapshot.before.definition as { runtime: string };
      check(definition.id === target.id && definition.runtime === original.runtime, "IDENTITY_CONFLICT", "不能修改脚本身份或运行时", 409);
      await checkScriptSource(definition); validateScriptDictionaries(this.store, definition);
      const { files, ...metadata } = definition, tree = this.store.files.saveScriptTree(files, metadata);
      this.store.files.readScriptTree(tree.path); this.durableArtifact(tree.path);
      return { change: { operation: "replace", definition }, after: { definition }, commit: () => {
        const result = this.store.updateScriptDraft(target.id, Number(snapshot.baseline.revision), definition, tree.path, tree.hash);
        return { kind: target.kind, id: target.id, draftVersionId: result.version.id, revision: result.version.revision };
      } };
    }
    onlyKeys(change, ["operation", "changes"]); check(change.operation === "tools" && Array.isArray(change.changes) && change.changes.length > 0 && change.changes.length <= 20, "INVALID_PROPOSAL", "浏览器提案须包含 1–20 个工具变更");
    const prepared = prepareBridgeProposal(target.id, snapshot.before.tools as Parameters<typeof prepareBridgeProposal>[1], { summary: "受审工具变更", changes: change.changes });
    assertBrowserToolsUnused(this.store, new Set(prepared.proposal.changes.filter(item => item.operation === "delete").map(item => `${target.id}/${item.toolId}`)));
    for (const item of prepared.proposal.changes) if (item.operation !== "delete") assertProjectedToolSafe(item.definition);
    return { change: { operation: "tools", changes: prepared.proposal.changes }, after: { tools: prepared.candidate }, commit: () => {
      this.bridge.applyProposal(target.id, String(snapshot.baseline.applicationHash), prepared.proposal);
      return { kind: target.kind, id: target.id, revision: this.bridge.databaseRevision! };
    } };
  }

  private durableArtifact(path: string) {
    try {
      const absolute = this.store.files.path(path), info = lstatSync(absolute);
      check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "ARTIFACT_MISMATCH", "源码产物包含链接或非常规文件");
      const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      for (let directory = dirname(absolute); directory !== this.store.root; directory = dirname(directory)) syncDirectory(directory);
      syncDirectory(this.store.root);
    } catch { throw new AppError("ARTIFACT_PREPARE_FAILED", "源码产物持久化校验失败，未应用业务配置", 503); }
  }
  private checkBrowserDependencies(files: SourceFiles) {
    const parsed = workflowProjectionDependencies(files["workflow.json"]!);
    check(parsed.complete, "DEPENDENCY_UNKNOWN", "工作流依赖无法完整解析", 409);
    const tools = new Set(this.bridge.tools().map(tool => `${tool.application}/${tool.toolId}`));
    for (const reference of parsed.items) if (reference.kind === "bridge_tool") check(tools.has(reference.id), "DEPENDENCY_MISSING", "引用的浏览器工具不存在", 409);
  }
}
