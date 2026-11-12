import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { setup, prepareMaintenanceFixture } from "./helpers.js";
import { installWorkspaceBusinessTracking, workspaceSchemaInstalled } from "../src/agent/workspace-business-hooks.js";
import { bridgeDeclaration } from "../src/web-bridge/database-config.js";
import { configuredWebBridge } from "../src/web-bridge/configured.js";
import { DatabaseBridgeConfiguration } from "../src/web-bridge/database-config.js";
import { WebBridgeGateway } from "../src/web-bridge/gateway.js";
import { WebBridgeClient } from "../src/web-bridge/client.js";
import { ConfigGitService } from "../src/config-git/service.js";
import { canonicalJson, digest } from "../src/persistence/files.js";
import { configCoordinator, ConfigWriteCoordinator, registerConfigCoordinator } from "../src/config-git/coordinator.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { ScriptAgentService } from "../src/authoring/script-agent.js";
import { BridgeAgentService } from "../src/web-bridge/agent.js";
import { ConfigRestoreService } from "../src/config-git/restore.js";
import { captureSnapshot, targetFingerprint } from "../src/config-git/restore-import.js";
import { exportSnapshot } from "../src/config-git/snapshot.js";
import { createApp } from "../src/server/app.js";

const H = "a".repeat(64), K = "b".repeat(64);
async function fixture(t: TestContext, options: { portable?: boolean; track?: boolean } = {}) {
  const f = setup(t); t.after(async () => { await f.authoring.close(); f.store.close(); });
  const draft = await f.authoring.create(undefined, "initial-draft");
  const files = f.store.files.readTree(draft.artifactPath).files, resourceId = JSON.parse(files["workflow.json"]!).id;
  if (options.portable) {
    f.store.exec("DELETE FROM agent_model_config_revisions"); f.store.exec("DELETE FROM agent_model_configs"); f.store.exec("DELETE FROM provider_settings");
  }
  prepareMaintenanceFixture(f.store);
  const declaration = bridgeDeclaration(readFileSync(f.store.files.path("config/web-bridge.json"), "utf8"));
  f.store.exec("INSERT INTO bridge_configuration VALUES('current',1,?,?,?)", declaration, digest(declaration), Date.now());
  f.store.exec("INSERT INTO agent_workspace_projection_state VALUES('maintenance',1,1,?,?,?,'ready',NULL,?)", K, K, H, Date.now());
  f.store.exec("INSERT INTO agent_workspace_workflow_bindings VALUES(?,?,?)", draft.id, resourceId, draft.createdAt);
  const dispose = options.track === false ? () => {} : installWorkspaceBusinessTracking(f.store);
  t.after(dispose);
  return { ...f, draft, resourceId, files, dispose, generation: () => f.store.one<{ target_generation: number }>("SELECT target_generation FROM agent_workspace_projection_state")!.target_generation,
    active() {
      const now = Date.now();
      f.store.exec("UPDATE agent_workspace_projection_state SET synced_generation=target_generation,state='ready'");
      f.store.exec("INSERT INTO agent_maintenance_sessions(id,actor_key,scenario,owner_kind,owner_id,owner_scope_json,mode,provider_id,model_id,contract_version,tool_policy_version,knowledge_hash,generation,revision,lifecycle,native_delete_state,created_at,updated_at) VALUES('session','local','workflow','workflow_draft',?,?,'multi','test-provider','test-model','orchard.maintenance.v1','readonly',?,1,1,'active','absent',?,?)", resourceId, canonicalJson({ draftId: draft.id }), K, now, now);
      const generation = f.store.one<{ target_generation: number }>("SELECT target_generation FROM agent_workspace_projection_state")!.target_generation;
      f.store.exec("INSERT INTO agent_maintenance_tasks(id,session_id,mode,request_id,request_hash,sequence,generation,projection_generation,projection_hash,baseline_json,status,process_state,created_at) VALUES('task','session','multi','turn',?,1,1,?,?,'{}','running','running',?)", H, generation, H, now);
    },
  };
}

test("real authoring create/edit/copy/publish/delete commands bind stable identity and dirty the same transaction", async t => {
  const f = await fixture(t), before = f.generation();
  const draft = await f.authoring.create(undefined, "new-draft");
  const id = JSON.parse(f.store.files.readTree(draft.artifactPath).files["workflow.json"]!).id;
  assert.equal(f.store.one("SELECT resource_id FROM agent_workspace_workflow_bindings WHERE draft_id=?", draft.id)!.resource_id, id);
  assert.equal(f.generation(), before + 1);
  const published = await f.authoring.publish(draft.id, draft.revision, "publish");
  assert.equal(published.workflowId, id); const publishedGeneration = f.generation();
  const edit = await f.authoring.editVersion(id, published.id, "edit", "edit");
  assert.equal(f.store.one("SELECT resource_id FROM agent_workspace_workflow_bindings WHERE draft_id=?", edit.id)!.resource_id, id);
  const copy = await f.authoring.editVersion(id, published.id, "copy", "copy");
  const copyId = JSON.parse(f.store.files.readTree(copy.artifactPath).files["workflow.json"]!).id;
  assert.notEqual(copyId, id); assert.equal(f.store.one("SELECT resource_id FROM agent_workspace_workflow_bindings WHERE draft_id=?", copy.id)!.resource_id, copyId);
  assert.ok(f.generation() > publishedGeneration);
  const generation = f.generation(); f.authoring.deleteDraft(copy.id);
  assert.equal(f.generation(), generation + 1); assert.equal(f.store.one("SELECT draft_id FROM agent_workspace_workflow_bindings WHERE draft_id=?", copy.id), undefined);
});

test("nested script and browser writes coalesce to one dirty generation; record-only and timestamp changes do not dirty", async t => {
  const f = await fixture(t), bridge = configuredWebBridge(f.store);
  const library = new ScriptLibrary(f.store);
  await library.create({ id: "sample", name: "Sample", description: "", runtime: "nodejs", entryFile: "main.ts", files: { "main.ts": "export default async () => 1;" }, inputSchema: true, outputSchema: true });
  const before = f.generation();
  f.store.transaction(() => {
    f.store.exec("UPDATE scripts SET name='Renamed' WHERE id='sample'");
    bridge.saveApplication({ id: "crm", name: "CRM" });
    f.store.transaction(() => f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id));
  });
  assert.equal(f.generation(), before + 1);
  const clean = f.generation();
  f.store.exec("UPDATE drafts SET updated_at=updated_at+1 WHERE id=?", f.draft.id);
  f.store.exec("INSERT INTO command_receipts VALUES('display-only','request',?,'{}',?)", H, Date.now());
  assert.equal(f.generation(), clean);
});

test("direct browser tool and application deletions roll back when a retained workflow references the tool", async t => {
  const f = await fixture(t), bridge = configuredWebBridge(f.store);
  bridge.saveApplication({ id: "crm", name: "CRM" });
  bridge.saveTool({ application: "crm", toolId: "read", site: "crm", description: "Read", path: "/api/read", method: "GET",
    parameters: { type: "object" }, fields: [], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1" });
  const workflow = JSON.parse(f.files["workflow.json"]!);
  workflow.nodes.push({ type: "web-bridge", config: { application: "crm", tool: "read" } });
  const tree = f.store.files.saveTree({ ...f.files, "workflow.json": JSON.stringify(workflow) });
  f.store.exec("UPDATE drafts SET artifact_path=?,revision=revision+1 WHERE id=?", tree.path, f.draft.id);
  const before = f.generation();
  assert.throws(() => bridge.deleteTool("crm", "read"), { code: "RESOURCE_IN_USE" });
  assert.throws(() => bridge.deleteApplication("crm"), { code: "RESOURCE_IN_USE" });
  assert.equal(bridge.tools("crm").length, 1);
  assert.equal(f.generation(), before);
  f.authoring.deleteDraft(f.draft.id);
  bridge.deleteApplication("crm");
  assert.equal(bridge.application("crm"), undefined);
});

test("queued tasks reject every configuration writer before entry and direct Store SQL rolls back; records remain writable", async t => {
  const f = await fixture(t); f.active(); const generation = f.generation();
  let entered = false;
  assert.throws(() => configCoordinator(f.store).withWrite(() => { entered = true; }), { code: "WORKSPACE_BUSY" }); assert.equal(entered, false);
  assert.throws(() => f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id), { code: "WORKSPACE_BUSY" });
  assert.equal(f.store.draft(f.draft.id).revision, f.draft.revision);
  await configCoordinator(f.store).withRead(async () => {
    f.store.exec("UPDATE agent_maintenance_tasks SET display_output_ref=? WHERE id='task'", canonicalJson({ inline: "display text" }));
    f.store.exec("INSERT INTO command_receipts VALUES('confirmation-record','request',?,'{}',?)", H, Date.now());
  });
  assert.equal(f.generation(), generation);
  const replacement = new ConfigWriteCoordinator(); registerConfigCoordinator(f.store, replacement);
  assert.throws(() => replacement.withWrite(() => {}), { code: "WORKSPACE_BUSY" });
});

test("existing binding deletion/replacement and identity drift roll back, including pending command receipts", async t => {
  const f = await fixture(t), generation = f.generation();
  assert.throws(() => f.store.command("bad-rebind", "request", {}, () => {
    f.store.exec("DELETE FROM agent_workspace_workflow_bindings WHERE draft_id=?", f.draft.id);
    return { ok: true };
  }), { code: "PROJECTION_IDENTITY_CONFLICT" });
  assert.equal(f.store.one("SELECT 1 FROM command_receipts WHERE scope='bad-rebind'"), undefined);
  const changed = f.store.files.saveTree({ ...f.files, "workflow.json": JSON.stringify({ ...JSON.parse(f.files["workflow.json"]!), id: "different" }) });
  assert.throws(() => f.store.exec("UPDATE drafts SET artifact_path=? WHERE id=?", changed.path, f.draft.id), { code: "PROJECTION_IDENTITY_CONFLICT" });
  assert.equal(f.store.draft(f.draft.id).artifactPath, f.draft.artifactPath); assert.equal(f.generation(), generation);
});

test("rollback and failed observers never claim a committed generation, while failing wakeups cannot undo success", async t => {
  const f = await fixture(t), generation = f.generation();
  assert.throws(() => f.store.transaction(() => {
    f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id); throw new Error("rollback");
  }), /rollback/);
  assert.equal(f.generation(), generation); assert.equal(f.store.draft(f.draft.id).revision, 0);
  let notified = 0; f.store.events.on("workspace-dirty", () => { notified++; throw new Error("listener failed"); });
  f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id);
  assert.equal(f.generation(), generation + 1); assert.equal(notified, 1);
});

test("migrated export/capture/fingerprints never read stale legacy JSON; restore commits browser DB without installing a file", async t => {
  const f = await fixture(t, { portable: true }), bridge = configuredWebBridge(f.store);
  bridge.saveApplication({ id: "crm", name: "Database app" });
  const fingerprint = targetFingerprint(f.store), legacy = f.store.files.path("config/web-bridge.json");
  writeFileSync(legacy, "LEGACY_STALE_MARKER_NOT_JSON");
  assert.equal(targetFingerprint(f.store), fingerprint);
  const exported = exportSnapshot(f.store, bridge, "light"); assert.equal(exported.snapshot.webBridge.applications.crm!.name, "Database app");
  const captured = captureSnapshot(f.store, "light").snapshot; captured.webBridge.applications.crm!.name = "Restored database app";
  const restore = new ConfigRestoreService(f.store, configCoordinator(f.store), { async afterRestore() { bridge.reloadAfterRestore(); } });
  const preview = await restore.preview(captured, { categories: ["webBridge"] }), generation = f.generation();
  const result = await restore.apply("restore-db-bridge", preview.token);
  assert.equal(result.phase, "completed"); assert.equal(result.files.some(file => file.target === "config/web-bridge.json"), false);
  assert.equal(bridge.application("crm")!.name, "Restored database app"); assert.equal(f.generation(), generation + 1);
  assert.equal(readFileSync(legacy, "utf8"), "LEGACY_STALE_MARKER_NOT_JSON");
  assert.deepEqual(await restore.apply("restore-db-bridge", preview.token), result);
});

test("legacy Agent mutation routes stop before model calls once the reviewed schema is installed", async t => {
  const f = await fixture(t), scripts = new ScriptAgentService(f.store, f.providers), bridge = configuredWebBridge(f.store);
  const browser = new BridgeAgentService(f.store.files, bridge, f.providers);
  try {
    await assert.rejects(f.authoring.start(f.draft.id, { prompt: "change", expectedRevision: 0, requestId: "legacy" }), { code: "LEGACY_AGENT_DISABLED" });
    assert.throws(() => scripts.start("missing", { prompt: "change", expectedRevision: 0, requestId: "legacy" }), { code: "LEGACY_AGENT_DISABLED" });
    await assert.rejects(scripts.apply("missing", { turnId: "turn", expectedRevision: 0, requestId: "legacy" }), { code: "LEGACY_AGENT_DISABLED" });
    assert.throws(() => browser.start("missing", { prompt: "change", conversationId: "conversation", requestId: "legacy" }), { code: "LEGACY_AGENT_DISABLED" });
    assert.throws(() => browser.apply("missing", "turn"), { code: "LEGACY_AGENT_DISABLED" });
    assert.equal(f.provider.calls.length, 0);
  } finally { await scripts.close(); await browser.close(); }
});

test("production app chooses DB configuration and installs real write tracking only for migrated stores", async t => {
  const f = await fixture(t, { track: false });
  const { app, bridge } = createApp(f.store, f.providers);
  try {
    await app.ready(); const generation = f.generation(); bridge.saveApplication({ id: "crm", name: "Production factory" });
    assert.equal(f.generation(), generation + 1);
    assert.equal(JSON.parse(f.store.one<{ config_json: string }>("SELECT config_json FROM bridge_configuration")!.config_json).applications.crm.name, "Production factory");
    const response = await app.inject({ method: "POST", url: `/api/drafts/${f.draft.id}/turns`, payload: { providerId: "test-provider", modelId: "test-model", prompt: "change", expectedRevision: 0, requestId: "legacy" } });
    assert.equal(response.statusCode, 409); assert.equal(response.json().code, "LEGACY_AGENT_DISABLED");
  } finally { await app.close(); }
});

test("DB-backed readers see other commits and outer rollbacks; stale apply conflicts cannot restore a stale cache", async t => {
  const f = await fixture(t), bridge = configuredWebBridge(f.store);
  bridge.saveApplication({ id: "crm", name: "Before" });
  const staleHash = bridge.authoringSnapshot("crm").hash;
  configuredWebBridge(f.store).saveApplication({ id: "crm", name: "Other backend" });
  const definition = { application: "crm", toolId: "customers", site: "crm", description: "Query", parameters: { type: "object", properties: {}, additionalProperties: false }, path: "/customers", method: "GET", fields: ["items"], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", enabled: true };
  assert.throws(() => bridge.applyProposal("crm", staleHash, { summary: "Create", changes: [{ operation: "create", toolId: "customers", definition }] }), { code: "REVISION_CONFLICT" });
  bridge.saveApplication({ id: "additional", name: "Another app" });
  assert.equal(bridge.application("crm")!.name, "Other backend");
  const generation = f.generation();
  assert.throws(() => f.store.transaction(() => { bridge.saveApplication({ id: "rolled-back", name: "Uncommitted" }); throw new Error("abort"); }), /abort/);
  assert.equal(bridge.application("rolled-back"), undefined); assert.equal(f.generation(), generation);
  f.store.db.exec("UPDATE bridge_configuration SET revision=revision+1,content_hash='" + "f".repeat(64) + "'");
  assert.throws(() => bridge.applications(), { code: "BRIDGE_CONFIG_INVALID" });
});

test("connection-only profile registration stays live during model reads but automatic bindings take the business gate", async t => {
  const f = await fixture(t), config = configuredWebBridge(f.store), gateway = new WebBridgeGateway(new WebBridgeClient("unused.sock", "catalog"), config);
  config.saveApplication({ id: "crm", name: "CRM" });
  config.saveEnvironment("crm", { id: "production", origin: "https://example.com", profileId: "old-extension" });
  f.active(); const generation = f.generation(), coordinatorGeneration = configCoordinator(f.store).generation;
  await configCoordinator(f.store).withRead(async () => {
    gateway.registerProfile({ id: "unrelated", name: "Connected", extensionId: "extension" });
    const backend = new DatabaseBridgeConfiguration(f.store), runtime = JSON.parse(backend.read());
    runtime.environments.crm[0].bound = true; runtime.environments.crm[0].tabAvailable = true;
    backend.write(JSON.stringify(runtime));
  });
  assert.equal(gateway.profilesList().length, 1); assert.equal(f.generation(), generation);
  assert.equal(configCoordinator(f.store).generation, coordinatorGeneration);
  assert.throws(() => gateway.registerProfile({ id: "new-profile", name: "Binding migration", extensionId: "old-extension" }), { code: "WORKSPACE_BUSY" });
  assert.equal(config.environments("crm")[0]!.profileId, "old-extension"); assert.equal(gateway.profilesList().length, 1);
  await assert.rejects(new ConfigRestoreService(f.store).recover(), { code: "WORKSPACE_BUSY" });
});

test("browser DB restore rolls back as a unit and recovers a lost post-commit acknowledgement without JSON writes", async t => {
  const f = await fixture(t, { portable: true }), bridge = configuredWebBridge(f.store);
  bridge.saveApplication({ id: "crm", name: "Before" });
  const snapshot = captureSnapshot(f.store, "light").snapshot; snapshot.webBridge.applications.crm!.name = "After";
  const before = f.store.one("SELECT * FROM bridge_configuration"), generation = f.generation();
  const failing = new ConfigRestoreService(f.store, configCoordinator(f.store), { fault(phase) { if (phase === "transaction") throw new Error("rollback"); } });
  await assert.rejects(failing.apply("rollback", (await failing.preview(snapshot, { categories: ["webBridge"] })).token), /rollback/);
  assert.deepEqual(f.store.one("SELECT * FROM bridge_configuration"), before); assert.equal(f.generation(), generation);
  assert.equal(f.store.one("SELECT 1 FROM command_receipts WHERE scope='config-git:restore'"), undefined);
  const lost = new ConfigRestoreService(f.store, configCoordinator(f.store), { fault(phase) { if (phase === "database_committed_before_journal") throw new Error("lost acknowledgement"); } });
  const preview = await lost.preview(snapshot, { categories: ["webBridge"] });
  await assert.rejects(lost.apply("lost", preview.token), /lost acknowledgement/);
  assert.equal(f.generation(), generation + 1);
  const recovered = new ConfigRestoreService(f.store); await recovered.recover();
  assert.equal(recovered.operations().find(operation => operation.requestId === "lost")!.phase, "completed");
  assert.equal(bridge.application("crm")!.name, "After"); assert.equal(f.generation(), generation + 1);
});

test("Git preview redaction collects DB-backed local references instead of legacy JSON", async t => {
  const f = await fixture(t, { portable: true }), bridge = configuredWebBridge(f.store);
  bridge.saveApplication({ id: "crm", name: "CRM" });
  bridge.saveEnvironment("crm", { id: "production", origin: "https://example.com", profileId: "db-private-profile-marker" });
  writeFileSync(f.store.files.path("config/web-bridge.json"), "STALE_NOT_JSON");
  const git = new ConfigGitService(f.store, bridge, new ConfigRestoreService(f.store));
  git.repository.previewCommit = async () => ({ token: "preview", expiresAt: Date.now() + 10000, diff: [{ path: "scripts/demo/main.ts", before: null, after: "db-private-profile-marker" }], cumulativeDiff: [], push: false, regenerate: false }) as any;
  try {
    const preview = await git.commitPreview({ theme: "light", message: "Backup" });
    assert.equal(preview.diffs[0]!.sensitive, true); assert.equal(preview.diffs[0]!.after, "[已隐藏敏感内容]");
  } finally { await git.close(); }
});

test("production startup refuses uncertain persisted tasks before legacy recovery or queue activation", async t => {
  const f = await fixture(t, { track: false }); f.active();
  let recovered = false, retained: unknown;
  f.store.recoverBusiness = () => { recovered = true; };
  const close = f.store.close.bind(f.store);
  f.store.close = () => { if (f.store.db.isOpen) retained = { ...f.store.one<{ status: string; process_state: string }>("SELECT status,process_state FROM agent_maintenance_tasks WHERE id='task'") }; close(); };
  const { app } = createApp(f.store, f.providers);
  try { await assert.rejects(async () => { await app.ready(); }, { code: "WORKSPACE_BUSY" }); }
  finally { await app.close(); }
  assert.equal(recovered, false); assert.deepEqual(retained, { status: "running", process_state: "running" });
});

test("bulk workflow import creates draft bindings inside its one business commit", async t => {
  const f = await fixture(t, { portable: true }), snapshot = captureSnapshot(f.store, "light").snapshot;
  const files = { ...f.files, "workflow.json": JSON.stringify({ ...JSON.parse(f.files["workflow.json"]!), id: "imported", name: "Imported" }) };
  snapshot.workflows.push({ id: "imported", name: "Imported", currentPublishedVersionId: null, draft: { files, baseVersionId: null }, versions: [] });
  const service = new ConfigRestoreService(f.store), preview = await service.preview(snapshot, { categories: ["workflows"] }), generation = f.generation();
  await service.apply("import-workflow", preview.token);
  const binding = f.store.one<{ draft_id: string }>("SELECT draft_id FROM agent_workspace_workflow_bindings WHERE resource_id='imported'");
  assert.ok(binding); assert.equal(f.store.draft(binding.draft_id).workflowId, null); assert.equal(f.generation(), generation + 1);
});

test("partial schema is a migration error, not a legacy JSON fallback", t => {
  const f = setup(t); t.after(async () => { await f.authoring.close(); f.store.close(); });
  if (workspaceSchemaInstalled(f.store)) f.store.db.exec("DROP TABLE agent_maintenance_apply_requests");
  else f.store.db.exec("CREATE TABLE bridge_configuration(id TEXT PRIMARY KEY)");
  assert.throws(() => workspaceSchemaInstalled(f.store), { code: "WORKSPACE_MIGRATION_REQUIRED" });
  assert.throws(() => configuredWebBridge(f.store), { code: "WORKSPACE_MIGRATION_REQUIRED" });
});
