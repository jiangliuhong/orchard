import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadKnowledgeBundle } from "../agent/knowledge-bundle.js";
import { projectionSegment } from "../agent/workspace-projection.js";
import { WORKSPACE_MAINTENANCE_SCHEMA } from "../agent/workspace-schema.js";
import { canonicalJson, digest, FileStore } from "../persistence/files.js";
import { inspectBridgeConfig } from "../web-bridge/config-validation.js";
import { bridgeDeclaration } from "../web-bridge/database-config.js";
import { defaultBridgeConfig, migrateBridgeConfigV0 } from "./config.js";
import { present, safe } from "./journal.js";
import { source, validateLedger } from "./planner.js";
import { MigrationError } from "./types.js";

function browserDeclaration(root: string): string {
  const path = safe(root, "config/web-bridge.json");
  if (!present(path)) return bridgeDeclaration(JSON.stringify(defaultBridgeConfig()));
  const text = readFileSync(path, "utf8");
  return bridgeDeclaration(inspectBridgeConfig(text).version === 0 ? JSON.stringify(migrateBridgeConfigV0(text)) : text);
}

function draftBindings(db: DatabaseSync, root: string) {
  const files = new FileStore(root);
  const rows = db.prepare(`SELECT d.id, d.workflow_id, d.artifact_path, d.created_at, d.published_version_id,
    v.workflow_id AS published_workflow FROM drafts d LEFT JOIN workflow_versions v ON v.id=d.published_version_id ORDER BY d.id`).all();
  return rows.map(row => {
    const definition = JSON.parse(files.readTree(String(row.artifact_path)).files["workflow.json"]!);
    const id = projectionSegment(definition?.id);
    if ((row.workflow_id !== null && row.workflow_id !== id) || (row.published_version_id !== null && row.published_workflow !== id))
      throw new MigrationError("PROJECTION_IDENTITY_CONFLICT");
    return { draftId: String(row.id), resourceId: id, createdAt: Number(row.created_at) };
  });
}

/** Runs inside the migration engine's transaction on the disposable work copy. */
export function applyWorkspaceV11(db: DatabaseSync, workRoot: string) {
  if (!db.isTransaction || db.prepare("PRAGMA user_version").get()?.user_version !== 10)
    throw new MigrationError("CHAIN_UNSUPPORTED");
  db.exec(WORKSPACE_MAINTENANCE_SCHEMA);
  seedWorkspaceV11(db, workRoot);
  db.exec("PRAGMA user_version=11");
}

/** Shared by the upgrade and the v11 initialization baseline. */
export function seedWorkspaceV11(db: DatabaseSync, workRoot: string) {
  if (!db.isTransaction) throw new MigrationError("INVALID_STATE");
  const declaration = browserDeclaration(workRoot);
  const bindings = draftBindings(db, workRoot);
  const knowledgeHash = loadKnowledgeBundle().hash;
  const now = Date.now();
  db.prepare("INSERT INTO bridge_configuration VALUES('current',1,?,?,?)").run(declaration, digest(declaration), now);
  const insert = db.prepare("INSERT INTO agent_workspace_workflow_bindings VALUES(?,?,?)");
  for (const binding of bindings) insert.run(binding.draftId, binding.resourceId, binding.createdAt);
  db.prepare("INSERT INTO agent_workspace_projection_state VALUES('maintenance',1,0,?,NULL,NULL,'pending',NULL,?)").run(knowledgeHash, now);
  if (db.prepare("PRAGMA foreign_key_check").all().length) throw new MigrationError("DATABASE_CORRUPT");
}

/** Reads the actual directory without acquiring its write lease or staging files there. */
export function inspectWorkspaceV11(root: string) {
  const before = source(root);
  validateLedger(root, before);
  if (before.database !== 10) throw new MigrationError("CHAIN_UNSUPPORTED");
  const db = new DatabaseSync(safe(root, "workbench.db"), { readOnly: true });
  try {
    const bindings = draftBindings(db, root);
    const declaration = browserDeclaration(root);
    const config = JSON.parse(declaration);
    const blockers = [
      ...(present(safe(root, "workbench.lock")) ? ["INSTANCE_LOCKED"] : []),
      ...(present(safe(root, "agent/workspace")) ? ["LEGACY_WORKSPACE_ARCHIVE_REQUIRED"] : []),
    ];
    const summary = {
      dataDirectory: root, from: 10, to: 11, sourceFingerprint: before.fingerprint,
      schemaHash: digest(WORKSPACE_MAINTENANCE_SCHEMA), workflowBindings: bindings.length,
      browser: { declarationHash: digest(declaration), applications: Object.keys(config.applications).length, tools: Object.keys(config.tools).length },
      retainedLegacyConversations: Number(db.prepare("SELECT count(*) AS count FROM agent_conversations").get()!.count),
      blockers,
    };
    if (source(root).fingerprint !== before.fingerprint) throw new MigrationError("SOURCE_CHANGED");
    return { ...summary, previewHash: digest(canonicalJson(summary)) };
  } finally {
    db.close();
  }
}
