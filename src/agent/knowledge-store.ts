import { check } from "../domain/errors.js";
import type { KnowledgeBundle } from "./knowledge-bundle.js";
import type { KnowledgeInstallationHost, KnowledgeInstallationOperation } from "./knowledge-service.js";
import { AgentStore, type OperationRow } from "./store.js";

/** Approved database adapter, sharing the existing AgentStore/connection. No sidecar knowledge
 * truth. The service's staging journal is validated against these durable operation records.
 */
export class AgentKnowledgeInstallationHost implements KnowledgeInstallationHost {
  constructor(private readonly store: AgentStore, private readonly stopConnections: (signal: AbortSignal) => Promise<void>) {}
  current(): ReturnType<KnowledgeInstallationHost["current"]> {
    const row = this.store.db.prepare("SELECT knowledge_hash,state FROM agent_knowledge_installation WHERE id='current'").get() as { knowledge_hash: string; state: "initializing" | "ready" | "failed" } | undefined;
    if (!row) return;
    const workspace = this.store.db.prepare("SELECT knowledge_hash,installation_state FROM agent_workspaces WHERE id='maintenance' AND relative_path='agent/workspace'").get();
    const consistent = row.state !== "ready" || (workspace?.knowledge_hash === row.knowledge_hash && workspace.installation_state === "ready");
    return { hash: row.knowledge_hash, state: consistent ? row.state : "failed", workspaceOwned: !!workspace };
  }
  private view(row: OperationRow | undefined): KnowledgeInstallationOperation | undefined {
    if (!row || row.kind !== "knowledge_install" || row.subject_id !== "maintenance" || row.actor_key !== "system") return;
    let metadata: { knowledgeHash?: unknown; hadWorkspace?: unknown };
    try { metadata = JSON.parse(row.result_json ?? "null") as typeof metadata; } catch { return; }
    if (!metadata || typeof metadata.knowledgeHash !== "string" || typeof metadata.hadWorkspace !== "boolean") return;
    return { id: row.id, hash: metadata.knowledgeHash, hadWorkspace: metadata.hadWorkspace, succeeded: row.status === "succeeded" && row.settled_at !== null };
  }
  operation(id: string): KnowledgeInstallationOperation | undefined {
    return this.view(this.store.db.prepare("SELECT * FROM agent_operations WHERE id=?").get(id) as unknown as OperationRow | undefined);
  }
  pending(): KnowledgeInstallationOperation[] {
    const rows = this.store.db.prepare("SELECT * FROM agent_operations WHERE kind='knowledge_install' AND actor_key='system' AND subject_id='maintenance' AND settled_at IS NULL ORDER BY created_at,id").all() as unknown as OperationRow[];
    return rows.map(row => { const view = this.view(row); check(view, "KNOWLEDGE_OPERATION_INVALID", "知识安装操作元数据损坏", 503); return view; });
  }
  quiesce(signal: AbortSignal): Promise<void> { return this.stopConnections(signal); }
  begin(id: string, bundle: KnowledgeBundle, hadWorkspace: boolean): void {
    this.store.transaction(() => {
      check(this.pending().length === 0, "KNOWLEDGE_OPERATION_ACTIVE", "已有未完成的知识安装操作", 409);
      const now = Date.now(), metadata = JSON.stringify({ knowledgeHash: bundle.hash, hadWorkspace });
      this.store.db.prepare(`INSERT INTO agent_operations(id,subject_id,actor_key,kind,request_id,request_hash,status,phase,result_json,created_at,updated_at)
        VALUES(?,'maintenance','system','knowledge_install',?,?,'running','prepared',?,?,?)`).run(id, id, bundle.hash, metadata, now, now);
      this.store.db.prepare(`INSERT INTO agent_knowledge_installation(id,bundle_version,knowledge_hash,manifest_json,state,updated_at)
        VALUES('current',?,?,?,'initializing',?) ON CONFLICT(id) DO UPDATE SET bundle_version=excluded.bundle_version,knowledge_hash=excluded.knowledge_hash,manifest_json=excluded.manifest_json,state='initializing',error_json=NULL,updated_at=excluded.updated_at`)
        .run(bundle.manifest.bundleVersion, bundle.hash, bundle.manifestText, now);
      this.store.db.prepare(`INSERT INTO agent_workspaces(id,relative_path,knowledge_hash,installation_state,revision,updated_at)
        VALUES('maintenance','agent/workspace',?,'initializing',1,?) ON CONFLICT(id) DO UPDATE SET installation_state='initializing',updated_at=excluded.updated_at`).run(bundle.hash, now);
    });
  }
  commit(id: string, bundle: KnowledgeBundle): void {
    this.store.transaction(() => {
      const operation = this.operation(id), current = this.current();
      const row = this.store.db.prepare("SELECT status,settled_at FROM agent_operations WHERE id=?").get(id);
      check(row?.settled_at === null && row.status === "running" && operation && !operation.succeeded && operation.hash === bundle.hash && current?.hash === bundle.hash && current.state === "initializing", "KNOWLEDGE_OPERATION_CONFLICT", "知识提交不属于当前安装操作", 409);
      // Also rejects queued or interrupted/uncertain old turns even if a buggy host claimed quiescence.
      this.store.markKnowledgeOutdated(bundle.hash);
      const now = Date.now();
      this.store.db.prepare("UPDATE agent_knowledge_installation SET state='ready',error_json=NULL,updated_at=? WHERE id='current'").run(now);
      this.store.db.prepare("UPDATE agent_workspaces SET knowledge_hash=?,installation_state='ready',revision=revision+1,updated_at=? WHERE id='maintenance'").run(bundle.hash, now);
      this.store.db.prepare("UPDATE agent_operations SET status='succeeded',phase='done',updated_at=?,settled_at=? WHERE id=?").run(now, now, id);
    });
  }
  fail(id: string, code: string): void {
    this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM agent_operations WHERE id=?").get(id) as unknown as OperationRow | undefined;
      if (!row || row.settled_at !== null) return; // Do not undo a confirmed installation after a cleanup failure.
      check(this.view(row), "KNOWLEDGE_OPERATION_INVALID", "无效的知识安装操作", 503);
      const now = Date.now(), error = JSON.stringify({ code });
      this.store.db.prepare("UPDATE agent_operations SET status='failed',phase='done',error_json=?,updated_at=?,settled_at=? WHERE id=?").run(error, now, now, id);
      this.store.db.prepare("UPDATE agent_knowledge_installation SET state='failed',error_json=?,updated_at=? WHERE id='current' AND knowledge_hash=? AND state!='ready'").run(error, now, row.request_hash);
      this.store.db.prepare("UPDATE agent_workspaces SET installation_state='failed',updated_at=? WHERE id='maintenance' AND installation_state!='ready'").run(now);
    });
  }
}
