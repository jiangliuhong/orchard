import { existsSync, readFileSync } from "node:fs";
import { AppError } from "../domain/errors.js";
import { canonicalJson, digest } from "../persistence/files.js";
import type { Store } from "../persistence/store.js";
import { bridgeDeclaration } from "../web-bridge/database-config.js";
import { WORKSPACE_MAINTENANCE_SCHEMA } from "./workspace-schema.js";
import { WORKSPACE_TABLES } from "./workspace-state.js";
import { projectionSegment } from "./workspace-projection.js";

/** Read-only operator preflight, never an Agent tool or a migration executor.
 * Gives a stable fingerprint and explicit blocking reasons without rewriting
 * schema versions, adopting cwd, exposing source/credentials or resetting history.
 */
export function previewWorkspaceMigration(store: Store) {
  store.directoryLease.assert();
  const installed = WORKSPACE_TABLES.filter(name => store.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name));
  const blockers: { code: string; draftId?: string }[] = [];
  if (installed.length > 0 && installed.length !== WORKSPACE_TABLES.length) blockers.push({ code: "WORKSPACE_SCHEMA_PARTIAL" });
  const drafts = store.drafts(), bindings: { draftId: string; resourceId: string }[] = [];
  if (drafts.length > 2000) blockers.push({ code: "WORKSPACE_PREFLIGHT_TOO_LARGE" });
  for (const draft of drafts.slice(0, 2000)) {
    try {
      const files = store.files.readTree(draft.artifactPath).files;
      const definition = JSON.parse(files["workflow.json"]!) as { id?: unknown };
      if (typeof definition.id !== "string") throw new AppError("PROJECTION_IDENTITY_UNAVAILABLE", "missing identity");
      projectionSegment(definition.id);
      if (draft.workflowId && draft.workflowId !== definition.id) throw new AppError("PROJECTION_IDENTITY_CONFLICT", "identity mismatch");
      if (draft.publishedVersionId && store.version(draft.publishedVersionId).workflowId !== definition.id) throw new AppError("PROJECTION_IDENTITY_CONFLICT", "published identity mismatch");
      bindings.push({ draftId: draft.id, resourceId: definition.id });
    } catch (error) { blockers.push({ code: error instanceof AppError ? error.code : "PROJECTION_IDENTITY_UNAVAILABLE", draftId: draft.id }); }
  }
  let browser: { hash: string; applications: number; environments: number; tools: number; source: "database" | "legacy-file" } | null = null;
  try {
    const row = installed.includes("bridge_configuration") ? store.one<{ config_json: string; content_hash: string }>("SELECT config_json,content_hash FROM bridge_configuration WHERE id='current'") : undefined;
    if (installed.includes("bridge_configuration") && !row) throw new AppError("BRIDGE_CONFIG_INVALID", "missing migrated declaration");
    const declaration = row ? row.config_json : bridgeDeclaration(readFileSync(store.files.path("config/web-bridge.json"), "utf8"));
    if (row && digest(declaration) !== row.content_hash) throw new AppError("BRIDGE_CONFIG_INVALID", "declaration hash mismatch");
    const config = JSON.parse(declaration) as { applications: object; environments: Record<string, unknown[]>; tools: object };
    browser = { hash: digest(declaration), applications: Object.keys(config.applications).length, environments: Object.values(config.environments).reduce((sum, environments) => sum + environments.length, 0), tools: Object.keys(config.tools).length, source: row ? "database" : "legacy-file" };
  } catch (error) { blockers.push({ code: error instanceof AppError ? error.code : "BRIDGE_CONFIG_INVALID" }); }
  // Current release manifest intentionally remains unchanged: its next version
  // and complete runtime cutover need separate release review, not an auto-lock.
  blockers.push({ code: "WORKSPACE_MIGRATION_RELEASE_REQUIRED" }, { code: "WORKSPACE_RUNTIME_CERTIFICATION_REQUIRED" });
  let workspaceExists = false;
  try { workspaceExists = existsSync(store.files.path("agent/workspace")); }
  catch { blockers.push({ code: "WORKSPACE_PATH_INVALID" }); }
  const schema = store.all<{ name: string; sql: string }>("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name");
  const fields = {
    drafts: "id,workflow_id,base_version_id,revision,artifact_path,published_version_id,status",
    workflows: "id,name,current_version_id",
    workflow_versions: "id,workflow_id,version_no,artifact_path,content_hash",
    scripts: "id,name,description,runtime,status,current_draft_version_id,current_published_version_id",
    script_versions: "id,script_id,version_no,status,revision,source_ref,content_hash",
  };
  const sourceRows = Object.fromEntries(Object.entries(fields).map(([table, columns]) => {
    const rows = store.all(`SELECT ${columns} FROM ${table} ORDER BY id LIMIT 2001`);
    if (rows.length > 2000) blockers.push({ code: "WORKSPACE_PREFLIGHT_TOO_LARGE" });
    return [table, rows.slice(0, 2000)];
  }));
  const version = store.one<{ user_version: number }>("PRAGMA user_version")!.user_version;
  const value = { formatVersion: 1, executable: false, proposedMigrationVersion: null, schemaVersion: version, schemaHash: digest(WORKSPACE_MAINTENANCE_SCHEMA),
    sourceFingerprint: digest(canonicalJson({ schema, sourceRows, browser })), installedTables: installed,
    bindings: bindings.sort((a, b) => a.draftId.localeCompare(b.draftId)), browser,
    workspace: { exists: workspaceExists, requiresIndependentBackup: workspaceExists },
    legacySessions: Number(store.one<{ n: number }>("SELECT count(*) AS n FROM agent_conversations")?.n ?? 0), blockers,
    actions: ["backup_database_and_managed_artifacts", "preview_and_confirm_legacy_workspace_move", "install_reviewed_schema_in_versioned_migration", "import_browser_declaration_and_workflow_bindings_atomically", "preserve_legacy_sessions_without_context_replay", "verify_readonly_provider_boundary_before_activation"] };
  return { ...value, planHash: digest(canonicalJson(value)) };
}
