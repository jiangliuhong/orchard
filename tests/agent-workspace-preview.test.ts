import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.js";
import { previewWorkspaceMigration } from "../src/agent/workspace-migration-preview.js";

test("workspace migration preflight is readonly, stable, secret/path-free and cannot activate an unreviewed release", async t => {
  const { store, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, "preview-draft");
  const source = store.files.readTree(draft.artifactPath).files, id = JSON.parse(source["workflow.json"]!).id;
  const before = store.one("SELECT total_changes() AS n"), version = store.one("PRAGMA user_version");
  const installedBefore = store.one("SELECT name FROM sqlite_master WHERE name='agent_maintenance_proposals'");
  const first = previewWorkspaceMigration(store), second = previewWorkspaceMigration(store);
  assert.deepEqual(first, second); assert.equal(first.executable, false); assert.equal(first.proposedMigrationVersion, null);
  assert.deepEqual(first.bindings, [{ draftId: draft.id, resourceId: id }]);
  assert.ok(first.blockers.some(item => item.code === "WORKSPACE_MIGRATION_RELEASE_REQUIRED"));
  assert.ok(first.blockers.some(item => item.code === "WORKSPACE_RUNTIME_CERTIFICATION_REQUIRED"));
  assert.deepEqual(store.one("SELECT total_changes() AS n"), before); assert.deepEqual(store.one("PRAGMA user_version"), version);
  assert.deepEqual(store.one("SELECT name FROM sqlite_master WHERE name='agent_maintenance_proposals'"), installedBefore);
  assert.equal(JSON.stringify(first).includes(store.root), false); assert.equal(JSON.stringify(first).includes("artifactPath"), false);
  store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", draft.id);
  assert.notEqual(previewWorkspaceMigration(store).planHash, first.planHash);
});

test("preflight blocks identity conflict and requires independent backup of existing shared workspace without adopting it", async t => {
  const { store, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, "preview-conflict");
  const installedBefore = previewWorkspaceMigration(store).installedTables;
  store.exec("UPDATE drafts SET workflow_id=? WHERE id=?", null, draft.id);
  const files = store.files.readTree(draft.artifactPath).files, invalid = store.files.saveTree({ ...files, "workflow.json": "invalid draft identity" });
  store.exec("UPDATE drafts SET artifact_path=? WHERE id=?", invalid.path, draft.id);
  const directory = join(store.root, "agent/workspace"); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "private-marker"), "KEEP");
  const report = previewWorkspaceMigration(store);
  assert.ok(report.blockers.some(item => item.code === "PROJECTION_IDENTITY_UNAVAILABLE" && item.draftId === draft.id));
  assert.equal(report.workspace.requiresIndependentBackup, true);
  assert.equal(readFileSync(join(directory, "private-marker"), "utf8"), "KEEP");
  assert.deepEqual(report.installedTables, installedBefore);
});
