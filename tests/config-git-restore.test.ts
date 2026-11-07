import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigRestoreService } from "../src/config-git/restore.js";
import { ConfigWriteCoordinator, configCoordinator } from "../src/config-git/coordinator.js";
import type { PortableSnapshot } from "../src/config-git/snapshot-types.js";
import { localReference } from "../src/config-git/snapshot-primitives.js";
import { exportSnapshot, parseSnapshot } from "../src/config-git/snapshot.js";
import { temporary, TestStore } from "./helpers.js";
import { Store } from "../src/persistence/store.js";
import { DirectoryLease } from "../src/migrations/lock.js";

function snapshot(): PortableSnapshot {
  const definition = { id: "sample", name: "Sample", description: "", runtime: "nodejs" as const, entryFile: "main.ts", inputSchema: true, outputSchema: true, timeoutMs: 10000, resultMode: "json" as const, files: { "main.ts": "export default input => input;\n" } };
  return { general: { theme: "dark" }, providers: [], webBridge: { applications: {}, environments: {}, tools: {}, enabledTools: {} }, workflows: [], scripts: [{ id: "sample", name: "Sample", description: "", runtime: "nodejs", archived: false, currentPublishedVersionId: "v-fixed", draft: structuredClone(definition), versions: [{ id: "v-fixed", definition }] }] };
}
function setup(t: Parameters<typeof temporary>[0]) { const root = temporary(t), store = new TestStore(root); t.after(() => store.close()); return { root, store, service: new ConfigRestoreService(store) }; }

test("Git restore carries named Agent configurations with Providers and retains local revision history", async t => {
  const source = snapshot(); source.scripts = [];
  source.providers = [{
    id: "pi-cli", enabled: true, config: { executable: localReference("providers", "pi-cli", "executable"), transport: "native" },
    defaultModel: "model", models: [{ id: "model", name: "Model", source: "configured", enabled: true, deleted: false }],
    agentModelConfigs: [{ id: "analysis-config", name: "分析", description: "用于分析", modelId: "model", enabled: true }],
  }];
  const definition = { formatVersion: 1, id: "analysis-workflow", name: "分析流程", inputSchema: true, outputSchema: true, entryNodeId: "agent",
    defaults: { agent: { agentConfigId: "analysis-config" } }, nodes: [{ id: "agent", name: "分析", type: "agent", input: { source: "workflow" }, outputSchema: true, config: { prompt: "分析输入" } }],
    edges: [], result: { source: "node", nodeId: "agent" } };
  source.workflows = [{ id: definition.id, name: definition.name, currentPublishedVersionId: "analysis-version", draft: null, versions: [{ id: "analysis-version", files: { "workflow.json": JSON.stringify(definition), "layout.json": "{}" } }] }];
  const first = setup(t), options = { mappings: { [localReference("providers", "pi-cli", "executable").localRef]: process.execPath } };
  await first.service.apply("restore-model-config", (await first.service.preview(source, options)).token);
  assert.equal(first.store.one("SELECT revision FROM agent_model_configs WHERE id='analysis-config'")!.revision, 1);
  const bundle = exportSnapshot(first.store, { applications: {}, environments: {}, tools: {}, enabledTools: {} }, "dark");
  const second = setup(t);
  await second.service.apply("clone", (await second.service.preview(parseSnapshot(bundle.files), options)).token);
  assert.equal(second.store.version("analysis-version").definition.defaults!.agent!.agentConfigId, "analysis-config");
  assert.equal(second.store.one("SELECT name FROM agent_model_configs WHERE id='analysis-config'")!.name, "分析");
  source.providers[0]!.agentModelConfigs![0]!.name = "新分析";
  await second.service.apply("edit", (await second.service.preview(source, options)).token);
  assert.equal(second.store.one("SELECT revision FROM agent_model_configs WHERE id='analysis-config'")!.revision, 2);
  assert.equal(second.store.one("SELECT name FROM agent_model_config_revisions WHERE config_id='analysis-config' AND revision=1")!.name, "分析");
  await second.service.apply("same", (await second.service.preview(source, options)).token);
  assert.equal(second.store.one("SELECT revision FROM agent_model_configs WHERE id='analysis-config'")!.revision, 2);
});

test("fixed identities, local sequence allocation, idempotent receipts and draft revisions", async t => {
  const { store, service } = setup(t), source = snapshot();
  const preview = await service.preview(source);
  const first = await service.apply("first", preview.token);
  assert.equal(first.phase, "completed");
  assert.equal(store.scriptVersion("v-fixed").number, 1);
  const draftId = store.script("sample").currentDraftVersionId!;
  assert.notEqual(draftId, "v-fixed");
  assert.equal(store.scriptVersion(draftId).revision, 0);
  assert.deepEqual(await service.apply("first", preview.token), first);
  await assert.rejects(service.apply("first", "different"), { code: "REQUEST_CONFLICT" });
  const again = await service.preview(source); await service.apply("second", again.token);
  assert.equal(store.scriptVersion(draftId).revision, 0);
  assert.equal(store.scriptVersions("sample").length, 2);
  const extra = structuredClone(source); extra.scripts[0]!.versions.push({ ...extra.scripts[0]!.versions[0]!, id: "a-new-version" }); extra.scripts[0]!.currentPublishedVersionId = "a-new-version";
  const third = await service.preview(extra); await service.apply("third", third.token);
  assert.equal(store.scriptVersion("a-new-version").number, 3);
  assert.equal(store.scriptVersion("v-fixed").number, 1);
  store.exec("UPDATE script_versions SET revision=revision+1 WHERE id=?", draftId);
  const altered = structuredClone(source); altered.scripts[0]!.draft!.files["main.ts"] = "export default () => 'edited';";
  const fourth = await service.preview(altered); await service.apply("fourth", fourth.token);
  assert.equal(store.scriptVersion(draftId).revision, 2);
  const fifth = await service.preview(source); await service.apply("fifth", fifth.token);
  assert.equal(store.scriptVersion(draftId).revision, 3);
});

test("immutable content and draft ID collisions fail before writes", async t => {
  const { store, service } = setup(t), source = snapshot();
  await service.apply("one", (await service.preview(source)).token);
  source.scripts[0]!.versions[0]!.definition.files["main.ts"] = "export default () => 42;";
  await assert.rejects(service.preview(source), { code: "VERSION_ID_CONFLICT" });
  const collision = snapshot(); collision.scripts[0]!.versions[0]!.id = store.script("sample").currentDraftVersionId!;
  await assert.rejects(service.preview(collision), { code: "VERSION_ID_CONFLICT" });
  assert.equal(store.all("SELECT * FROM command_receipts WHERE scope='config-git:restore'").length, 1);
});

test("transaction failure rolls back every business row and receipt", async t => {
  const { store } = setup(t);
  const service = new ConfigRestoreService(store, configCoordinator(store), { fault(phase) { if (phase === "transaction") throw new Error("injected rollback"); } });
  const preview = await service.preview(snapshot());
  await assert.rejects(service.apply("rollback", preview.token), /injected rollback/);
  assert.equal(store.all("SELECT * FROM scripts").length, 0);
  assert.equal(store.all("SELECT * FROM script_versions").length, 0);
  assert.equal(store.all("SELECT * FROM command_receipts WHERE scope='config-git:restore'").length, 0);
  assert.equal(service.operations()[0]!.phase, "failed");
  assert.equal(service.getGeneralTheme(), undefined);
});

test("coordinator preserves synchronous returns and nested ownership, denies unrelated work", async () => {
  const coordinator = new ConfigWriteCoordinator();
  assert.equal(coordinator.withWrite(() => coordinator.withWrite(() => 42)), 42);
  assert.equal(coordinator.generation, 1);
  let release!: () => void;
  const pending = coordinator.withWrite(async () => { await new Promise<void>(resolve => { release = resolve; }); return coordinator.withWrite(() => 7); });
  assert.throws(() => coordinator.withWrite(() => 0), { code: "CONFIG_BUSY" });
  release(); assert.equal(await pending, 7);
  const end = coordinator.beginActivity("test");
  assert.throws(() => coordinator.withExclusive(() => undefined), { code: "CONFIG_BUSY" }); end();
  coordinator.setMaintenance("recovery");
  assert.equal(coordinator.withExclusive(() => coordinator.withWrite(() => coordinator.withWrite(() => 3)), true), 3);
  assert.throws(() => coordinator.withRead(() => 0), { code: "RECOVERY_REQUIRED" });
});

test("preview expires on direct database changes and persisted queued work blocks apply", async t => {
  const { store, service } = setup(t);
  const preview = await service.preview(snapshot());
  store.exec("INSERT INTO scripts(id,name,description,runtime,status,created_at,updated_at) VALUES('other','Other','','shell','draft',1,1)");
  await assert.rejects(service.apply("stale", preview.token), { code: "PREVIEW_EXPIRED" });
  const next = await service.preview(snapshot());
  store.exec("INSERT INTO script_tests(id,script_id,draft_revision,status,input_ref,created_at) VALUES('queued','other',0,'queued','{}',1)");
  await assert.rejects(service.apply("busy", next.token), { code: "CONFIG_BUSY" });
});

test("file recovery stays in maintenance when staged content is corrupt and retries forward", async t => {
  const { store, root } = setup(t);
  const service = new ConfigRestoreService(store, configCoordinator(store), { fault(phase) { if (phase === "database_committed_before_journal") throw new Error("crash window"); } });
  await assert.rejects(service.apply("recover", (await service.preview(snapshot())).token), /crash window/);
  assert.equal(store.scriptVersion("v-fixed").id, "v-fixed");
  const operation = service.operations()[0]!, staged = join(root, operation.files[0]!.staged), original = readFileSync(staged, "utf8");
  writeFileSync(staged, "corrupt");
  const restarted = new ConfigRestoreService(store);
  await assert.rejects(restarted.recover(), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => configCoordinator(store).beginActivity("run"), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => restarted.deleteRecoveryPoint(operation.recoveryPointId), { code: "RECOVERY_REQUIRED" });
  writeFileSync(staged, original);
  await restarted.recover();
  assert.equal(restarted.operation(operation.operationId).phase, "completed");
  assert.equal(restarted.getGeneralTheme(), "dark");
  assert.equal(configCoordinator(store).maintenance, null);
  assert.equal(store.all("SELECT * FROM command_receipts WHERE scope='config-git:restore'").length, 1);
});

test("browser delivery survives disconnect, enforces client identity and revision, idempotent ack", async t => {
  const { service } = setup(t), preview = await service.preview(snapshot(), { categories: ["general"], clientId: "browser-a", preferenceRevision: 4 });
  const operation = await service.apply("general", preview.token);
  assert.equal(service.pendingGeneral("browser-b").length, 0);
  assert.equal(service.pendingGeneral("browser-a").length, 1);
  assert.throws(() => service.acknowledgeGeneral("browser-a", operation.operationId, 5, "applied"), { code: "PREFERENCE_CONFLICT" });
  service.acknowledgeGeneral("browser-a", operation.operationId, 5, "kept");
  assert.equal(service.acknowledgeGeneral("browser-a", operation.operationId, 5, "applied").acknowledged, "kept");
  assert.equal(service.pendingGeneral("browser-a").length, 0);
  const claimed = service.claimGeneralSnapshot("new-browser", 0);
  assert.equal(claimed.requiresConfirmation, true);
  assert.equal(service.pendingGeneral("new-browser")[0]!.requiresConfirmation, true);
  assert.throws(() => service.acknowledgeGeneral("new-browser", claimed.operationId, 0, "applied"), { code: "PREFERENCE_CONFLICT" });
  service.acknowledgeGeneral("new-browser", claimed.operationId, 0, "applied", true);
});

test("provider hidden models merge, local mappings required, unchanged revision preserved", async t => {
  const { store, service } = setup(t), source = snapshot();
  source.providers = [{ id: "pi-cli", enabled: true, config: { executable: localReference("providers", "pi-cli", "executable"), transport: "legacy" }, defaultModel: "visible", models: [{ id: "visible", name: "Visible", source: "configured", enabled: true, deleted: false }, { id: "hidden", name: "Hidden", source: "configured", enabled: false, deleted: true }] }];
  await assert.rejects(service.preview(source, { categories: ["providers"] }), { code: "LOCAL_MAPPING_REQUIRED" });
  const preview = await service.preview(source, { categories: ["providers"], mappings: { [source.providers[0]!.config.executable.localRef]: "/usr/bin/pi" } });
  await service.apply("provider", preview.token);
  assert.equal(store.provider("pi-cli")!.models.find(item => item.id === "hidden")!.deleted, true);
  await service.apply("provider-2", (await service.preview(source, { categories: ["providers"] })).token);
  assert.equal(store.provider("pi-cli")!.revision, 1);
});

for (const boundary of ["accepted", "prepared", "transaction", "database_committed_before_journal", "before_file:config/web-bridge.json", "after_file:config/web-bridge.json", "before_file:config-git/general.json", "after_file:config-git/general.json", "before_completed"]) test(`SIGKILL restart at ${boundary} restores complete old or new state`, async t => {
  const root = temporary(t), initial = new TestStore(root); initial.close();
  const fixture = join(root, "snapshot.json"); writeFileSync(fixture, JSON.stringify(snapshot()));
  const childCode = `import {readFileSync} from 'node:fs'; import {TestStore} from './tests/helpers.ts'; import {ConfigRestoreService} from './src/config-git/restore.ts'; import {configCoordinator} from './src/config-git/coordinator.ts'; const store=new TestStore(process.argv[1]); const service=new ConfigRestoreService(store,configCoordinator(store),{fault(phase){if(phase===process.argv[2])process.kill(process.pid,'SIGKILL')}}); const preview=await service.preview(JSON.parse(readFileSync(process.argv[1]+'/snapshot.json','utf8'))); await service.apply('killed',preview.token);`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode, root, boundary], { cwd: process.cwd(), encoding: "utf8", timeout: 30000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  // Stale lease is reclaimed by the existing DirectoryLease protocol.
  const lease = DirectoryLease.acquire(root), store = new Store(root, lease); t.after(() => { store.close(); if (existsSync(join(root, "workbench.lock"))) lease.release(); });
  const service = new ConfigRestoreService(store); await service.recover(); store.recoverBusiness();
  const committed = !["accepted", "prepared", "transaction"].includes(boundary);
  assert.equal(!!store.one("SELECT id FROM scripts WHERE id='sample'"), committed);
  assert.equal(service.getGeneralTheme(), committed ? "dark" : undefined);
  assert.equal(service.operations()[0]!.phase, committed ? "completed" : "failed");
  assert.equal(store.all("SELECT * FROM command_receipts WHERE scope='config-git:restore'").length, committed ? 1 : 0);
});

function workflowFiles(id = "flow") {
  return { "workflow.json": JSON.stringify({ formatVersion: 1, id, name: "Flow", inputSchema: true, outputSchema: true, entryNodeId: "step", nodes: [{ id: "step", name: "Step", type: "script", input: { source: "workflow" }, outputSchema: true, config: { scriptId: "sample", scriptVersionId: "v-fixed" } }], edges: [], result: { source: "node", nodeId: "step" } }), "layout.json": "{}" };
}
test("workflow dependency expansion preserves fixed references, baseline and unpublished drafts", async t => {
  const { store, service } = setup(t), source = snapshot();
  source.scripts[0]!.archived = true;
  source.workflows = [{ id: "flow", name: "Flow", currentPublishedVersionId: "wf-fixed", versions: [{ id: "wf-fixed", files: workflowFiles() }], draft: { files: workflowFiles(), baseVersionId: "wf-fixed" } }, { id: "unpublished", name: "Unpublished", currentPublishedVersionId: null, versions: [], draft: { files: workflowFiles("unpublished"), baseVersionId: null } }];
  const preview = await service.preview(source, { categories: ["workflows"] });
  assert.deepEqual(preview.categories, ["scripts", "workflows"]);
  await service.apply("workflows", preview.token);
  assert.equal(store.script("sample").status, "archived");
  assert.equal(store.one("SELECT workflow_id FROM workflow_versions WHERE id='wf-fixed'")!.workflow_id, "flow");
  assert.equal(store.one("SELECT base_version_id FROM drafts WHERE workflow_id='flow'")!.base_version_id, "wf-fixed");
  assert.equal(store.one("SELECT COUNT(*) n FROM drafts WHERE workflow_id IS NULL")!.n, 1);
  const next = await service.preview(source, { categories: ["workflows"] });
  assert(next.changes.every(item => item.changeType === "same"));
  await service.apply("workflows-2", next.token);
  assert(store.all("SELECT revision FROM drafts").every(row => row.revision === 0));
  const noDraft = structuredClone(source); noDraft.workflows[0]!.draft = null; noDraft.workflows[0]!.currentPublishedVersionId = null;
  await service.apply("preserve", (await service.preview(noDraft, { categories: ["workflows"] })).token);
  assert.equal(store.one("SELECT current_version_id FROM workflows WHERE id='flow'")!.current_version_id, "wf-fixed");
  assert.equal(store.all("SELECT id FROM drafts").length, 2);
});

test("draft source files must exist even when other draft business validation fails", async t => {
  const { service } = setup(t), source = snapshot();
  const files = workflowFiles(), definition = JSON.parse(files["workflow.json"]);
  definition.nodes[0].type = "code.nodejs"; definition.nodes[0].config = { script: "scripts/missing.ts" };
  files["workflow.json"] = JSON.stringify(definition);
  source.workflows = [{ id: "flow", name: "Flow", currentPublishedVersionId: null, versions: [], draft: { files, baseVersionId: null } }];
  await assert.rejects(service.preview(source, { categories: ["workflows"] }), { code: "INVALID_FILES" });
});

test("recovery point contains independent draft sources after unreferenced artifact cleanup", async t => {
  const { store, root, service } = setup(t), source = snapshot();
  await service.apply("initial", (await service.preview(source)).token);
  const draft = store.scriptVersion(store.script("sample").currentDraftVersionId!), oldPath = draft.sourceRef;
  const edited = structuredClone(source); edited.scripts[0]!.draft!.files["main.ts"] = "export default () => 12;";
  const applied = await service.apply("edited", (await service.preview(edited)).token);
  // The published version uses the same initial content; retain it, remove only a
  // draft-only tree by creating a third state and removing the second draft tree.
  const secondPath = store.scriptVersion(draft.id).sourceRef;
  const third = structuredClone(source); third.scripts[0]!.draft!.files["main.ts"] = "export default () => 13;";
  const thirdResult = await service.apply("third", (await service.preview(third)).token);
  assert.notEqual(oldPath, secondPath);
  rmSync(join(root, secondPath), { force: true });
  await service.apply("from-point", (await service.previewRecoveryPoint(thirdResult.recoveryPointId)).token);
  assert.equal(store.files.readScriptTree(store.scriptVersion(draft.id).sourceRef).files["main.ts"], "export default () => 12;");
  assert.equal(store.scriptVersion(draft.id).revision, 3);
  service.deleteRecoveryPoint(applied.recoveryPointId);
  assert(!service.recoveryPoints().some(item => item.id === applied.recoveryPointId));
});
