import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { OrchardDatabase } from "./database.js";

export interface LegacyMigrationResult {
  readonly migrated: readonly string[];
  readonly readOnly: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Reconcile workflows that predate durable drafts. Only source directories
 * that still exist below the instance root are made editable; records whose
 * source/artifact cannot be recovered are reported read-only and never
 * promoted to the active pointer.
 */
export function migrateRegisteredWorkflows(db: OrchardDatabase): LegacyMigrationResult {
  const migrated: string[] = [];
  const readOnly: string[] = [];
  const skipped: string[] = [];
  const workflows = db.database.prepare("SELECT id, workspace_id AS workspaceId FROM workflows ORDER BY id").all() as { id: string; workspaceId: string }[];
  for (const workflow of workflows) {
    const existing = db.database.prepare("SELECT 1 FROM workflow_drafts WHERE workflow_id = ? LIMIT 1").get(workflow.id);
    if (existing) { skipped.push(workflow.id); continue; }
    const version = db.database.prepare("SELECT source_path AS sourcePath FROM workflow_versions WHERE workflow_id = ? ORDER BY version_no DESC LIMIT 1").get(workflow.id) as { sourcePath?: string } | undefined;
    const sourcePath = version?.sourcePath;
    const recoverable = sourcePath !== undefined && !sourcePath.startsWith("/") && !sourcePath.split("/").includes("..") && existsSync(resolve(db.dataDir, sourcePath));
    const id = uuidv7();
    const timestamp = Date.now();
    db.database.prepare("INSERT INTO workflow_drafts (id, workspace_id, workflow_id, base_version_id, root_path, status, created_at, updated_at) VALUES (?, ?, ?, (SELECT id FROM workflow_versions WHERE workflow_id = ? ORDER BY version_no DESC LIMIT 1), ?, ?, ?, ?)").run(id, workflow.workspaceId, workflow.id, workflow.id, recoverable ? resolve(db.dataDir, sourcePath!) : db.dataDir, recoverable ? "draft" : "read_only", timestamp, timestamp);
    (recoverable ? migrated : readOnly).push(workflow.id);
  }
  return { migrated, readOnly, skipped };
}
