import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setup, until, prepareMaintenanceFixture } from "./helpers.js";
import { Store } from "../src/persistence/store.js";
import { DirectoryLease } from "../src/migrations/lock.js";
import { AppError } from "../src/domain/errors.js";
import { canonicalJson, digest } from "../src/persistence/files.js";
import { configCoordinator } from "../src/config-git/coordinator.js";
import { installWorkspaceBusinessTracking } from "../src/agent/workspace-business-hooks.js";
import { MaintenanceAssets } from "../src/agent/maintenance-assets.js";
import { MaintenanceService, type MaintenanceBoundary } from "../src/agent/maintenance-service.js";
import { MaintenanceApplyWorker } from "../src/agent/maintenance-worker.js";
import type { MaintenanceRuntimeFactory } from "../src/agent/maintenance-composition.js";
import { configuredWebBridge } from "../src/web-bridge/configured.js";
import { bridgeDeclaration } from "../src/web-bridge/database-config.js";
import { createApp } from "../src/server/app.js";
import { createProductionMaintenance } from "../src/agent/maintenance-production.js";
import { MaintenanceStopJournal } from "../src/agent/maintenance-stop-journal.js";
import { loadKnowledgeBundle } from "../src/agent/knowledge-bundle.js";

const H = "a".repeat(64), K = "b".repeat(64);
async function fixture(t: TestContext, tracked = true) {
  const f = setup(t); t.after(async () => { await f.authoring.close(); f.store.close(); });
  const draft = await f.authoring.create(undefined, "initial"), source = f.store.files.readTree(draft.artifactPath).files, id = JSON.parse(source["workflow.json"]!).id;
  prepareMaintenanceFixture(f.store);
  const declaration = bridgeDeclaration(readFileSync(f.store.files.path("config/web-bridge.json"), "utf8"));
  f.store.exec("INSERT INTO bridge_configuration VALUES('current',1,?,?,?)", declaration, digest(declaration), Date.now());
  f.store.exec("INSERT INTO agent_workspace_workflow_bindings VALUES(?,?,?)", draft.id, id, Date.now());
  f.store.exec("INSERT INTO agent_workspace_projection_state VALUES('maintenance',1,1,?,?,?,'ready',NULL,?)", K, K, H, Date.now());
  if (tracked) t.after(installWorkspaceBusinessTracking(f.store));
  // These are explicit unit-test authorities, NOT real process/CLI evidence.
  const state = { stopped: true, allowApply: true, syncCalls: 0, proofCalls: 0, closes: 0, failSync: false };
  const boundaryFor = (store: Store): MaintenanceBoundary => ({
    authorize(actor, _target, action) { if (actor !== "local" || action === "apply" && !state.allowApply) throw new AppError("FORBIDDEN", "denied", 403); },
    knownSecrets: () => [],
    assertQuiescent() { state.proofCalls++; if (!state.stopped) throw new AppError("PROCESS_STOP_UNCONFIRMED", "not stopped", 409); },
    async synchronize(signal) {
      signal.throwIfAborted(); state.syncCalls++; if (state.failSync) throw new Error("test sync failure");
      store.exec("UPDATE agent_workspace_projection_state SET synced_generation=target_generation,synced_knowledge_hash=target_knowledge_hash,state='ready',error_code=NULL,content_hash=?", H);
    },
  });
  const boundary = boundaryFor(f.store), bridge = configuredWebBridge(f.store), assets = new MaintenanceAssets(f.store, bridge), service = new MaintenanceService(f.store, assets, boundary);
  const target = { kind: "workflow_draft" as const, id, scope: { draftId: draft.id } };
  const proposal = async (request = "proposal") => {
    const baseline = assets.capture(target).baseline, now = Date.now();
    if (!f.store.one("SELECT id FROM agent_maintenance_sessions WHERE id='session'")) {
      f.store.exec("INSERT INTO agent_maintenance_sessions(id,actor_key,scenario,owner_kind,owner_id,owner_scope_json,mode,provider_id,model_id,contract_version,tool_policy_version,knowledge_hash,generation,revision,lifecycle,native_delete_state,created_at,updated_at) VALUES('session','local','workflow','workflow_draft',?,?,'multi','test-provider','test-model','orchard.maintenance.v1','readonly',?,1,1,'active','absent',?,?)", id, canonicalJson(target.scope), K, now, now);
      f.store.exec("INSERT INTO agent_maintenance_tasks(id,session_id,mode,request_id,request_hash,sequence,generation,projection_generation,projection_hash,baseline_json,status,process_state,created_at) VALUES('task','session','multi','turn',?,1,1,?, ?,?,'running','running',?)", H, Number(f.store.one("SELECT synced_generation FROM agent_workspace_projection_state")!.synced_generation), H, canonicalJson(baseline), now);
    }
    const files = Object.fromEntries(Object.entries(source).filter(([path]) => path !== "layout.json"));
    files["workflow.json"] = JSON.stringify({ ...JSON.parse(files["workflow.json"]!), name: "Worker applied" });
    const p = await service.submit("local", "session", "task", { contractVersion: "orchard.maintenance.v1", requestId: request, summary: "Rename", target, baseline, change: { operation: "replace", files } }, new AbortController().signal);
    service.decideByUser("local", p.id, "confirm", p.contentHash, p.diffHash, "confirm:" + request);
    return p;
  };
  const finish = () => f.store.exec("UPDATE agent_maintenance_tasks SET status='succeeded',process_state='stopped',ended_at=? WHERE id='task'", Date.now());
  const queue = async () => { const p = await proposal(); const receipt = service.enqueue("local", p.id, "apply"); finish(); return { proposal: p, receipt }; };
  const factory: MaintenanceRuntimeFactory = store => ({ boundary: boundaryFor(store), close() { assert.equal(store.db.isOpen, true); state.closes++; } });
  return { ...f, draft, source, bridge, assets, service, boundary, state, boundaryFor, factory, proposal, finish, queue };
}

test("confirmed applications block page/Store/exclusive writes before side effects, but not metadata commands", async t => {
  const f = await fixture(t), { receipt } = await f.queue(), co = configCoordinator(f.store), generation = f.store.one("SELECT target_generation FROM agent_workspace_projection_state")!.target_generation;
  let entered = false;
  assert.throws(() => co.withWrite(() => { entered = true; }), { code: "MAINTENANCE_APPLY_PENDING" }); assert.equal(entered, false);
  assert.throws(() => co.withExclusive(() => {}), { code: "MAINTENANCE_APPLY_PENDING" });
  assert.throws(() => f.bridge.saveApplication({ id: "blocked", name: "Not saved" }), { code: "MAINTENANCE_APPLY_PENDING" });
  assert.equal(f.bridge.application("blocked"), undefined);
  assert.throws(() => f.store.command("bad-page", "request", {}, () => { f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id); return { saved: true }; }), { code: "MAINTENANCE_APPLY_PENDING" });
  assert.equal(f.store.one("SELECT 1 FROM command_receipts WHERE scope='bad-page'"), undefined);
  f.store.exec("INSERT INTO command_receipts VALUES('display-only','request',?,'{}',?)", H, Date.now());
  assert.equal(f.store.draft(f.draft.id).revision, 0); assert.equal(f.store.one("SELECT target_generation FROM agent_workspace_projection_state")!.target_generation, generation);
  assert.equal((await f.service.process("local", receipt.id, new AbortController().signal)).status, "applied");
  co.withWrite(() => { entered = true; }); assert.equal(entered, true);
});

test("queue wakeups are post-commit and disappear on nested or outer transaction rollback", async t => {
  const f = await fixture(t), proposal = await f.proposal(); f.finish(); let events = 0;
  f.store.events.on("maintenance-work", () => { events++; });
  assert.throws(() => f.store.transaction(() => { f.service.enqueue("local", proposal.id, "aborted"); assert.equal(events, 0); throw new Error("rollback"); }), /rollback/);
  assert.equal(events, 0); assert.equal(f.store.one("SELECT id FROM agent_maintenance_apply_requests"), undefined);
  f.store.transaction(() => {
    assert.throws(() => f.store.transaction(() => { f.service.enqueue("local", proposal.id, "nested"); throw new Error("nested rollback"); }), /nested rollback/);
    assert.equal(events, 0);
  });
  assert.equal(events, 0);
  f.store.transaction(() => { f.service.enqueue("local", proposal.id, "committed"); assert.equal(events, 0); });
  assert.equal(events, 1);
});

test("worker start recovers durable queues, is idempotent and applies without any model call", async t => {
  const f = await fixture(t), { receipt } = await f.queue(), worker = new MaintenanceApplyWorker(f.store, f.service, { synchronize: true }); t.after(() => worker.close());
  worker.start(); worker.start(); await worker.idle();
  assert.equal(f.service.receipt("local", receipt.id).status, "applied"); assert.equal(f.store.draft(f.draft.id).revision, 1);
  assert.equal(f.provider.calls.length, 0); assert.equal(f.store.events.listenerCount("maintenance-work"), 1);
  await worker.close(); assert.equal(f.store.events.listenerCount("maintenance-work"), 0); assert.equal(f.store.events.listenerCount("workspace-dirty"), 0);
});

test("worker follows dirty events and task exit, never synchronizes while a shared task remains active", async t => {
  const f = await fixture(t), worker = new MaintenanceApplyWorker(f.store, f.service, { synchronize: true }); t.after(() => worker.close()); worker.start(); await worker.idle();
  f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id); await worker.idle();
  assert.equal(f.state.syncCalls, 1); assert.equal(f.store.one("SELECT state FROM agent_workspace_projection_state")!.state, "ready");
  const p = await f.proposal(), request = f.service.enqueue("local", p.id, "apply"); await worker.idle();
  assert.equal(f.service.receipt("local", request.id).status, "queued"); assert.equal(f.state.syncCalls, 1);
  f.finish(); await worker.idle(); assert.equal(f.service.receipt("local", request.id).status, "applied");
  await worker.close(); const calls = f.state.syncCalls;
  f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id); await Promise.resolve(); assert.equal(f.state.syncCalls, calls);
});

test("worker wakeups cannot inherit a caller's write scope and synchronization cannot mutate business definitions", async t => {
  const f = await fixture(t), co = configCoordinator(f.store), worker = new MaintenanceApplyWorker(f.store, f.service, { synchronize: true }); t.after(() => worker.close());
  worker.start(); await worker.idle(); let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const exclusive = co.withMaintenanceApply(async () => { f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id); await blocked; });
  await worker.idle(); assert.equal(f.state.syncCalls, 0); release(); await exclusive;
  f.boundary.synchronize = async () => { assert.equal(co.definitionWritePurpose, "workspace.sync"); f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id); };
  worker.wake(); await worker.idle(); assert.equal(f.store.draft(f.draft.id).revision, 1);
  assert.equal(f.store.one("SELECT state FROM agent_workspace_projection_state")!.state, "pending");
});

test("a failed stop proof durably closes writes even without a DB task; async checks never authorize sync", async t => {
  const f = await fixture(t); f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id);
  f.boundary.assertQuiescent = async () => { throw new Error("not proven"); };
  const worker = new MaintenanceApplyWorker(f.store, f.service, { synchronize: true }); t.after(() => worker.close()); worker.start(); await worker.idle();
  assert.equal(f.state.syncCalls, 0); assert.equal(f.store.one("SELECT error_code FROM agent_workspace_projection_state")!.error_code, "PROCESS_STOP_UNCONFIRMED");
  assert.throws(() => configCoordinator(f.store).withWrite(() => {}), { code: "PROCESS_STOP_UNCONFIRMED" });
});

test("worker close waits for validation, cancels uncommitted apply and leaves its durable request recoverable", async t => {
  const f = await fixture(t), { receipt } = await f.queue(); let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  const prepare = f.assets.prepare.bind(f.assets); f.assets.prepare = async (...args) => { entered(); await blocked; return prepare(...args); };
  const worker = new MaintenanceApplyWorker(f.store, f.service); worker.start(); await waiting;
  let closed = false; const closing = worker.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); release(); await closing;
  assert.equal(f.store.draft(f.draft.id).revision, 0); assert.equal(f.service.receipt("local", receipt.id).status, "queued");
  worker.start(); assert.equal(f.store.events.listenerCount("maintenance-work"), 0);
});

test("post-apply synchronization cannot mutate definitions even inside the application's privileged scope", async t => {
  const f = await fixture(t), { receipt } = await f.queue();
  f.boundary.synchronize = async () => { f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id); };
  const worker = new MaintenanceApplyWorker(f.store, f.service); t.after(() => worker.close()); worker.start(); await worker.idle();
  assert.equal(f.service.receipt("local", receipt.id).status, "applied_projection_pending"); assert.equal(f.store.draft(f.draft.id).revision, 1);
});

test("revoked policy or newly sensitive candidates settle the queue instead of permanently blocking page writes", async t => {
  for (const reason of ["permission", "sensitive"]) await t.test(reason, async t => {
    const f = await fixture(t), { receipt } = await f.queue();
    if (reason === "permission") f.state.allowApply = false;
    else f.boundary.knownSecrets = () => ["Worker applied"];
    const worker = new MaintenanceApplyWorker(f.store, f.service); t.after(() => worker.close()); worker.start(); await worker.idle();
    assert.equal(f.service.receipt("local", receipt.id).status, "rejected"); assert.equal(f.store.draft(f.draft.id).revision, 0);
    configCoordinator(f.store).withWrite(() => {});
  });
});

test("projection retry after an applied receipt never repeats the business mutation", async t => {
  const f = await fixture(t), { receipt } = await f.queue(); f.state.failSync = true;
  const worker = new MaintenanceApplyWorker(f.store, f.service, { synchronize: true }); t.after(() => worker.close()); worker.start(); await worker.idle();
  assert.equal(f.service.receipt("local", receipt.id).status, "applied_projection_pending"); assert.equal(f.store.draft(f.draft.id).revision, 1);
  f.state.failSync = false; worker.wake(); await worker.idle();
  assert.equal(f.service.receipt("local", receipt.id).status, "applied"); assert.equal(f.store.draft(f.draft.id).revision, 1); assert.equal(f.provider.calls.length, 0);
});

test("malformed authority initialization still closes returned resources before the Store", async t => {
  const f = await fixture(t, false);
  const malformed: MaintenanceRuntimeFactory = store => ({ boundary: {} as any, close() { assert.equal(store.db.isOpen, true); f.state.closes++; } });
  const { app } = createApp(f.store, f.providers, undefined, undefined, {}, malformed);
  try { await assert.rejects(async () => { await app.ready(); }, { code: "MAINTENANCE_RUNTIME_INVALID" }); } finally { await app.close(); }
  assert.equal(f.state.closes, 1);
});

test("unknown startup quiescence persists the stop barrier and never enters legacy recovery", async t => {
  const f = await fixture(t, false); f.state.stopped = false; let recovered = false, marker: unknown;
  f.store.recoverBusiness = () => { recovered = true; };
  const close = f.store.close.bind(f.store); f.store.close = () => { if (f.store.db.isOpen) marker = f.store.one("SELECT error_code FROM agent_workspace_projection_state")!.error_code; close(); };
  const { app } = createApp(f.store, f.providers, undefined, undefined, {}, f.factory);
  try { await assert.rejects(async () => { await app.ready(); }, { code: "PROCESS_STOP_UNCONFIRMED" }); } finally { await app.close(); }
  assert.equal(marker, "PROCESS_STOP_UNCONFIRMED"); assert.equal(recovered, false); assert.equal(f.state.closes, 1);
});

test("production initialization refuses silently orphaned queues when no trusted runtime authority is supplied", async t => {
  const f = await fixture(t, false); await f.queue(); let preserved: unknown;
  const close = f.store.close.bind(f.store); f.store.close = () => { if (f.store.db.isOpen) preserved = f.store.one("SELECT state FROM agent_maintenance_apply_requests")!.state; close(); };
  const { app } = createApp(f.store, f.providers);
  try { await assert.rejects(async () => { await app.ready(); }, { code: "MAINTENANCE_RUNTIME_REQUIRED" }); } finally { await app.close(); }
  assert.equal(preserved, "queued"); assert.equal(f.provider.calls.length, 0);
});

test("app recovers through the installed authority and requires its HTTP identity for retention", async t => {
  const f = await fixture(t, false);
  let recovered = false;
  const factory: MaintenanceRuntimeFactory = store => ({
    ...f.factory(store),
    recover() { recovered = true; },
    authorizeUserRequest(request) {
      assert.equal(recovered, true);
      if (request.headers["x-test-maintenance-user"] !== "fixture") throw new AppError("UNAUTHORIZED", "denied", 403);
      return "local";
    },
  });
  const { app } = createApp(f.store, f.providers, undefined, undefined, {}, factory);
  try {
    await app.ready();
    assert.equal((await app.inject("/api/maintenance/retention")).statusCode, 403);
    const headers = { "x-test-maintenance-user": "fixture" };
    const preview = await app.inject({ url: "/api/maintenance/retention", headers });
    assert.equal(preview.statusCode, 200);
    const applied = await app.inject({ method: "POST", url: "/api/maintenance/retention", headers, payload: { hash: preview.json().hash } });
    assert.equal(applied.statusCode, 200);
    assert.deepEqual(applied.json(), preview.json());
  } finally { await app.close(); }
});

test("production authority reconciles a journaled task, rebuilds projection and exposes the owner review", async t => {
  const f = await fixture(t, false);
  const proposal = await f.proposal();
  const journal = new MaintenanceStopJournal(f.store.root, () => f.store.directoryLease.assert());
  journal.reserve({ taskId: "task", sessionId: "session", generation: 1 });
  f.store.exec("UPDATE agent_workspace_projection_state SET target_knowledge_hash=?,state='pending'", loadKnowledgeBundle().hash);
  const services = createApp(f.store, f.providers, undefined, undefined, {}, createProductionMaintenance);
  try {
    await services.app.ready();
    await services.maintenanceWorker!.idle();
    assert.equal(f.store.one("SELECT status FROM agent_maintenance_tasks WHERE id='task'")?.status, "interrupted");
    assert.equal(f.store.one("SELECT state FROM agent_workspace_projection_state")?.state, "ready");
    const url = `/api/maintenance/owners/workflow_draft/${f.draft.id}/proposals`;
    assert.equal((await services.app.inject(url)).statusCode, 403);
    const result = await services.app.inject({ url, headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json().items.map((item: { id: string }) => item.id), [proposal.id]);
  } finally {
    await services.app.close();
    const workspace = join(f.root, "agent", "workspace");
    if (existsSync(workspace)) {
      chmodSync(workspace, 0o700);
      for (const entry of readdirSync(workspace, { recursive: true, withFileTypes: true })) {
        if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o700);
      }
    }
  }
});

test("production worker drains startup queues and closes authority once before Store, including a real Store reopen", async t => {
  const f = await fixture(t, false), { receipt } = await f.queue(); f.state.allowApply = false;
  // Keep the first queue durable rather than rejecting it: simulate temporary
  // policy-service unavailability while read permission remains available.
  const unavailable: MaintenanceRuntimeFactory = store => {
    const authority = f.factory(store), authorize = authority.boundary.authorize.bind(authority.boundary);
    authority.boundary.authorize = (actor, target, action) => { if (action === "apply") throw new AppError("AUTHORITY_UNAVAILABLE", "temporarily unavailable", 503); authorize(actor, target, action); }; return authority;
  };
  const first = createApp(f.store, f.providers, undefined, undefined, {}, unavailable);
  await first.app.ready(); await first.maintenanceWorker!.idle(); assert.equal(first.maintenance!.receipt("local", receipt.id).status, "queued");
  await first.maintenanceWorker!.close(); // Prove the gate is durable, not a worker mutex.
  const edit = await first.app.inject({ method: "PATCH", url: `/api/drafts/${f.draft.id}`, payload: { expectedRevision: 0, files: f.source } });
  assert.equal(edit.statusCode, 409); assert.equal(edit.json().code, "MAINTENANCE_APPLY_PENDING");
  const browserEdit = await first.app.inject({ method: "POST", url: "/api/web-bridge/applications", payload: { id: "blocked", name: "Not saved" } });
  assert.equal(browserEdit.statusCode, 409); assert.equal(browserEdit.json().code, "MAINTENANCE_APPLY_PENDING");
  assert.equal(f.store.draft(f.draft.id).revision, 0); assert.equal(first.bridge.applications().length, 0);
  await first.app.close(); assert.equal(f.state.closes, 1);
  // Reopen only this isolated reviewed-schema fixture. Bootstrap's frozen
  // migration validator intentionally does not yet accept a production 8-table
  // migration; do not weaken that validator to make a fixture reopen succeed.
  f.state.allowApply = true; const lease = DirectoryLease.acquire(f.root), reopened = new Store(f.root, lease);
  const second = createApp(reopened, undefined, undefined, undefined, {}, f.factory);
  try {
    await second.app.ready(); await until(() => second.maintenance!.receipt("local", receipt.id).status === "applied");
    assert.equal(reopened.draft(f.draft.id).revision, 1); assert.equal(f.provider.calls.length, 0);
    assert.equal(reopened.events.listenerCount("maintenance-work"), 1);
  } finally { await second.app.close(); lease.release(); }
  assert.equal(f.state.closes, 2);
});
