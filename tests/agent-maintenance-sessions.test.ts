import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setup, prepareMaintenanceFixture } from "./helpers.js";
import { check } from "../src/domain/errors.js";
import { canonicalJson, digest } from "../src/persistence/files.js";
import { configCoordinator } from "../src/config-git/coordinator.js";
import { MaintenanceAssets } from "../src/agent/maintenance-assets.js";
import { MaintenanceService } from "../src/agent/maintenance-service.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { MaintenanceSessions, type MaintenanceSessionBoundary } from "../src/agent/maintenance-sessions.js";
import { installWorkspaceBusinessTracking } from "../src/agent/workspace-business-hooks.js";
import { bridgeDeclaration } from "../src/web-bridge/database-config.js";
import { configuredWebBridge } from "../src/web-bridge/configured.js";
import type { MaintenanceTarget } from "../src/agent/maintenance-protocol.js";
import { chmodSync, readFileSync } from "node:fs";
import { MaintenanceTaskHost } from "../src/agent/maintenance-task-host.js";
import { MaintenanceToolGateway } from "../src/agent/maintenance-tools.js";
import { WorkspaceInstaller } from "../src/agent/workspace-installer.js";
import { buildWorkspaceProjection } from "../src/agent/workspace-projection.js";

const K = "a".repeat(64), P = "b".repeat(64), F = "c".repeat(64);
async function fixture(t: TestContext) {
  const f = setup(t); t.after(async () => { await f.authoring.close(); f.store.close(); });
  const draft = await f.authoring.create(undefined, "initial"), resourceId = JSON.parse(f.store.files.readTree(draft.artifactPath).files["workflow.json"]!).id;
  prepareMaintenanceFixture(f.store);
  const declaration = bridgeDeclaration(readFileSync(f.store.files.path("config/web-bridge.json"), "utf8"));
  f.store.exec("INSERT INTO bridge_configuration VALUES('current',1,?,?,?)", declaration, digest(declaration), Date.now());
  f.store.exec("INSERT INTO agent_workspace_projection_state VALUES('maintenance',1,1,?,?,?,'ready',NULL,?)", K, K, P, Date.now());
  f.store.exec("INSERT INTO agent_workspace_workflow_bindings VALUES(?,?,?)", draft.id, resourceId, draft.createdAt);
  const releaseTracking = installWorkspaceBusinessTracking(f.store); t.after(releaseTracking);
  const bridge = configuredWebBridge(f.store), business = new MaintenanceAssets(f.store, bridge, () => f.providers);
  // Explicit unit-test policies, not real CLI certification or OS exit evidence.
  const state = { allowed: true, verified: true, stopped: false, fingerprint: F, knowledge: K, toolPolicy: "test-readonly-v1", proofs: [] as string[], revoked: [] as string[] };
  const boundary: MaintenanceSessionBoundary = {
    authorize() { check(state.allowed, "FORBIDDEN", "权限已撤销", 403); },
    backend(providerId, _modelId, _mode, owner) {
      check(state.verified, "BACKEND_UNAVAILABLE", "真实 CLI 尚未验收", 503);
      return { fingerprint: state.fingerprint, knowledgeHash: state.knowledge, toolPolicyVersion: state.toolPolicy, references: {
        providerId, supportedVersions: [1], validatePayload(payload) {
          check(payload && typeof payload === "object" && !Array.isArray(payload) && payload.owner === owner.sessionId && typeof payload.nativeId === "string" && /^native-[0-9]+$/.test(payload.nativeId), "BACKEND_REFERENCE_OWNER", "引用不属于固定维护会话", 403);
        },
      } };
    },
    assertStopped(binding) { state.proofs.push(binding.taskId); check(state.stopped, "PROCESS_STILL_RUNNING", "模拟进程仍在运行", 409); },
    revokeTask(taskId) { state.revoked.push(taskId); }, knownSecrets: () => ["PRIVATE_CREDENTIAL_MARKER"],
  };
  const sessions = new MaintenanceSessions(f.store, business, boundary);
  const service = new MaintenanceService(f.store, business, { authorize: () => { check(state.allowed, "FORBIDDEN", "权限已撤销", 403); },
    knownSecrets: boundary.knownSecrets, assertQuiescent() { check(state.stopped, "PROCESS_STOP_UNCONFIRMED", "模拟进程未停", 409); }, async synchronize() {} });
  const ready = () => f.store.exec("UPDATE agent_workspace_projection_state SET synced_generation=target_generation,state='ready',error_code=NULL");
  const target: MaintenanceTarget = { kind: "workflow_draft", id: resourceId, scope: { draftId: draft.id } };
  const createInput = (mode: "single" | "multi" = "multi") => ({ target, mode, providerId: "test-provider", modelId: "test-model" });
  const make = (requestId = "session", mode: "single" | "multi" = "multi") => sessions.create("local", requestId, createInput(mode));
  const input = (sessionId: string, requestId = "turn", prompt = "Please inspect the project") => {
    const session = sessions.view("local", sessionId);
    return { requestId, prompt, expectedRevision: session.revision, expectedGeneration: session.generation };
  };
  return { ...f, draft, sessions, service, ready, releaseTracking, business, boundary, bridge, state, target, createInput, make, input };
}

test("task host closes IPC and the journaled process lease before publishing task completion", async t => {
  const f = await fixture(t);
  const host = new MaintenanceTaskHost(f.store);
  const sessions = new MaintenanceSessions(f.store, f.business, {
    ...f.boundary,
    assertStopped: binding => host.assertStopped(binding),
    revokeTask: taskId => host.revokeTask(taskId),
  });
  const installer = new WorkspaceInstaller(f.store, {
    rules: { "AGENTS.md": "Review workspace" }, knowledgeHash: K,
    source: async () => buildWorkspaceProjection({ resources: [], applications: [], knownSecrets: [] }),
    assertQuiescent: () => host.assertQuiescent(),
  });
  const signal = new AbortController().signal;
  await installer.synchronize(signal);
  try {
    const sessionId = sessions.create("local", "host-session", f.createInput());
    const task = sessions.enqueue("local", sessionId, f.input(sessionId));
    let proveBridgeClosed: (() => void) | undefined;
    await host.run({
      actor: "local", sessionId, taskId: task.id, generation: task.generation,
      sessions, installer, gateway: new MaintenanceToolGateway(f.store, f.service),
      async execute(claim, { bridge }) {
        proveBridgeClosed = () => bridge.assertClosed();
        assert.throws(proveBridgeClosed, { code: "PROCESS_STOP_UNCONFIRMED" });
        sessions.recordDisplay(claim.handle, "Checked the project.");
      },
    });
    assert.ok(proveBridgeClosed);
    proveBridgeClosed();
    assert.equal(sessions.tasks("local", sessionId)[0]?.status, "succeeded");
    host.assertQuiescent();
  } finally {
    await host.close();
    chmodSync(installer.cwd, 0o700);
  }
});

test("session creation is immutable, actor-scoped and idempotent without returning native references or stale views", async t => {
  const f = await fixture(t), sessionId = f.make();
  assert.equal(f.make(), sessionId); assert.equal(f.sessions.list("local", f.target).length, 1);
  assert.throws(() => f.make("session", "single"), { code: "REQUEST_CONFLICT" });
  assert.throws(() => f.sessions.view("other", sessionId), { code: "NOT_FOUND" });
  assert.deepEqual(f.sessions.list("other", f.target), []);
  const dto = f.sessions.view("local", sessionId);
  assert.equal(dto.mode, "multi"); assert.deepEqual(dto.target.scope, { draftId: f.draft.id });
  assert.ok(!JSON.stringify(dto).includes("native_ref")); assert.ok(!JSON.stringify(dto).includes("fingerprint"));
  assert.equal(f.store.one<{ n: number }>("SELECT count(*) n FROM agent_maintenance_sessions")!.n, 1);
});

test("unverified providers, invalid target scopes, async permission checks and forged extra fields never create records", async t => {
  const f = await fixture(t); f.state.verified = false;
  assert.throws(() => f.make(), { code: "BACKEND_UNAVAILABLE" });
  assert.equal(f.store.one("SELECT id FROM agent_maintenance_sessions"), undefined);
  assert.throws(() => f.sessions.create("local", "bad", { ...f.createInput(), target: { ...f.target, scope: { draftId: "another" } } }), { code: "NOT_FOUND" });
  assert.throws(() => f.sessions.create("local", "forged", { ...f.createInput(), confirmed: true } as any), { code: "INVALID_PROPOSAL" });
  f.state.verified = true; f.boundary.authorize = async () => { throw new Error("denied asynchronously"); };
  assert.throws(() => f.make(), { code: "AUTHORIZATION_INVALID" });
  await Promise.resolve(); assert.equal(f.store.one("SELECT id FROM agent_maintenance_sessions"), undefined);
});

test("admission freezes current target/projection baselines and request replay never starts a second task", async t => {
  const f = await fixture(t), sessionId = f.make(), input = f.input(sessionId), task = f.sessions.enqueue("local", sessionId, input);
  assert.equal(task.status, "queued"); assert.equal(task.processState, "absent");
  assert.deepEqual(f.sessions.enqueue("local", sessionId, input), task);
  assert.throws(() => f.sessions.enqueue("local", sessionId, { ...input, prompt: "different" }), { code: "REQUEST_CONFLICT" });
  const row = f.store.one<{ baseline_json: string; projection_generation: number; projection_hash: string }>("SELECT * FROM agent_maintenance_tasks WHERE id=?", task.id)!;
  assert.equal(row.baseline_json, canonicalJson(f.business.capture(f.target).baseline)); assert.equal(row.projection_generation, 1); assert.equal(row.projection_hash, P);
  assert.equal(f.store.one<{ target_generation: number }>("SELECT target_generation FROM agent_workspace_projection_state")!.target_generation, 1);
  const launch = f.sessions.claim(task.id); assert.equal(launch.reference, null); assert.deepEqual(launch.input, { prompt: input.prompt });
  assert.ok(!Object.hasOwn(launch, "messages")); assert.ok(!Object.hasOwn(launch, "files"));
  assert.throws(() => f.sessions.claim(task.id), { code: "TASK_NOT_QUEUED" });
  assert.throws(() => f.sessions.started({ ...launch.handle }), { code: "TASK_CAPABILITY_INVALID" });
  f.sessions.started(launch.handle); assert.equal(f.sessions.tasks("local", sessionId)[0]!.processState, "running");
});

test("global serial admission covers all sessions and direct business writes, while cancellation of unspawned tasks is immediate", async t => {
  const f = await fixture(t), a = f.make("a"), b = f.make("b");
  const task = f.sessions.enqueue("local", a, f.input(a));
  assert.throws(() => f.sessions.enqueue("local", b, f.input(b)), { code: "WORKSPACE_BUSY" });
  assert.throws(() => f.store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", f.draft.id), { code: "WORKSPACE_BUSY" });
  assert.equal(f.sessions.cancel("local", a, task.id).status, "cancelled"); assert.equal(f.state.proofs.length, 0);
  assert.equal(f.sessions.enqueue("local", b, f.input(b)).status, "queued");
});

test("single mode permits one logical task and never persists or resumes a native reference", async t => {
  const f = await fixture(t), sessionId = f.make("single", "single"), input = f.input(sessionId), task = f.sessions.enqueue("local", sessionId, input);
  const launch = f.sessions.claim(task.id); assert.equal(launch.mode, "single"); assert.equal(launch.reference, null);
  assert.throws(() => f.sessions.attachReference(launch.handle, { providerId: "test-provider", version: 1, opaque: { owner: sessionId, nativeId: "native-1" } }), { code: "SINGLE_REFERENCE_FORBIDDEN" });
  f.state.stopped = true; f.sessions.settle(launch.handle, "succeeded");
  assert.equal(f.sessions.enqueue("local", sessionId, input).id, task.id);
  assert.throws(() => f.sessions.enqueue("local", sessionId, f.input(sessionId, "another")), { code: "SINGLE_TASK_SETTLED" });
  assert.equal(f.store.one("SELECT native_ref_json FROM agent_maintenance_sessions WHERE id=?", sessionId)!.native_ref_json, null);
});

test("multi mode restores only the exact owner-bound native reference and rejects stale policy/installations", async t => {
  const f = await fixture(t), sessionId = f.make(), task = f.sessions.enqueue("local", sessionId, f.input(sessionId)), launch = f.sessions.claim(task.id);
  assert.throws(() => f.sessions.attachReference(launch.handle, { providerId: "test-provider", version: 1, opaque: { owner: "another-session", nativeId: "native-1" } }), { code: "BACKEND_REFERENCE_OWNER" });
  const reference = { providerId: "test-provider", version: 1, opaque: { owner: sessionId, nativeId: "native-1" } };
  f.sessions.attachReference(launch.handle, reference); f.sessions.attachReference(launch.handle, reference);
  assert.throws(() => f.sessions.attachReference(launch.handle, { ...reference, opaque: { ...reference.opaque, nativeId: "native-2" } }), { code: "BACKEND_REFERENCE_CONFLICT" });
  f.state.stopped = true; f.sessions.settle(launch.handle, "succeeded");
  f.state.fingerprint = "d".repeat(64);
  assert.throws(() => f.sessions.enqueue("local", sessionId, f.input(sessionId, "second")), { code: "BACKEND_CHANGED" });
  f.state.fingerprint = F; f.state.toolPolicy = "changed";
  assert.throws(() => f.sessions.enqueue("local", sessionId, f.input(sessionId, "second")), { code: "SESSION_CONTRACT_CHANGED" });
  f.state.toolPolicy = "test-readonly-v1";
  const second = f.sessions.enqueue("local", sessionId, f.input(sessionId, "second"));
  assert.equal(second.sequence, 2); assert.deepEqual(f.sessions.claim(second.id).reference, reference);
  assert.ok(!JSON.stringify(f.sessions.tasks("local", sessionId)).includes("native-1"));
});

test("cancelled running tasks retain the global gate until real exit proof; unknown exit never becomes success", async t => {
  const f = await fixture(t), sessionId = f.make(), task = f.sessions.enqueue("local", sessionId, f.input(sessionId)), launch = f.sessions.claim(task.id);
  f.sessions.started(launch.handle); assert.equal(f.sessions.cancel("local", sessionId, task.id).status, "stopping");
  assert.throws(() => f.sessions.recordDisplay(launch.handle, "late output"), { code: "INVALID_TASK_OUTPUT" });
  assert.throws(() => f.sessions.settle(launch.handle, "succeeded"), { code: "PROCESS_STOP_UNCONFIRMED" });
  const pending = f.sessions.tasks("local", sessionId)[0]!; assert.equal(pending.status, "stopping"); assert.equal(pending.processState, "unknown"); assert.equal(pending.endedAt, null);
  assert.equal(f.store.one("SELECT error_code FROM agent_workspace_projection_state")!.error_code, "PROCESS_STOP_UNCONFIRMED");
  assert.throws(() => configCoordinator(f.store).withWrite(() => {}), { code: "WORKSPACE_BUSY" });
  f.state.stopped = true; const ended = f.sessions.settle(launch.handle, "succeeded"); assert.equal(ended.status, "cancelled");
  assert.equal(ended.processState, "stopped"); assert.ok(ended.endedAt); assert.ok(f.state.revoked.includes(task.id));
  assert.throws(() => f.sessions.started(launch.handle), { code: "TASK_CAPABILITY_INVALID" });
  assert.throws(() => f.sessions.enqueue("local", sessionId, f.input(sessionId, "after")), { code: "WORKSPACE_NOT_READY" });
});

test("startup recovery preserves uncertain processes and queued tasks; reconciliation needs fresh exact stop proof", async t => {
  const f = await fixture(t), sessionId = f.make(), task = f.sessions.enqueue("local", sessionId, f.input(sessionId));
  const restarted = new MaintenanceSessions(f.store, f.business, f.boundary); restarted.recoverUncertain();
  assert.equal(f.sessions.tasks("local", sessionId)[0]!.status, "queued");
  const launch = f.sessions.claim(task.id); restarted.recoverUncertain();
  assert.equal(f.sessions.tasks("local", sessionId)[0]!.processState, "unknown");
  assert.throws(() => restarted.started(launch.handle), { code: "TASK_CAPABILITY_INVALID" });
  assert.throws(() => restarted.reconcileStopped(task.id, 2), { code: "TASK_GENERATION_CONFLICT" });
  assert.throws(() => restarted.reconcileStopped(task.id, 1), { code: "PROCESS_STOP_UNCONFIRMED" });
  f.state.stopped = true; assert.equal(restarted.reconcileStopped(task.id, 1).status, "interrupted");
  assert.equal(f.store.one("SELECT state FROM agent_workspace_projection_state")!.state, "failed");
});

test("async stop checks fail closed and display records never replay credentials or history as a prompt", async t => {
  const f = await fixture(t), sessionId = f.make(), task = f.sessions.enqueue("local", sessionId, f.input(sessionId)), launch = f.sessions.claim(task.id);
  f.sessions.recordDisplay(launch.handle, "A user-visible explanation");
  assert.ok(!JSON.stringify(f.sessions.tasks("local", sessionId)).includes("A user-visible explanation"));
  assert.throws(() => f.sessions.recordDisplay(launch.handle, "PRIVATE_CREDENTIAL_MARKER"), { code: "QUERY_SENSITIVE_CONTENT" });
  f.store.exec("UPDATE agent_maintenance_tasks SET error_code='PRIVATE_CREDENTIAL_MARKER' WHERE id=?", task.id);
  assert.equal(f.sessions.tasks("local", sessionId)[0]!.errorCode, "MAINTENANCE_TASK_FAILED");
  assert.ok(!JSON.stringify(f.sessions.tasks("local", sessionId)).includes("PRIVATE_CREDENTIAL_MARKER"));
  f.boundary.assertStopped = async () => { throw new Error("not proven"); };
  assert.throws(() => f.sessions.settle(launch.handle, "succeeded"), { code: "PROCESS_STOP_UNCONFIRMED" });
  await Promise.resolve(); assert.equal(f.sessions.tasks("local", sessionId)[0]!.status, "stopping");
});

test("permissions and projection readiness are checked again at admission and claim", async t => {
  const f = await fixture(t), sessionId = f.make();
  f.store.exec("UPDATE agent_workspace_projection_state SET state='pending'");
  assert.throws(() => f.sessions.enqueue("local", sessionId, f.input(sessionId)), { code: "WORKSPACE_NOT_READY" });
  f.store.exec("UPDATE agent_workspace_projection_state SET state='ready'");
  const task = f.sessions.enqueue("local", sessionId, f.input(sessionId)); f.state.allowed = false;
  assert.throws(() => f.sessions.claim(task.id), { code: "FORBIDDEN" });
  assert.equal(f.store.one("SELECT status FROM agent_maintenance_tasks WHERE id=?", task.id)!.status, "queued");
});

test("confirmed queued applications take priority over the next task, without launching a model to apply", async t => {
  const f = await fixture(t), sessionId = f.make(), task = f.sessions.enqueue("local", sessionId, f.input(sessionId)), launch = f.sessions.claim(task.id);
  const files = Object.fromEntries(Object.entries(f.store.files.readTree(f.draft.artifactPath).files).filter(([path]) => path !== "layout.json"));
  files["workflow.json"] = JSON.stringify({ ...JSON.parse(files["workflow.json"]!), name: "Applied by platform" });
  const proposal = await f.service.submit("local", sessionId, task.id, { contractVersion: "orchard.maintenance.v1", requestId: "proposal", summary: "Rename", target: f.target, baseline: launch.baseline, change: { operation: "replace", files } }, new AbortController().signal);
  f.service.decideByUser("local", proposal.id, "confirm", proposal.contentHash, proposal.diffHash, "confirm");
  const queued = f.service.enqueue("local", proposal.id, "apply"); f.state.stopped = true; f.sessions.settle(launch.handle, "succeeded");
  assert.throws(() => f.sessions.enqueue("local", sessionId, f.input(sessionId, "next")), { code: "MAINTENANCE_APPLY_PENDING" });
  assert.equal((await f.service.process("local", queued.id, new AbortController().signal)).status, "applied_projection_pending");
  assert.equal(f.store.draft(f.draft.id).revision, 1); assert.equal(f.provider.calls.length, 0);
  assert.throws(() => f.sessions.enqueue("local", sessionId, f.input(sessionId, "next")), { code: "WORKSPACE_NOT_READY" });
});

test("deleting and recreating a browser application permanently retires old sessions without deleting native history", async t => {
  const f = await fixture(t); f.bridge.saveApplication({ id: "crm", name: "Before" }); f.ready();
  const target: MaintenanceTarget = { kind: "browser_application", id: "crm", scope: {} };
  const sessionId = f.sessions.create("local", "browser", { ...f.createInput(), target });
  const task = f.sessions.enqueue("local", sessionId, f.input(sessionId)), launch = f.sessions.claim(task.id);
  f.sessions.attachReference(launch.handle, { providerId: "test-provider", version: 1, opaque: { owner: sessionId, nativeId: "native-1" } });
  f.state.stopped = true; f.sessions.settle(launch.handle, "succeeded");
  f.bridge.deleteApplication("crm"); f.bridge.saveApplication({ id: "crm", name: "Recreated" }); f.ready();
  assert.equal(f.sessions.view("local", sessionId).readOnlyReason, "OWNER_UNAVAILABLE");
  assert.throws(() => f.sessions.enqueue("local", sessionId, f.input(sessionId, "after-recreate")), { code: "OWNER_UNAVAILABLE" });
  assert.equal(f.store.one("SELECT native_delete_state FROM agent_maintenance_sessions WHERE id=?", sessionId)!.native_delete_state, "present");
  assert.equal(f.sessions.tasks("local", sessionId).length, 1);
  const fresh = f.sessions.create("local", "new-browser", { ...f.createInput(), target });
  const next = f.sessions.enqueue("local", fresh, f.input(fresh)); assert.equal(f.sessions.claim(next.id).reference, null);
});

test("published/deleted draft owner tombstones commit atomically and survive restoration of the same row identity", async t => {
  const f = await fixture(t), sessionId = f.make();
  assert.throws(() => f.store.transaction(() => { f.authoring.deleteDraft(f.draft.id); throw new Error("rollback"); }), /rollback/);
  assert.equal(f.sessions.view("local", sessionId).readOnlyReason, null);
  await f.authoring.publish(f.draft.id, f.draft.revision, "publish");
  assert.equal(f.sessions.view("local", sessionId).readOnlyReason, "OWNER_UNAVAILABLE");
  f.store.exec("UPDATE drafts SET status='draft' WHERE id=?", f.draft.id); f.ready();
  assert.throws(() => f.sessions.enqueue("local", sessionId, f.input(sessionId)), { code: "OWNER_UNAVAILABLE" });
});

test("old confirmed proposals conflict after owner retirement, while their audit and idempotent receipts remain readable", async t => {
  const f = await fixture(t), sessionId = f.make(), task = f.sessions.enqueue("local", sessionId, f.input(sessionId)), launch = f.sessions.claim(task.id);
  const files = Object.fromEntries(Object.entries(f.store.files.readTree(f.draft.artifactPath).files).filter(([path]) => path !== "layout.json"));
  const proposal = await f.service.submit("local", sessionId, task.id, { contractVersion: "orchard.maintenance.v1", requestId: "proposal", summary: "Candidate", target: f.target, baseline: launch.baseline, change: { operation: "replace", files } }, new AbortController().signal);
  f.service.decideByUser("local", proposal.id, "confirm", proposal.contentHash, proposal.diffHash, "confirm");
  const queued = f.service.enqueue("local", proposal.id, "apply"); f.state.stopped = true; f.sessions.settle(launch.handle, "succeeded");
  // Ordinary page deletion now yields to confirmed applications. A trusted
  // recovery can invalidate the owner; it still cannot transfer the proposal.
  assert.throws(() => f.authoring.deleteDraft(f.draft.id), { code: "MAINTENANCE_APPLY_PENDING" });
  configCoordinator(f.store).withRecovery(() => f.authoring.deleteDraft(f.draft.id));
  const result = await f.service.process("local", queued.id, new AbortController().signal);
  assert.equal(result.status, "conflicted"); assert.equal(result.errorCode, "OWNER_UNAVAILABLE");
  assert.deepEqual(f.service.enqueue("local", proposal.id, "apply"), result);
  assert.equal(f.service.view("local", proposal.id).state, "conflicted");
  assert.throws(() => f.service.enqueue("local", proposal.id, "new-apply"), { code: "OWNER_UNAVAILABLE" });
});

test("script draft publication, creation from published baseline and archive irreversibly retire the matching fixed scope", async t => {
  const f = await fixture(t), library = new ScriptLibrary(f.store);
  await library.create({ id: "sample", name: "Sample", description: "", runtime: "nodejs", entryFile: "main.ts", inputSchema: true, outputSchema: true, files: { "main.ts": "export default async () => 1;" } });
  const draftVersionId = f.store.script("sample").currentDraftVersionId!;
  const draftSession = f.sessions.create("local", "script-draft", { ...f.createInput(), target: { kind: "script_draft", id: "sample", scope: { draftVersionId } } });
  await library.publish("sample", { expectedRevision: 0, requestId: "publish-script" });
  assert.equal(f.sessions.view("local", draftSession).readOnlyReason, "OWNER_UNAVAILABLE");
  const emptyScope = f.sessions.create("local", "published-script", { ...f.createInput(), target: { kind: "script_draft", id: "sample", scope: { draftVersionId: null } } });
  await library.restore("sample", { versionId: f.store.script("sample").currentPublishedVersionId!, expectedRevision: 0, expectedDraftVersionId: null, replaceDraft: false, requestId: "restore-script" });
  assert.equal(f.sessions.view("local", emptyScope).readOnlyReason, "OWNER_UNAVAILABLE");
  const freshScope = f.sessions.create("local", "fresh-script", { ...f.createInput(), target: { kind: "script_draft", id: "sample", scope: { draftVersionId: f.store.script("sample").currentDraftVersionId! } } });
  f.store.archiveScript("sample"); f.store.exec("UPDATE scripts SET status='draft',archived_at=NULL WHERE id='sample'"); f.ready();
  assert.equal(f.sessions.view("local", freshScope).readOnlyReason, "OWNER_UNAVAILABLE");
  assert.throws(() => f.sessions.enqueue("local", freshScope, f.input(freshScope)), { code: "OWNER_UNAVAILABLE" });
});

test("task storage cannot bypass an uninstalled business boundary or a lost data-directory lease", async t => {
  const f = await fixture(t), sessionId = f.make(); f.releaseTracking();
  assert.throws(() => new MaintenanceSessions(f.store, f.business, f.boundary), { code: "WORKSPACE_BOUNDARY_REQUIRED" });
  assert.throws(() => f.sessions.view("local", sessionId), { code: "WORKSPACE_BOUNDARY_REQUIRED" });
  const release = installWorkspaceBusinessTracking(f.store); t.after(release);
  f.store.directoryLease.release();
  assert.throws(() => f.sessions.view("local", sessionId), { code: "INSTANCE_LOCKED" });
  assert.throws(() => f.store.exec("INSERT INTO command_receipts VALUES('after-lease','request',?,'{}',?)", P, Date.now()), { code: "INSTANCE_LOCKED" });
  assert.equal(f.store.one("SELECT 1 FROM command_receipts WHERE scope='after-lease'"), undefined);
});

test("large user prompts use private artifact references and malformed admission values do not create tasks", async t => {
  const f = await fixture(t), sessionId = f.make(), input = f.input(sessionId, "large", "x".repeat(40000));
  assert.throws(() => f.sessions.enqueue("local", sessionId, { ...input, expectedRevision: 0 }), { code: "INVALID_REQUEST" });
  const task = f.sessions.enqueue("local", sessionId, input), row = f.store.one<{ input_ref: string }>("SELECT input_ref FROM agent_maintenance_tasks WHERE id=?", task.id)!;
  assert.ok(JSON.parse(row.input_ref).artifactId); assert.equal((f.sessions.claim(task.id).input as { prompt: string }).prompt, input.prompt);
  assert.ok(!JSON.stringify(f.sessions.tasks("local", sessionId)).includes("artifactId"));
});

test("owner chat restores only authorized messages and does not return private references", async t => {
  const f = await fixture(t);
  const session = f.make();
  const task = f.sessions.enqueue("local", session, f.input(session, "first", "Inspect this workflow"));
  const claim = f.sessions.claim(task.id);
  f.sessions.recordDisplay(claim.handle, "The workflow is ready for review.");
  f.state.stopped = true;
  f.sessions.settle(claim.handle, "succeeded");
  const history = f.sessions.ownerHistory("local", "workflow_draft", f.draft.id, session);
  assert.equal(history.conversations[0]?.title, "Inspect this workflow");
  assert.equal(history.tasks[0]?.prompt, "Inspect this workflow");
  assert.equal(history.tasks[0]?.text, "The workflow is ready for review.");
  assert.equal(f.sessions.ownerHistory("local", "workflow_draft", "other-draft", session).tasks.length, 0);
  assert.equal(f.sessions.ownerHistory("other-actor", "workflow_draft", f.draft.id, session).tasks.length, 0);
  assert.equal(f.sessions.retry("local", session, "first", "Inspect this workflow")?.id, task.id);
  assert.throws(() => f.sessions.retry("local", session, "first", "Different request"), { code: "REQUEST_CONFLICT" });
});


test("switching the model admits a new turn on the same native session", async t => {
  const f = await fixture(t);
  const session = f.make();
  const first = f.sessions.enqueue("local", session, f.input(session));
  const claim = f.sessions.claim(first.id);
  const ref = { providerId: "test-provider", version: 1, opaque: { owner: session, nativeId: "native-1" } };
  f.sessions.attachReference(claim.handle, ref);
  f.state.stopped = true;
  f.sessions.settle(claim.handle, "succeeded");
  const input = { ...f.input(session, "next"), modelId: "other-model" };
  const next = f.sessions.enqueue("local", session, input);
  assert.equal(f.sessions.retry("local", session, input.requestId, input.prompt, input.modelId)?.id, next.id);
  const resumed = f.sessions.claim(next.id);
  assert.deepEqual(resumed.reference, ref);
  assert.equal(resumed.modelId, "other-model");
});
