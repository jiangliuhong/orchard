import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { setup, prepareMaintenanceFixture, exampleFiles } from "./helpers.js";
import { workflowRepairModelContext } from "../src/agent/maintenance-production.js";
import { MaintenanceAssets } from "../src/agent/maintenance-assets.js";
import { MaintenanceService, type MaintenanceBoundary } from "../src/agent/maintenance-service.js";
import { MAINTENANCE_CONTRACT, type MaintenanceTarget } from "../src/agent/maintenance-protocol.js";
import { canonicalJson, digest } from "../src/persistence/files.js";
import { DatabaseBridgeConfiguration, bridgeDeclaration } from "../src/web-bridge/database-config.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { configCoordinator } from "../src/config-git/coordinator.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { AppError } from "../src/domain/errors.js";
import Fastify from "fastify";
import { MaintenanceToolGateway, MaintenanceMcpConnection } from "../src/agent/maintenance-tools.js";
import { registerMaintenanceRoutes } from "../src/agent/maintenance-routes.js";
import { MaintenanceApplyWorker } from "../src/agent/maintenance-worker.js";

const H = "a".repeat(64), K = "b".repeat(64), signal = () => new AbortController().signal;
async function fixture(t: TestContext, kind: "workflow" | "script" | "browser" = "workflow", legacyWorkflow = false) {
  const { store, authoring, providers } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, "maintenance-draft");
  const initial = store.files.readTree(draft.artifactPath).files, resourceId = JSON.parse(initial["workflow.json"]!).id;
  const source = legacyWorkflow ? exampleFiles(resourceId) : initial;
  if (legacyWorkflow) {
    const workflow = JSON.parse(source["workflow.json"]!);
    delete workflow.defaults;
    Object.assign(workflow.nodes[1].config, { providerId: "test-provider", modelId: "test-model" });
    source["workflow.json"] = JSON.stringify(workflow);
    store.exec("UPDATE drafts SET artifact_path=? WHERE id=?", store.files.saveTree(source).path, draft.id);
  }
  const library = new ScriptLibrary(store);
  if (kind === "script") await library.create({ id: "sample", name: "Sample", description: "", runtime: "nodejs", entryFile: "main.ts", files: { "main.ts": "export default async () => 1;" }, inputSchema: true, outputSchema: true });
  prepareMaintenanceFixture(store);
  const rawBridge = readFileSync(store.files.path("config/web-bridge.json"), "utf8"), declaration = bridgeDeclaration(rawBridge);
  store.exec("INSERT INTO bridge_configuration VALUES('current',1,?,?,?)", declaration, digest(declaration), Date.now());
  store.exec("INSERT INTO agent_workspace_workflow_bindings VALUES(?,?,?)", draft.id, resourceId, Date.now());
  store.exec("INSERT INTO agent_workspace_projection_state VALUES('maintenance',1,1,?,?,?,'ready',NULL,?)", K, K, H, Date.now());
  const bridge = new WebBridgeConfig(store.root, configCoordinator(store), new DatabaseBridgeConfiguration(store));
  if (kind === "browser") {
    bridge.saveApplication({ id: "crm", name: "CRM" });
    store.exec("UPDATE agent_workspace_projection_state SET synced_generation=target_generation,state='ready'");
  }
  const target: MaintenanceTarget = kind === "workflow" ? { kind: "workflow_draft", id: resourceId, scope: { draftId: draft.id } }
    : kind === "script" ? { kind: "script_draft", id: "sample", scope: { draftVersionId: store.script("sample").currentDraftVersionId } }
      : { kind: "browser_application", id: "crm", scope: {} };
  const assets = new MaintenanceAssets(store, bridge, () => providers), snapshot = assets.capture(target);
  const scenario = kind === "workflow" ? "workflow" : kind === "script" ? "script" : "web-bridge";
  store.exec("INSERT INTO agent_maintenance_sessions(id,actor_key,scenario,owner_kind,owner_id,owner_scope_json,mode,provider_id,model_id,contract_version,tool_policy_version,knowledge_hash,generation,revision,lifecycle,native_delete_state,created_at,updated_at) VALUES('session','local',?,?,?,?,'single','test-provider','test-model',?,'readonly',?,1,1,'active','absent',?,?)", scenario, target.kind, target.id, canonicalJson(target.scope), MAINTENANCE_CONTRACT, K, Date.now(), Date.now());
  const generation = store.one<{ target_generation: number }>("SELECT target_generation FROM agent_workspace_projection_state")!.target_generation;
  store.exec("INSERT INTO agent_maintenance_tasks(id,session_id,mode,request_id,request_hash,sequence,generation,projection_generation,projection_hash,baseline_json,status,process_state,created_at) VALUES('task','session','single','turn',?,1,1,?,?,?,'running','running',?)", H, generation, H, canonicalJson(snapshot.baseline), Date.now());
  let clock = Date.now(), syncFails = false, quiescent = true, deny = false, syncCalls = 0;
  const boundary: MaintenanceBoundary = {
    authorize(actor) { if (actor !== "local" || deny) throw new AppError("FORBIDDEN", "denied", 403); }, knownSecrets: () => [],
    assertQuiescent() { if (!quiescent) throw new AppError("PROCESS_STOP_UNCONFIRMED", "not stopped", 409); },
    async synchronize() { syncCalls++; if (syncFails) throw new Error("filesystem failed"); store.exec("UPDATE agent_workspace_projection_state SET synced_generation=target_generation,synced_knowledge_hash=target_knowledge_hash,state='ready',content_hash=?", H); },
  };
  const service = new MaintenanceService(store, assets, boundary, () => clock);
  const workflow = JSON.parse(source["workflow.json"]!); workflow.name = "Proposed name";
  const change = kind === "workflow" ? { operation: "replace", files: { ...source, "workflow.json": JSON.stringify(workflow) } }
    : kind === "script" ? { operation: "replace", definition: { ...store.scriptDefinition("sample", store.script("sample").currentDraftVersionId!), name: "Updated", files: { "main.ts": "export default async () => 2;" } } }
      : { operation: "tools", changes: [{ operation: "create", toolId: "read", definition: { application: "crm", toolId: "read", site: "crm", description: "Read", path: "/api/read", method: "GET", parameters: { type: "object" }, fields: [], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", enabled: true } }] };
  const input = { contractVersion: MAINTENANCE_CONTRACT, requestId: "submit", summary: "Exact proposed change", target, baseline: snapshot.baseline, change };
  const finish = () => store.exec("UPDATE agent_maintenance_tasks SET status='succeeded',process_state='stopped',ended_at=? WHERE id='task'", clock);
  return { store, authoring, providers, draft, bridge, assets, target, input, service, boundary, finish,
    syncFail(value: boolean) { syncFails = value; }, stopped(value: boolean) { quiescent = value; }, deny(value: boolean) { deny = value; }, tick(ms: number) { clock += ms; }, get syncCalls() { return syncCalls; } };
}
function confirm(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const view = f.service.view("local", id);
  return f.service.decideByUser("local", id, "confirm", view.contentHash, view.diffHash, "confirm");
}

test("legacy workflow model configuration can be repaired through a reviewed proposal", async t => {
  const f = await fixture(t, "workflow", true);
  f.providers.modelConfigs.create({ name: "Disabled", providerId: "test-provider", modelId: "test-model", enabled: false, requestId: "disabled-config" });
  const context = workflowRepairModelContext(f.providers, []);
  assert.match(context.join("\n"), /agentConfigId/);
  const metadata = context.at(-1)!;
  const choices = JSON.parse(metadata!.slice(metadata!.indexOf("[")));
  assert.equal(choices.length, 1);
  assert.equal(choices[0].id, "test-agent-config");
  assert.equal(choices[0].modelId, "test-model");

  const files = { ...f.input.change.files };
  const workflow = JSON.parse(files["workflow.json"]!);
  const { providerId, modelId, ...config } = workflow.nodes[1].config;
  assert.equal(providerId, choices[0].providerId);
  assert.equal(modelId, choices[0].modelId);
  workflow.nodes[1].config = { ...config, agentConfigId: "missing" };
  files["workflow.json"] = JSON.stringify(workflow);
  const input = { ...f.input, change: { operation: "replace", files } };
  await assert.rejects(f.service.submit("local", "session", "task", input, signal()), { code: "NOT_FOUND" });
  workflow.nodes[1].config.agentConfigId = choices[0].id;
  files["workflow.json"] = JSON.stringify(workflow);
  const proposal = await f.service.submit("local", "session", "task", input, signal());
  assert.equal(f.store.draft(f.draft.id).revision, 0);
  confirm(f, proposal.id);
  const queued = f.service.enqueue("local", proposal.id, "apply-repair");
  f.finish();
  assert.equal((await f.service.process("local", queued.id, signal())).status, "applied");
  const repaired = f.store.files.readTree(f.store.draft(f.draft.id).artifactPath).files;
  assert.deepEqual(JSON.parse(repaired["workflow.json"]!).nodes[1].config, { ...config, agentConfigId: choices[0].id });
});

test("retention requires a current preview and preserves application replay after deleting audit rows", async t => {
  const f = await fixture(t);
  const proposal = await f.service.submit("local", "session", "task", f.input, signal());
  confirm(f, proposal.id);
  const queued = f.service.enqueue("local", proposal.id, "retain-apply");
  assert.throws(() => f.service.applyRetention("local", f.service.previewRetention("local").hash), { code: "WORKSPACE_BUSY" });
  f.store.exec("UPDATE agent_maintenance_tasks SET display_output_ref=? WHERE id='task'", canonicalJson({ text: "display" }));
  f.finish();
  const applied = await f.service.process("local", queued.id, signal());
  assert.equal(applied.status, "applied");
  const early = f.service.previewRetention("local");
  assert.equal(early.proposals, 0);
  f.tick(100 * 24 * 60 * 60 * 1000);
  const preview = f.service.previewRetention("local");
  assert.equal(preview.proposals, 1);
  assert.equal(preview.applications, 1);
  assert.equal(preview.displays, 1);
  assert.throws(() => f.service.applyRetention("local", early.hash), { code: "PREVIEW_EXPIRED" });
  assert.deepEqual(f.service.applyRetention("local", preview.hash), preview);
  assert.equal(f.service.previewRetention("local").proposals, 0);
  assert.equal(f.store.one("SELECT display_output_ref FROM agent_maintenance_tasks WHERE id='task'")?.display_output_ref, null);
  assert.deepEqual(f.service.receipt("local", queued.id), applied);
  assert.deepEqual(f.service.enqueue("local", proposal.id, "retain-apply"), applied);
  assert.throws(() => f.service.enqueue("local", "another-proposal", "retain-apply"), { code: "REQUEST_CONFLICT" });
});

test("workflow proposals are immutable and queued until process stop; confirmed exact content applies once", async t => {
  const f = await fixture(t), before = f.store.draft(f.draft.id);
  const proposal = await f.service.submit("local", "session", "task", f.input, signal());
  assert.equal(f.store.draft(f.draft.id).revision, before.revision);
  assert.equal(proposal.diff.after.files["workflow.json"].includes("Proposed name"), true);
  assert.deepEqual(await f.service.submit("local", "session", "task", f.input, signal()), proposal);
  await assert.rejects(f.service.submit("local", "session", "task", { ...f.input, summary: "different" }, signal()), { code: "REQUEST_CONFLICT" });
  assert.throws(() => f.service.enqueue("local", proposal.id, "apply"), { code: "CONFIRMATION_REQUIRED" });
  confirm(f, proposal.id);
  const queued = f.service.enqueue("local", proposal.id, "apply"); assert.equal(queued.status, "queued");
  assert.equal((await f.service.process("local", queued.id, signal())).status, "queued");
  f.finish(); f.stopped(false);
  assert.equal((await f.service.process("local", queued.id, signal())).errorCode, "PROCESS_STOP_UNCONFIRMED");
  assert.equal(f.store.draft(f.draft.id).revision, before.revision);
  f.stopped(true);
  const applied = await f.service.process("local", queued.id, signal()); assert.equal(applied.status, "applied");
  assert.equal(f.store.draft(f.draft.id).revision, before.revision + 1);
  assert.deepEqual(await f.service.process("local", queued.id, signal()), applied);
  assert.deepEqual(f.service.enqueue("local", proposal.id, "apply"), applied);
  assert.equal(f.store.draft(f.draft.id).revision, before.revision + 1);
  assert.equal(f.store.versions(f.target.id).length, 0); // Apply is not publish.
});

test("confirmed script proposal updates only the fixed draft and does not publish or execute source", async t => {
  const f = await fixture(t, "script"), old = f.store.script("sample");
  const p = await f.service.submit("local", "session", "task", f.input, signal()); confirm(f, p.id);
  const request = f.service.enqueue("local", p.id, "script-apply"); f.finish();
  assert.equal((await f.service.process("local", request.id, signal())).status, "applied");
  const script = f.store.script("sample"); assert.equal(script.currentDraftVersionId, old.currentDraftVersionId);
  assert.equal(script.currentPublishedVersionId, null); assert.equal(f.store.scriptDefinition("sample", script.currentDraftVersionId!).files["main.ts"], "export default async () => 2;");
  assert.equal(f.store.all("SELECT id FROM script_tests").length, 0);
});

test("browser proposal writes DB configuration and dirty registration atomically, never legacy JSON", async t => {
  const f = await fixture(t, "browser"), oldFile = readFileSync(f.store.files.path("config/web-bridge.json"), "utf8");
  const p = await f.service.submit("local", "session", "task", f.input, signal()); confirm(f, p.id);
  const request = f.service.enqueue("local", p.id, "browser-apply"); f.finish();
  assert.equal((await f.service.process("local", request.id, signal())).status, "applied");
  assert.equal(f.bridge.tools("crm").length, 1); assert.ok(f.bridge.databaseRevision! > 1);
  assert.equal(readFileSync(f.store.files.path("config/web-bridge.json"), "utf8"), oldFile);
});

test("DB commit followed by sync failure remains applied-pending and retry never repeats resource mutation", async t => {
  const f = await fixture(t), p = await f.service.submit("local", "session", "task", f.input, signal()); confirm(f, p.id);
  const request = f.service.enqueue("local", p.id, "apply"); f.finish(); f.syncFail(true);
  const result = await f.service.process("local", request.id, signal()); assert.equal(result.status, "applied_projection_pending");
  const revision = f.store.draft(f.draft.id).revision;
  assert.equal((await f.service.process("local", request.id, signal())).status, "applied_projection_pending");
  assert.equal(f.store.draft(f.draft.id).revision, revision);
  f.syncFail(false); await f.boundary.synchronize(signal());
  assert.equal(f.service.receipt("local", request.id).status, "applied");
});

test("page revision conflict and revoked/expired confirmations cannot overwrite resources", async t => {
  for (const condition of ["conflict", "revoked", "expired", "deleted"] as const) await t.test(condition, async t => {
    const f = await fixture(t), p = await f.service.submit("local", "session", "task", f.input, signal()); confirm(f, p.id);
    const request = f.service.enqueue("local", p.id, "apply"); f.finish();
    if (condition === "conflict") f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id);
    if (condition === "revoked") f.service.decideByUser("local", p.id, "revoke", p.contentHash, p.diffHash, "revoke");
    if (condition === "expired") f.tick(86400001);
    if (condition === "deleted") f.authoring.deleteDraft(f.draft.id);
    const before = f.store.one("SELECT revision FROM drafts WHERE id=?", f.draft.id);
    const result = await f.service.process("local", request.id, signal());
    assert.equal(result.status, ["conflict", "deleted"].includes(condition) ? "conflicted" : "rejected");
    assert.deepEqual(f.store.one("SELECT revision FROM drafts WHERE id=?", f.draft.id), before);
  });
});

test("forged confirmation hashes, extra fields, cross-owner and lost permissions are denied", async t => {
  const f = await fixture(t), p = await f.service.submit("local", "session", "task", f.input, signal());
  assert.throws(() => f.service.decideByUser("local", p.id, "confirm", H, H, "forged"), { code: "PROPOSAL_CHANGED" });
  assert.throws(() => f.service.view("other", p.id), { code: "NOT_FOUND" });
  await assert.rejects(f.service.submit("local", "session", "task", { ...f.input, requestId: "forged", confirmed: true }, signal()), { code: "SCHEMA_MISMATCH" });
  await assert.rejects(f.service.submit("local", "session", "task", { ...f.input, requestId: "wrong-owner", target: { ...f.target, id: "other" } }, signal()), { code: "PROPOSAL_TARGET_MISMATCH" });
  confirm(f, p.id); const request = f.service.enqueue("local", p.id, "apply"); f.finish(); f.deny(true);
  await assert.rejects(f.service.process("local", request.id, signal()), { code: "FORBIDDEN" });
  assert.equal(f.store.draft(f.draft.id).revision, 0);
  assert.equal(f.store.one<{ state: string }>("SELECT state FROM agent_maintenance_apply_requests WHERE id=?", request.id)!.state, "rejected");
});

test("controlled tools bind actor/session/task/generation, omit confirmation methods and enqueue without self-wait", async t => {
  const f = await fixture(t), gateway = new MaintenanceToolGateway(f.store, f.service);
  const grant = gateway.issue({ actor: "local", sessionId: "session", taskId: "task", signal: signal() });
  assert.deepEqual(gateway.tools(grant.token).map(tool => tool.name), ["submit_proposal", "apply_proposal", "proposal_status"]);
  await assert.rejects(gateway.call(grant.token, "confirm_proposal", {}), { code: "TOOL_DENIED" });
  const submitted = await gateway.call(grant.token, "submit_proposal", f.input) as { proposalId: string };
  assert.equal(JSON.stringify(submitted).includes(grant.token), false);
  await assert.rejects(gateway.call(grant.token, "apply_proposal", { proposalId: submitted.proposalId, requestId: "apply" }), { code: "CONFIRMATION_REQUIRED" });
  confirm(f, submitted.proposalId);
  const queued = await gateway.call(grant.token, "apply_proposal", { proposalId: submitted.proposalId, requestId: "apply" }) as { status: string };
  assert.equal(queued.status, "queued"); assert.equal(f.store.draft(f.draft.id).revision, 0);
  f.finish();
  await assert.rejects(gateway.call(grant.token, "proposal_status", { proposalId: submitted.proposalId }), { code: "TOOL_AUTHORIZATION_REVOKED" });
});

test("tool grants expire, abort and revoke, and cannot survive session/projection generation changes", async t => {
  const f = await fixture(t); let now = Date.now();
  const gateway = new MaintenanceToolGateway(f.store, f.service, () => now);
  const expired = gateway.issue({ actor: "local", sessionId: "session", taskId: "task", signal: signal(), ttlMs: 10 }); now += 11;
  assert.throws(() => gateway.tools(expired.token), { code: "TOOL_AUTHORIZATION_REVOKED" });
  const controller = new AbortController(), aborted = gateway.issue({ actor: "local", sessionId: "session", taskId: "task", signal: controller.signal }); controller.abort();
  assert.throws(() => gateway.tools(aborted.token), { code: "TOOL_AUTHORIZATION_REVOKED" });
  const revoked = gateway.issue({ actor: "local", sessionId: "session", taskId: "task", signal: signal() }); revoked.revoke();
  assert.throws(() => gateway.tools(revoked.token), { code: "TOOL_AUTHORIZATION_REVOKED" });
  const oldGeneration = gateway.issue({ actor: "local", sessionId: "session", taskId: "task", signal: signal() });
  f.store.exec("UPDATE agent_maintenance_sessions SET generation=generation+1 WHERE id='session'");
  assert.throws(() => gateway.tools(oldGeneration.token), { code: "TOOL_AUTHORIZATION_REVOKED" });
  assert.throws(() => gateway.issue({ actor: "other", sessionId: "session", taskId: "task", signal: signal() }), { code: "TOOL_AUTHORIZATION_REVOKED" });
});

test("MCP protocol uses the out-of-band capability, has no SQL/file/confirm escape and sanitizes tool errors", async t => {
  const f = await fixture(t), gateway = new MaintenanceToolGateway(f.store, f.service), grant = gateway.issue({ actor: "local", sessionId: "session", taskId: "task", signal: signal() });
  const connection = new MaintenanceMcpConnection(gateway, grant.token);
  const call = (id: number, method: string, params?: unknown) => connection.handle({ jsonrpc: "2.0", id, method, params }) as Promise<{ result?: { isError?: boolean; protocolVersion?: string }; error?: { code: number } }>;
  assert.ok((await call(1, "tools/list")).error);
  assert.equal((await call(2, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "1" }, capabilities: {} })).result?.protocolVersion, "2025-06-18");
  for (const name of ["sql", "read_file", "write", "confirm_proposal"]) assert.equal((await call(3, "tools/call", { name, arguments: {} })).result?.isError, true);
  assert.equal((await call(4, "resources/read", { uri: "file:///etc/passwd" })).error?.code, -32601);
  const result = await call(5, "tools/call", { name: "submit_proposal", arguments: f.input }); assert.equal(result.result?.isError, false);
  assert.equal(JSON.stringify(result).includes(grant.token), false);
  grant.revoke(); assert.ok((await call(6, "tools/list")).error);
});

test("user HTTP decision boundary is independent of Agent grants, strict and idempotent, with no model relaunch", async t => {
  const f = await fixture(t), proposal = await f.service.submit("local", "session", "task", f.input, signal());
  const app = Fastify(); t.after(() => app.close());
  app.setErrorHandler((error, _request, reply) => { const known = error instanceof AppError; reply.code(known ? error.statusCode : 500).send({ code: known ? error.code : "INTERNAL_ERROR" }); });
  const scheduled: string[] = [];
  registerMaintenanceRoutes(app, { service: f.service,
    authorizeUserRequest(request) { if (request.headers["x-ui-auth"] !== "page") throw new AppError("UNAUTHORIZED", "page identity required", 403); return "local"; },
    schedule(_actor, id) { scheduled.push(id); },
  });
  const url = `/api/maintenance/proposals/${proposal.id}`, decision = { action: "confirm", contentHash: proposal.contentHash, diffHash: proposal.diffHash, requestId: "user-confirm" };
  assert.equal((await app.inject({ method: "POST", url: url + "/decision", payload: decision })).statusCode, 403);
  const headers = { "x-ui-auth": "page" };
  assert.equal((await app.inject({ method: "POST", url: url + "/decision", headers, payload: { ...decision, confirmed: true } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: url + "/decision", headers, payload: decision })).statusCode, 200);
  const applied = await app.inject({ method: "POST", url: url + "/apply", headers, payload: { requestId: "page-apply" } });
  assert.equal(applied.statusCode, 202); assert.equal(scheduled.length, 1); assert.equal(f.store.draft(f.draft.id).revision, 0);
  f.finish(); await f.service.process("local", scheduled[0]!, signal());
  const replay = await app.inject({ method: "POST", url: url + "/apply", headers, payload: { requestId: "page-apply" } });
  assert.equal(replay.statusCode, 200); assert.equal(replay.json().status, "applied"); assert.equal(scheduled.length, 1);
});

test("browser DB backend rejects stale writers and excludes runtime flags from revision, hash and persistence", async t => {
  const f = await fixture(t, "browser"); f.finish();
  const other = new WebBridgeConfig(f.store.root, configCoordinator(f.store), new DatabaseBridgeConfiguration(f.store));
  const original = readFileSync(f.store.files.path("config/web-bridge.json"), "utf8");
  f.bridge.saveApplication({ id: "new-app", name: "Current writer" });
  assert.throws(() => other.saveApplication({ id: "stale-app", name: "Stale writer" }), { code: "REVISION_CONFLICT" });
  assert.equal(other.application("stale-app"), undefined); assert.ok(other.application("new-app"));
  const environment = f.bridge.saveEnvironment("crm", { origin: "https://example.com", enabled: true, profileId: "LOCAL_PROFILE" });
  const revision = f.bridge.databaseRevision, hash = f.bridge.authoringSnapshot("crm").hash;
  const generation = f.store.one("SELECT target_generation FROM agent_workspace_projection_state");
  f.bridge.saveEnvironment("crm", { ...environment, bound: true, tabAvailable: true });
  assert.equal(f.bridge.databaseRevision, revision); assert.equal(f.bridge.authoringSnapshot("crm").hash, hash);
  assert.deepEqual(f.store.one("SELECT target_generation FROM agent_workspace_projection_state"), generation);
  const declaration = f.store.one<{ config_json: string }>("SELECT config_json FROM bridge_configuration")!.config_json;
  assert.equal(declaration.includes("tabAvailable"), false); assert.equal(declaration.includes('"bound"'), false);
  assert.equal(readFileSync(f.store.files.path("config/web-bridge.json"), "utf8"), original);
});

test("browser cache is refreshed after an outer business transaction rollback", async t => {
  const f = await fixture(t, "browser"), p = await f.service.submit("local", "session", "task", f.input, signal()); confirm(f, p.id);
  const request = f.service.enqueue("local", p.id, "apply"); f.finish();
  const revision = f.bridge.databaseRevision, prepare = f.assets.prepare.bind(f.assets);
  f.assets.prepare = async (...args) => { const prepared = await prepare(...args); return { ...prepared, commit() { prepared.commit(); throw new Error("after nested DB write"); } }; };
  assert.equal((await f.service.process("local", request.id, signal())).status, "queued");
  assert.equal(f.bridge.databaseRevision, revision); assert.equal(f.bridge.tools("crm").length, 0);
});

test("DB-backed application worker waits for task exit and never launches a second model for single confirmation", async t => {
  const f = await fixture(t), p = await f.service.submit("local", "session", "task", f.input, signal()); confirm(f, p.id);
  const request = f.service.enqueue("local", p.id, "apply"), worker = new MaintenanceApplyWorker(f.store, f.service);
  try {
    worker.wake(); await worker.idle(); assert.equal(f.service.receipt("local", request.id).status, "queued");
    f.finish(); worker.wake(); worker.wake(); await worker.idle();
    assert.equal(f.service.receipt("local", request.id).status, "applied"); assert.equal(f.store.draft(f.draft.id).revision, 1);
  } finally { await worker.close(); }
});

test("sensitive source and host paths are rejected before preparing or writing any candidate artifact", async t => {
  const f = await fixture(t), prepare = f.assets.prepare.bind(f.assets); let preparations = 0;
  f.assets.prepare = async (...args) => { preparations++; return prepare(...args); };
  const files = f.store.files.readTree(f.draft.artifactPath).files;
  await assert.rejects(f.service.submit("local", "session", "task", { ...f.input, requestId: "host-path", change: { operation: "replace", files: { ...files, "scripts/start.ts": `export default () => ${JSON.stringify(f.store.root)};` } } }, signal()), { code: "QUERY_SENSITIVE_CONTENT" });
  await assert.rejects(f.service.submit("local", "session", "task", { ...f.input, requestId: "credential", change: { operation: "replace", files: { ...files, "scripts/start.ts": 'const password = "embedded"; export default () => 1;' } } }, signal()), { code: "QUERY_SENSITIVE_CONTENT" });
  assert.equal(preparations, 0); assert.equal(f.store.all("SELECT id FROM agent_maintenance_proposals").length, 0);
});

test("candidate commit failure rolls back business, receipt and projection generation together", async t => {
  const f = await fixture(t), p = await f.service.submit("local", "session", "task", f.input, signal()); confirm(f, p.id);
  const request = f.service.enqueue("local", p.id, "apply"); f.finish();
  const prepare = f.assets.prepare.bind(f.assets);
  f.assets.prepare = async (...args) => { const candidate = await prepare(...args); return { ...candidate, commit() { candidate.commit(); throw new Error("injected transaction failure"); } }; };
  const before = f.store.one("SELECT target_generation FROM agent_workspace_projection_state");
  assert.equal((await f.service.process("local", request.id, signal())).status, "queued");
  assert.equal(f.store.draft(f.draft.id).revision, 0);
  assert.deepEqual(f.store.one("SELECT target_generation FROM agent_workspace_projection_state"), before);
});
