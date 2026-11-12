import { createHash } from "node:crypto";
import { check } from "../domain/errors.js";
import { configCoordinator } from "../config-git/coordinator.js";
import { canonicalJson } from "../persistence/files.js";
import type { Store, StoreTransactionObserver } from "../persistence/store.js";
import { WORKSPACE_TABLES, markWorkspaceDirty, projectionState, requireWorkspaceSchema } from "./workspace-state.js";
import { workflowProjectionIdentity } from "./workspace-identity.js";
import { projectionSegment } from "./workspace-projection.js";
import { assertBrowserToolsUnused } from "./workspace-dependencies.js";

export function workspaceSchemaInstalled(store: Store): boolean {
  const present = WORKSPACE_TABLES.filter(name => !!store.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name));
  check(present.length === 0 || present.length === WORKSPACE_TABLES.length, "WORKSPACE_MIGRATION_REQUIRED", "维护结构不完整，禁止回退旧配置路径", 503);
  return present.length === WORKSPACE_TABLES.length;
}
export function assertNoMaintenanceTask(store: Store): void {
  check(!store.one("SELECT id FROM agent_maintenance_tasks WHERE status IN ('queued','running','stopping') LIMIT 1"), "WORKSPACE_BUSY", "共享维护任务尚未停止，请保留编辑并稍后重试", 409);
  check(projectionState(store).error_code !== "PROCESS_STOP_UNCONFIRMED", "PROCESS_STOP_UNCONFIRMED", "维护进程退出尚未确认，须先恢复", 409);
}
export function assertNoPendingMaintenanceApplication(store: Store): void {
  check(!store.one("SELECT id FROM agent_maintenance_apply_requests WHERE state='queued' LIMIT 1"), "MAINTENANCE_APPLY_PENDING", "已确认应用尚未处理，请保留编辑并稍后重试", 409);
}
export function assertLegacyMaintenanceAllowed(store: Store): void {
  check(!workspaceSchemaInstalled(store), "LEGACY_AGENT_DISABLED", "已迁入只读维护工作区，旧 Agent 写入入口已停用；请使用新的维护会话", 409);
}

// Minimal irreversible owner tombstones reuse existing receipts. Never prune
// these while the corresponding maintenance session/history is retained.
const OWNER_RETIRED_SCOPE = "maintenance.owner.retired";
export function maintenanceOwnerRetired(store: Store, sessionId: string): boolean {
  return !!store.one("SELECT 1 FROM command_receipts WHERE scope=? AND request_id=?", OWNER_RETIRED_SCOPE, sessionId);
}
export function assertMaintenanceOwnerAvailable(store: Store, sessionId: string): void {
  check(!maintenanceOwnerRetired(store, sessionId), "OWNER_UNAVAILABLE", "原固定维护对象已关闭；重建或恢复同名对象不会重新启用旧会话", 409);
}
interface ScriptOwner { id: string; status: string; current_draft_version_id: string | null }
function scriptOwners(store: Store): Map<string, ScriptOwner> {
  return new Map(store.all<ScriptOwner>("SELECT id,status,current_draft_version_id FROM scripts").map(script => [script.id, script]));
}
function browserIds(store: Store) {
  const row = store.one<{ config_json: string }>("SELECT config_json FROM bridge_configuration WHERE id='current'");
  const config = row ? JSON.parse(row.config_json) : {};
  return { applications: new Set(Object.keys(config.applications ?? {})), tools: new Set(Object.keys(config.tools ?? {})) };
}
function retire(store: Store, kind: string, ownerId: string, scopeKey?: string, scopeValue?: string | null) {
  check(!scopeKey || ["draftId", "draftVersionId"].includes(scopeKey), "INVALID_OWNER_SCOPE", "内部维护范围无效");
  const sessions = store.all<{ id: string }>(`SELECT id FROM agent_maintenance_sessions WHERE lifecycle='active' AND owner_kind=? AND owner_id=?${scopeKey ? ` AND json_extract(owner_scope_json,'$.${scopeKey}') IS ?` : ""}`,
    kind, ownerId, ...(scopeKey ? [scopeValue ?? null] : []));
  for (const session of sessions) {
    const result = canonicalJson({ sessionId: session.id, reason: "OWNER_UNAVAILABLE" });
    store.exec("INSERT OR IGNORE INTO command_receipts VALUES(?,?,?,?,?)", OWNER_RETIRED_SCOPE, session.id, createHash("sha256").update(result).digest("hex"), result, Date.now());
  }
}

// Only projected definitions and permission/dependency identities. Never include
// display messages, tasks, confirmations, runs/tests, receipts or timestamps that
// have no effect on the project. Hash rows incrementally instead of retaining all
// source/credential-bearing configuration values in a large snapshot object.
const watched = {
  drafts: "id,workflow_id,base_version_id,revision,artifact_path,validation_json,published_version_id,status,created_at",
  workflows: "id,name,current_version_id",
  workflow_versions: "id,workflow_id,version_no,artifact_path,content_hash",
  scripts: "id,name,description,runtime,status,current_draft_version_id,current_published_version_id",
  script_versions: "id,script_id,version_no,status,revision,entry_file,timeout_ms,input_schema_json,output_schema_json,source_ref,content_hash,validation_json",
  bridge_configuration: "id,revision,content_hash,config_json",
  provider_settings: "id,enabled,config_json,models_json,default_model,revision",
  agent_model_configs: "id,name,description,provider_id,model_id,enabled,revision",
  dictionaries: "id,name,kind,current_version_id,revision",
  dictionary_versions: "id,dictionary_id,content_hash,kind,enabled",
};
function fingerprint(store: Store): string {
  const hash = createHash("sha256");
  for (const [table, columns] of Object.entries(watched)) {
    hash.update(`${table}\0`);
    for (const row of store.db.prepare(`SELECT ${columns} FROM ${table} ORDER BY id`).iterate()) hash.update(canonicalJson(row)).update("\n");
  }
  for (const row of store.db.prepare("SELECT draft_id,resource_id FROM agent_workspace_workflow_bindings ORDER BY draft_id").iterate()) hash.update(canonicalJson(row)).update("\n");
  hash.update(projectionState(store).target_knowledge_hash);
  return hash.digest("hex");
}
interface WorkState { queue: string; task: string | null }
function workState(store: Store): WorkState {
  return store.one<WorkState>("SELECT CAST(coalesce((SELECT max(rowid) FROM agent_maintenance_apply_requests WHERE state='queued'),0) AS TEXT) AS queue,(SELECT id FROM agent_maintenance_tasks WHERE status IN ('queued','running','stopping') LIMIT 1) AS task")!;
}
interface Snapshot {
  hash: string; generation: number;
  work: WorkState; notifyWork?: boolean;
  drafts: Map<string, ReturnType<Store["draft"]>>;
  bindings: Map<string, string>;
  scripts: Map<string, ScriptOwner>;
  browser: ReturnType<typeof browserIds>;
  changedGeneration?: number;
}
const installed = new WeakMap<Store, () => void>();
export function requireWorkspaceBusinessTracking(store: Store): void {
  check(installed.has(store), "WORKSPACE_BOUNDARY_REQUIRED", "维护任务必须使用已安装业务提交屏障的存储", 503);
  store.directoryLease.assert();
}

/** One observer at the real Store commit boundary covers HTTP, internal Store
 * commands and bulk restore alike. No SQL text guessing, database triggers on old
 * tables, table installation, schema-version changes or disk reverse-import.
 * Raw db.exec outside Store transactions is reserved for the migration engine.
 */
export function installWorkspaceBusinessTracking(store: Store): () => void {
  requireWorkspaceSchema(store); store.directoryLease.assert(); projectionState(store);
  check(!installed.has(store), "TRANSACTION_OBSERVER_CONFLICT", "维护业务边界已安装", 409);
  // Never silently migrate an existing draft on ordinary server startup.
  for (const draft of store.drafts()) workflowProjectionIdentity(store, draft, store.files.readTree(draft.artifactPath).files);
  const releaseGuard = configCoordinator(store).addWriteGuard(purpose => {
    store.directoryLease.assert(); assertNoMaintenanceTask(store);
    if (purpose === "business") assertNoPendingMaintenanceApplication(store);
  });
  const observer: StoreTransactionObserver = {
    begin(): Snapshot {
      store.directoryLease.assert();
      return { hash: fingerprint(store), generation: projectionState(store).target_generation, work: workState(store),
        drafts: new Map(store.drafts().map(draft => [draft.id, draft])),
        scripts: scriptOwners(store), browser: browserIds(store),
        bindings: new Map(store.all<{ draft_id: string; resource_id: string }>("SELECT draft_id,resource_id FROM agent_workspace_workflow_bindings").map(row => [row.draft_id, row.resource_id])) };
    },
    beforeCommit(value) {
      const before = value as Snapshot;
      if (fingerprint(store) !== before.hash) {
        configCoordinator(store).assertDefinitionWritable(); assertNoMaintenanceTask(store);
        for (const draft of store.drafts()) {
          const old = before.drafts.get(draft.id), priorBinding = before.bindings.get(draft.id);
          if (old) {
            check(draft.createdAt === old.createdAt && draft.revision >= old.revision, "PROJECTION_IDENTITY_CONFLICT", "不能复用草稿身份或回退草稿修订", 409);
            const binding = store.one<{ resource_id: string }>("SELECT resource_id FROM agent_workspace_workflow_bindings WHERE draft_id=?", draft.id);
            check(priorBinding && binding?.resource_id === priorBinding, "PROJECTION_IDENTITY_CONFLICT", "不能删除或替换现有草稿身份绑定", 409);
            if (old.artifactPath !== draft.artifactPath || old.workflowId !== draft.workflowId || old.publishedVersionId !== draft.publishedVersionId)
              workflowProjectionIdentity(store, draft, store.files.readTree(draft.artifactPath).files);
          } else {
            const files = store.files.readTree(draft.artifactPath).files;
            let declared: unknown;
            try { declared = JSON.parse(files["workflow.json"]!).id; } catch { /* Reject below. */ }
            check(typeof declared === "string", "PROJECTION_IDENTITY_UNAVAILABLE", "新草稿缺少稳定工作流身份", 409);
            projectionSegment(declared);
            check(!draft.workflowId || draft.workflowId === declared, "PROJECTION_IDENTITY_CONFLICT", "新草稿身份与工作流归属不一致", 409);
            const binding = store.one<{ resource_id: string }>("SELECT resource_id FROM agent_workspace_workflow_bindings WHERE draft_id=?", draft.id);
            if (binding) check(binding.resource_id === declared, "PROJECTION_IDENTITY_CONFLICT", "新草稿身份绑定不一致", 409);
            else store.exec("INSERT INTO agent_workspace_workflow_bindings(draft_id,resource_id,created_at) VALUES(?,?,?)", draft.id, declared, draft.createdAt);
          }
        }
        const drafts = new Map(store.drafts().map(draft => [draft.id, draft]));
        for (const [id, old] of before.drafts) if (!drafts.has(id) || old.status !== "published" && drafts.get(id)!.status === "published") {
          const resourceId = before.bindings.get(id);
          if (resourceId) retire(store, "workflow_draft", resourceId, "draftId", id);
        }
        const scripts = scriptOwners(store);
        for (const [id, old] of before.scripts) {
          const current = scripts.get(id);
          if (!current || old.status !== "archived" && current.status === "archived") retire(store, "script_draft", id);
          else if (old.current_draft_version_id !== current.current_draft_version_id) retire(store, "script_draft", id, "draftVersionId", old.current_draft_version_id);
        }
        const browser = browserIds(store);
        assertBrowserToolsUnused(store, new Set([...before.browser.tools].filter(id => !browser.tools.has(id))));
        for (const id of before.browser.applications) if (!browser.applications.has(id)) retire(store, "browser_application", id);
        // Existing application/DB-backend code may have registered dirty state
        // explicitly. Coalesce all nested commands into one outer transaction.
        if (projectionState(store).target_generation === before.generation) markWorkspaceDirty(store);
      }
      const generation = projectionState(store).target_generation;
      if (generation > before.generation) before.changedGeneration = generation;
      const currentWork = workState(store);
      before.notifyWork = currentWork.queue !== before.work.queue || currentWork.task !== before.work.task;
    },
    committed(value) {
      const snapshot = value as Snapshot;
      if (snapshot.changedGeneration !== undefined) {
        for (const listener of store.events.rawListeners("workspace-dirty")) {
          try { listener.call(store.events, { generation: snapshot.changedGeneration }); } catch { /* Business commit remains successful. */ }
        }
      }
      if (snapshot.notifyWork) for (const listener of store.events.rawListeners("maintenance-work")) {
        try { listener.call(store.events); } catch { /* A wakeup cannot roll back a durable command. */ }
      }
    },
  };
  let releaseObserver: () => void;
  try { releaseObserver = store.observeTransactions(observer); } catch (error) { releaseGuard(); throw error; }
  let active = true;
  const dispose = () => { if (!active) return; releaseObserver(); releaseGuard(); installed.delete(store); active = false; };
  installed.set(store, dispose); return dispose;
}
