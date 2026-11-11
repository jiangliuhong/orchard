import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../src/domain/errors.js";
import { KnowledgeService } from "../src/agent/knowledge-service.js";
import { loadKnowledgeBundle } from "../src/agent/knowledge-bundle.js";
import { knowledgeFixture, knowledgeSignal as signal, deferredKnowledge as deferred, knowledgeTick as tick } from "./knowledge-fixtures.js";

function multi(fixture: ReturnType<typeof knowledgeFixture>, hash: string) {
  return fixture.store.create("local", randomUUID(), { scenario: "workflow", ownerType: "draft", ownerId: "current", ownerScope: {}, mode: "multi", providerId: "third-provider", modelId: "model", knowledgeHash: hash, workspaceId: "maintenance", contractVersion: "unified-agent-v1", toolPolicyVersion: "platform-read-v1" }).conversation;
}

test("all profiles share one materialized read-only workspace; repeated initialization does not copy knowledge", async t => {
  const f = knowledgeFixture(t), first = await f.service.initialize(signal());
  assert.equal(first.changed, true); assert.equal(f.service.snapshot().ready, true);
  assert.equal(loadKnowledgeBundle(f.workspace).hash, first.hash);
  for (const file of loadKnowledgeBundle(f.workspace).manifest.files) assert.equal(statSync(join(f.workspace, file.path)).mode & 0o777, 0o444);
  const cwd: string[] = [];
  for (const profile of ["workflow", "script", "web-bridge"] as const) for (let i = 0; i < 4; i++) {
    await f.service.withWorkspace(profile, first.hash, signal(), async lease => { cwd.push(lease.cwd); assert.equal(lease.rules.length, 3); });
  }
  assert.ok(cwd.every(path => path === f.workspace));
  assert.equal((await f.service.initialize(signal())).changed, false);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_operations WHERE kind='knowledge_install'").get()!.n, 1);
  assert.deepEqual(readdirSync(f.staging), []);
  assert.deepEqual(readdirSync(join(f.dataRoot, "agent")).sort(), ["staging", "workspace"]);
  assert.ok(f.service.readFile("AGENTS.md").includes("current.get"));
  assert.throws(() => f.service.readFile("../../workbench.lock"), { code: "NOT_FOUND" });
});

test("knowledge update uses the current package and makes old multi read-only without copying per conversation", async t => {
  const f = knowledgeFixture(t), first = await f.service.initialize(signal()), conversation = multi(f, first.hash);
  f.update("next-version");
  const next = await f.service.initialize(signal());
  assert.notEqual(next.hash, first.hash);
  assert.equal(f.store.conversation("local", conversation.id).usability, "knowledge_outdated");
  assert.equal(f.store.conversation("local", conversation.id).knowledge_hash, first.hash);
  await assert.rejects(f.service.withWorkspace("workflow", first.hash, signal(), async () => assert.fail()), { code: "KNOWLEDGE_UNAVAILABLE" });
  assert.equal(loadKnowledgeBundle(f.workspace).manifest.bundleVersion, "next-version");
  assert.deepEqual(readdirSync(f.staging), []);
});

test("ordinary workspace tampering is repaired from package, unchanged hash keeps existing conversations usable", async t => {
  const f = knowledgeFixture(t), first = await f.service.initialize(signal()), conversation = multi(f, first.hash);
  const file = join(f.workspace, "AGENTS.md"); chmodSync(file, 0o644); writeFileSync(file, "not a platform override");
  await assert.rejects(f.service.withWorkspace("workflow", first.hash, signal(), async () => assert.fail()), { code: "KNOWLEDGE_WORKSPACE_CHANGED" });
  assert.equal(f.service.snapshot().ready, false);
  const repaired = await f.service.initialize(signal());
  assert.equal(repaired.hash, first.hash); assert.equal(repaired.changed, true);
  assert.equal(readFileSync(file, "utf8"), loadKnowledgeBundle(f.sourceRoot).files["AGENTS.md"]);
  assert.equal(f.store.conversation("local", conversation.id).usability, "usable");
});

test("read leases are concurrent and upgrade waits across multiple service instances sharing the directory lease", async t => {
  const f = knowledgeFixture(t), first = await f.service.initialize(signal()), releaseA = deferred(), releaseB = deferred();
  const other = new KnowledgeService(f.options); await other.initialize(signal());
  let entered = 0, upgraded = false;
  const a = f.service.withWorkspace("workflow", first.hash, signal(), async () => { entered++; await releaseA.promise; });
  const b = other.withWorkspace("script", first.hash, signal(), async () => { entered++; await releaseB.promise; });
  await tick(); assert.equal(entered, 2);
  f.update("upgrade-after-readers");
  const upgrade = other.initialize(signal()).then(result => { upgraded = true; return result; });
  const late = assert.rejects(f.service.withWorkspace("workflow", first.hash, signal(), async () => assert.fail()), { code: "KNOWLEDGE_UNAVAILABLE" });
  await tick(); assert.equal(upgraded, false);
  releaseA.resolve(); await a; await tick(); assert.equal(upgraded, false);
  releaseB.resolve(); await b; const next = await upgrade; await late;
  assert.notEqual(first.hash, next.hash);
  assert.equal(f.service.snapshot().ready, false); // Its cache cannot pretend the old version remains current.
  assert.throws(() => f.service.readFile("AGENTS.md"), { code: "KNOWLEDGE_UNAVAILABLE" });
});

test("cancelled initialization before acquiring the writer lease keeps the healthy workspace usable", async t => {
  const f = knowledgeFixture(t), first = await f.service.initialize(signal()), hold = deferred(), entered = deferred();
  const reader = f.service.withWorkspace("workflow", first.hash, signal(), async () => { entered.resolve(); await hold.promise; });
  await entered.promise;
  const controller = new AbortController(), upgrade = f.service.initialize(controller.signal);
  assert.equal(f.service.snapshot().initializing, true);
  controller.abort(); await assert.rejects(upgrade);
  assert.equal(f.service.snapshot().initializing, false); assert.equal(f.service.snapshot().ready, true);
  await f.service.withWorkspace("script", first.hash, signal(), async () => {});
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(f.service.initialize(alreadyAborted.signal));
  assert.equal(f.service.snapshot().ready, true);
  hold.resolve(); await reader;
});

test("inconsistent database installation/workspace metadata is unavailable until safely reinstalled", async t => {
  const f = knowledgeFixture(t), first = await f.service.initialize(signal());
  f.db.prepare("UPDATE agent_workspaces SET knowledge_hash=? WHERE id='maintenance'").run("b".repeat(64));
  assert.equal(f.service.snapshot().ready, false);
  await assert.rejects(f.service.withWorkspace("workflow", first.hash, signal(), async () => assert.fail()), { code: "KNOWLEDGE_UNAVAILABLE" });
  assert.equal((await f.service.initialize(signal())).hash, first.hash);
  assert.equal(f.service.snapshot().ready, true);
});

test("unconfirmed CLI shutdown blocks all file/database initialization", async t => {
  const f = knowledgeFixture(t);
  f.setStop(async () => { throw new AppError("PROCESS_STOP_UNCONFIRMED", "unknown crash survivor"); });
  await assert.rejects(f.service.initialize(signal()), { code: "PROCESS_STOP_UNCONFIRMED" });
  assert.equal(existsSync(f.workspace), false);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_operations").get()!.n, 0);
  assert.equal(f.service.snapshot().ready, false);
});

test("a queued/uncertain DB turn also blocks activation even if a host incorrectly claims quiescence", async t => {
  const f = knowledgeFixture(t), first = await f.service.initialize(signal()), conversation = multi(f, first.hash);
  const turn = f.store.submit("local", conversation.id, { requestId: "queued", requestHash: "a".repeat(64) }).turn;
  f.update("cannot-hot-replace");
  await assert.rejects(f.service.initialize(signal()), { code: "WORKSPACE_BUSY" });
  assert.equal(loadKnowledgeBundle(f.workspace).hash, first.hash);
  assert.equal(f.store.conversation("local", conversation.id).usability, "usable");
  assert.equal(f.service.snapshot().ready, false);
  f.store.settle("local", turn.id, { generation: 0, status: "cancelled" });
  assert.notEqual((await f.service.initialize(signal())).hash, first.hash);
  assert.equal(f.store.conversation("local", conversation.id).usability, "knowledge_outdated");
});

test("a pre-existing unknown workspace is never adopted or overwritten", async t => {
  const f = knowledgeFixture(t); mkdirSync(f.workspace, { recursive: true }); writeFileSync(join(f.workspace, "user-file"), "preserve me");
  await assert.rejects(f.service.initialize(signal()), { code: "KNOWLEDGE_WORKSPACE_UNOWNED" });
  assert.equal(readFileSync(join(f.workspace, "user-file"), "utf8"), "preserve me");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_operations").get()!.n, 0);
});

test("workspace links/hardlinks cannot redirect cleanup, and release never touches sessions/runtime", async t => {
  const f = knowledgeFixture(t), first = await f.service.initialize(signal());
  const external = join(f.root, "external.md"); writeFileSync(external, "external data");
  for (const name of ["sessions", "runtime"]) { const path = join(f.dataRoot, "agent", name); mkdirSync(path); writeFileSync(join(path, "keep"), name); }
  chmodSync(f.workspace, 0o755); symlinkSync(external, join(f.workspace, "external.md"));
  await assert.rejects(f.service.initialize(signal()), { code: "KNOWLEDGE_PATH_INVALID" });
  assert.equal(readFileSync(external, "utf8"), "external data"); rmSync(join(f.workspace, "external.md"));
  linkSync(external, join(f.workspace, "hardlink.md"));
  await assert.rejects(f.service.initialize(signal()), { code: "KNOWLEDGE_PATH_INVALID" });
  rmSync(join(f.workspace, "hardlink.md"));
  assert.equal((await f.service.initialize(signal())).hash, first.hash);
  for (const name of ["sessions", "runtime"]) assert.equal(readFileSync(join(f.dataRoot, "agent", name, "keep"), "utf8"), name);
});

test("corrupt source fails closed without replacing a ready workspace or leaking internal paths", async t => {
  const f = knowledgeFixture(t), first = await f.service.initialize(signal());
  writeFileSync(join(f.sourceRoot, "AGENTS.md"), "bad package");
  await assert.rejects(f.service.initialize(signal()), error => error instanceof AppError && error.code === "KNOWLEDGE_BUNDLE_INVALID" && !error.message.includes(f.root));
  assert.equal(loadKnowledgeBundle(f.workspace).hash, first.hash);
  assert.equal(f.service.snapshot().ready, false);
  await assert.rejects(f.service.withWorkspace("workflow", first.hash, signal(), async () => assert.fail()), { code: "KNOWLEDGE_UNAVAILABLE" });
});

for (const phase of ["preparing", "staged", "displaced", "activated", "committed"] as const) {
  test(`installation fault at ${phase} never exposes a half-written workspace and is retryable`, async t => {
    const f = knowledgeFixture(t), first = await f.service.initialize(signal()); f.update(`fault-${phase}`);
    const service = new KnowledgeService({ ...f.options, onBoundary: boundary => { if (boundary === phase) throw new Error("injected fault"); } });
    await assert.rejects(service.initialize(signal()), { code: "KNOWLEDGE_IO_FAILED" });
    assert.equal(service.snapshot().ready, false);
    assert.equal(loadKnowledgeBundle(f.workspace).hash, phase === "committed" ? loadKnowledgeBundle(f.sourceRoot).hash : first.hash);
    assert.deepEqual(readdirSync(f.staging), []);
    const retried = new KnowledgeService(f.options); await retried.initialize(signal());
    assert.equal(retried.snapshot().ready, true);
    assert.equal(loadKnowledgeBundle(f.workspace).hash, loadKnowledgeBundle(f.sourceRoot).hash);
  });
}

test("restart recovers an interrupted rename from the exact persisted operation, then installs the current package", async t => {
  const f = knowledgeFixture(t); await f.service.initialize(signal()); f.update("restart-new-bundle");
  const bundle = loadKnowledgeBundle(f.sourceRoot), id = randomUUID(); f.host.begin(id, bundle, true);
  const stage = join(f.staging, `knowledge-${id}`), previous = join(f.staging, `previous-${id}`);
  cpSync(f.sourceRoot, stage, { recursive: true });
  chmodSync(f.workspace, 0o700); renameSync(f.workspace, previous); chmodSync(previous, 0o555);
  writeFileSync(join(f.staging, "knowledge-install.json"), JSON.stringify({ formatVersion: 1, id, hash: bundle.hash, hadWorkspace: true, phase: "displaced" }));
  const restarted = new KnowledgeService(f.options); await restarted.initialize(signal());
  assert.equal(restarted.snapshot().hash, bundle.hash); assert.deepEqual(readdirSync(f.staging), []);
  assert.equal(f.db.prepare("SELECT status FROM agent_operations WHERE id=?").get(id)!.status, "failed");
});

test("restart after database commit only cleans the exact previous copy and does not repeat installation", async t => {
  const f = knowledgeFixture(t); await f.service.initialize(signal()); const old = loadKnowledgeBundle(f.workspace);
  f.update("committed-restart"); const current = await f.service.initialize(signal());
  const row = f.db.prepare("SELECT id FROM agent_operations WHERE kind='knowledge_install' AND request_hash=?").get(current.hash)!;
  const id = String(row.id), previous = join(f.staging, `previous-${id}`); mkdirSync(previous);
  for (const [relative, text] of Object.entries({ ...old.files, "manifest.json": old.manifestText })) {
    const target = join(previous, relative); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text);
  }
  writeFileSync(join(f.staging, "knowledge-install.json"), JSON.stringify({ formatVersion: 1, id, hash: current.hash, hadWorkspace: true, phase: "activated" }));
  const restarted = new KnowledgeService(f.options), result = await restarted.initialize(signal());
  assert.equal(result.changed, false); assert.equal(result.hash, current.hash);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_operations WHERE kind='knowledge_install'").get()!.n, 2);
  assert.deepEqual(readdirSync(f.staging), []);
});

test("forged/corrupt journal and missing journal with known staging are diagnostic failures, not cleanup permissions", async t => {
  const f = knowledgeFixture(t); await f.service.initialize(signal());
  const journal = join(f.staging, "knowledge-install.json");
  writeFileSync(journal, JSON.stringify({ formatVersion: 1, id: randomUUID(), hash: "a".repeat(64), hadWorkspace: true, phase: "activated" }));
  await assert.rejects(new KnowledgeService(f.options).initialize(signal()), { code: "KNOWLEDGE_JOURNAL_INVALID" });
  assert.ok(existsSync(journal)); rmSync(journal);
  const bundle = loadKnowledgeBundle(f.sourceRoot), id = randomUUID(); f.host.begin(id, bundle, true);
  const stage = join(f.staging, `knowledge-${id}`); mkdirSync(stage); writeFileSync(join(stage, "keep"), "unconfirmed stage");
  await assert.rejects(new KnowledgeService(f.options).initialize(signal()), { code: "KNOWLEDGE_RECOVERY_REQUIRED" });
  assert.equal(readFileSync(join(stage, "keep"), "utf8"), "unconfirmed stage");
});

test("unknown staging roots remain untouched and stale persisted operations cannot commit a new installation", async t => {
  const f = knowledgeFixture(t); await f.service.initialize(signal());
  const unrelated = join(f.staging, "unknown-owner"); mkdirSync(unrelated); writeFileSync(join(unrelated, "keep"), "not an installation");
  const bundle = loadKnowledgeBundle(f.sourceRoot), first = randomUUID(); f.host.begin(first, bundle, true);
  assert.throws(() => f.host.begin(randomUUID(), bundle, true), { code: "KNOWLEDGE_OPERATION_ACTIVE" });
  f.host.fail(first, "interrupted"); const second = randomUUID(); f.host.begin(second, bundle, true);
  assert.throws(() => f.host.commit(first, bundle), { code: "KNOWLEDGE_OPERATION_CONFLICT" });
  f.host.fail(second, "test-complete"); await f.service.initialize(signal());
  assert.equal(readFileSync(join(unrelated, "keep"), "utf8"), "not an installation");
});
