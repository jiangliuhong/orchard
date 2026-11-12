import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setup, prepareMaintenanceFixture } from "./helpers.js";
import { WorkspaceInstaller } from "../src/agent/workspace-installer.js";
import { buildWorkspaceProjection } from "../src/agent/workspace-projection.js";
import { ScopedWorkspaceReader } from "../src/agent/workspace-files.js";
import { configCoordinator } from "../src/config-git/coordinator.js";
import { AppError } from "../src/domain/errors.js";
const K = "b".repeat(64), signal = () => new AbortController().signal;
async function fixture(t: TestContext) {
  let root: string | undefined;
  // Register before setup's temp-directory cleanup: macOS cannot recursively
  // unlink files from the deliberately 0555 directories without restoring mode.
  t.after(() => {
    const visit = (path: string) => {
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
      chmodSync(path, 0o700); for (const name of readdirSync(path)) visit(join(path, name));
    };
    if (root) visit(root);
  });
  const { store, authoring } = setup(t); root = store.root; t.after(async () => { await authoring.close(); store.close(); });
  prepareMaintenanceFixture(store);
  store.exec("INSERT INTO agent_workspace_projection_state VALUES('maintenance',1,0,?,NULL,NULL,'pending',NULL,?)", K, Date.now());
  let value = "first", stopped = true, fault: string | undefined;
  const options = { knowledgeHash: K, rules: { "AGENTS.md": "# Platform rules", ".agents/skills/maintenance/SKILL.md": "# Maintenance" },
    async source() { return buildWorkspaceProjection({ resources: [{ state: "draft", snapshot: { kind: "script", id: "sample", version: "draft-1", revision: "1", name: "Sample", definition: { name: "Sample" }, files: { "main.ts": value + "\nsecond line\nthird line" } } }], applications: [], knownSecrets: [] }); },
    assertQuiescent() { if (!stopped) throw new AppError("PROCESS_STOP_UNCONFIRMED", "running", 409); },
    onBoundary(phase: string) { if (phase === fault) throw new Error("injected boundary failure"); },
  };
  const installer = new WorkspaceInstaller(store, options);
  return { store, installer, options, setValue(v: string) { value = v; store.exec("UPDATE agent_workspace_projection_state SET target_generation=target_generation+1,state='pending'"); }, stopped(v: boolean) { stopped = v; }, fault(v?: string) { fault = v; } };
}

test("installer composes package and business files, verifies readonly tree, shares one cwd and revokes readers", async t => {
  const f = await fixture(t), installed = await f.installer.synchronize(signal()); assert.equal(installed.changed, true);
  const second = new WorkspaceInstaller(f.store, f.options);
  assert.equal((await second.synchronize(signal())).changed, false);
  let escaped!: ScopedWorkspaceReader;
  await f.installer.withReader(signal(), async reader => {
    escaped = reader;
    assert.equal(reader.read("scripts/sample/draft/src/main.ts", 2, 1).content, "second line");
    assert.equal(reader.readBuffer(join(reader.cwd, "AGENTS.md")).toString(), "# Platform rules");
    assert.ok(reader.find("scripts/*/src/*.ts").items.includes("scripts/sample/draft/src/main.ts"));
    assert.ok(reader.ls().items.some(entry => entry.name === "scripts" && entry.directory));
    assert.equal(reader.grep("second").items[0]!.line, 2);
    for (const path of ["../workbench.db", "/etc/passwd", "scripts/../../workbench.db", "secrets/value", "scripts\\sample"]) assert.throws(() => reader.readBuffer(path), /越界|之外|不存在|无效/);
    assert.throws(() => configCoordinator(f.store).withWrite(() => {}), { code: "CONFIG_BUSY" });
    await assert.rejects(second.withReader(signal(), async () => {}), { code: "WORKSPACE_BUSY" });
    await assert.rejects(second.synchronize(signal()), { code: "WORKSPACE_BUSY" });
  });
  assert.throws(() => escaped.readBuffer("AGENTS.md"), { code: "WORKSPACE_LEASE_EXPIRED" });
  assert.equal(existsSync(join(f.store.root, "agent/sessions")), false);
});

test("ordinary content/permission drift blocks reads and rebuilds only from the authoritative source", async t => {
  const f = await fixture(t); await f.installer.synchronize(signal());
  const file = join(f.installer.cwd, "scripts/sample/draft/src/main.ts"); chmodSync(file, 0o600); writeFileSync(file, "tampered");
  await assert.rejects(f.installer.withReader(signal(), async () => {}), { code: "WORKSPACE_CHANGED" });
  assert.equal((await f.installer.synchronize(signal())).changed, true);
  assert.match(readFileSync(file, "utf8"), /^first/);
});

test("pre-existing unknown directory, symlinks and hardlinks do not become workspace ownership or cleanup permission", async t => {
  const f = await fixture(t), directory = join(f.store.root, "agent/workspace"); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "private.txt"), "DO_NOT_ADOPT");
  await assert.rejects(f.installer.synchronize(signal()), { code: "WORKSPACE_UNOWNED" });
  assert.equal(readFileSync(join(directory, "private.txt"), "utf8"), "DO_NOT_ADOPT");
  // Another fresh fixture tests attacks against a genuinely owned workspace.
  const owned = await fixture(t); await owned.installer.synchronize(signal());
  const file = join(owned.installer.cwd, "AGENTS.md"), outside = join(owned.store.root, "outside-marker"); writeFileSync(outside, "OUTSIDE");
  chmodSync(owned.installer.cwd, 0o700); unlinkSync(file); symlinkSync(outside, file);
  await assert.rejects(owned.installer.withReader(signal(), async () => {}), { code: "WORKSPACE_CHANGED" });
  await assert.rejects(owned.installer.synchronize(signal()), { code: "WORKSPACE_PATH_DENIED" });
  unlinkSync(file); linkSync(outside, file);
  await assert.rejects(owned.installer.synchronize(signal()), { code: "WORKSPACE_PATH_DENIED" });
  assert.equal(readFileSync(outside, "utf8"), "OUTSIDE");
});

test("every activation failure remains gated and a new installer repairs current DB state without replaying business changes", async t => {
  for (const phase of ["staged", "displaced", "activated"]) await t.test(phase, async t => {
    const f = await fixture(t); await f.installer.synchronize(signal()); f.setValue("new database source"); f.fault(phase);
    await assert.rejects(f.installer.synchronize(signal()), { code: "WORKSPACE_IO_FAILED" });
    await assert.rejects(f.installer.withReader(signal(), async () => {}), { code: "WORKSPACE_NOT_READY" });
    f.fault(); const restarted = new WorkspaceInstaller(f.store, f.options); await restarted.synchronize(signal());
    await restarted.withReader(signal(), async reader => { assert.match(reader.read("scripts/sample/draft/src/main.ts").content, /^new database source/); });
    assert.equal(f.store.one<{ target_generation: number }>("SELECT target_generation FROM agent_workspace_projection_state")!.target_generation, 2);
  });
});

test("first activation crash has authenticated DB ownership intent and can recover without adopting arbitrary directories", async t => {
  const f = await fixture(t); f.fault("activated");
  await assert.rejects(f.installer.synchronize(signal()), { code: "WORKSPACE_IO_FAILED" });
  assert.equal(existsSync(join(f.store.root, "agent/tmp/workspace-allocation.json")), true);
  f.fault(); const restarted = new WorkspaceInstaller(f.store, f.options);
  assert.equal((await restarted.synchronize(signal())).changed, false);
  assert.equal(existsSync(join(f.store.root, "agent/tmp/workspace-allocation.json")), false);
});

test("unknown staging is retained; a forged ownership journal cannot adopt an unowned workspace", async t => {
  const f = await fixture(t); await f.installer.synchronize(signal());
  const orphan = join(f.store.root, "agent/tmp/unknown-project"); mkdirSync(orphan); writeFileSync(join(orphan, "marker"), "KEEP");
  f.setValue("new"); await f.installer.synchronize(signal()); assert.equal(readFileSync(join(orphan, "marker"), "utf8"), "KEEP");
  const unknown = await fixture(t); mkdirSync(join(unknown.store.root, "agent/workspace"), { recursive: true }); mkdirSync(join(unknown.store.root, "agent/tmp"));
  writeFileSync(join(unknown.store.root, "agent/tmp/workspace-allocation.json"), JSON.stringify({ id: "00000000-0000-0000-0000-000000000000" }));
  await assert.rejects(unknown.installer.synchronize(signal()), { code: "WORKSPACE_JOURNAL_INVALID" });
});

test("unconfirmed task exit keeps the global maintenance barrier closed until explicit proven recovery", async t => {
  const f = await fixture(t); await f.installer.synchronize(signal());
  await assert.rejects(f.installer.withReader(signal(), async () => { f.stopped(false); }), { code: "PROCESS_STOP_UNCONFIRMED" });
  assert.throws(() => configCoordinator(f.store).withWrite(() => {}), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(f.installer.recover(signal()), { code: "PROCESS_STOP_UNCONFIRMED" });
  f.stopped(true); await f.installer.recover(signal()); configCoordinator(f.store).withWrite(() => {});
});
