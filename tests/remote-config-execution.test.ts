import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { TestStore, temporary, until } from "./helpers.js";
import { KeyringStore, resolveKeyringPath } from "../src/secrets/keyring.js";
import { CommandHmac } from "../src/secrets/command-hmac.js";
import { SecretsService } from "../src/secrets/service.js";
import { DictionaryService } from "../src/dictionaries/service.js";
import { ConfigGitService } from "../src/config-git/service.js";
import { ConfigRestoreService } from "../src/config-git/restore.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { GraphRunner } from "../src/runtime/runner.js";
import { DictionaryExecution, REDACTED } from "../src/dictionaries/execution.js";
import { createApp } from "../src/server/app.js";
import type { Workflow } from "../src/domain/types.js";
import type { ScriptDefinition } from "../src/domain/scripts.js";

function publishWorkflow(store: TestStore, definition: Workflow) {
  const tree = store.files.saveTree({ "workflow.json": JSON.stringify(definition), "layout.json": "{}" });
  const id = randomUUID(), now = Date.now();
  store.exec("INSERT INTO workflows VALUES(?,?,NULL,?,?)", definition.id, definition.name, now, now);
  store.exec("INSERT INTO workflow_versions VALUES(?,?,?,?,?,?,?,?)", id, definition.id, 1, JSON.stringify(definition), "{}", tree.path, tree.hash, now);
  store.exec("UPDATE workflows SET current_version_id=? WHERE id=?", id, definition.id);
  return id;
}
function management(store: TestStore) {
  const keyring = new KeyringStore(resolveKeyringPath(store.root));
  const secrets = new SecretsService(store, keyring, new CommandHmac(store, store.root, keyring));
  return { keyring, secrets, dictionaries: new DictionaryService(store, secrets) };
}
function assertFilesExclude(root: string, forbidden: string[]) {
  for (const name of readdirSync(root)) {
    const path = join(root, name), info = lstatSync(path);
    if (info.isDirectory()) assertFilesExclude(path, forbidden);
    else if (info.isFile()) {
      const content = readFileSync(path);
      for (const value of forbidden) assert.ok(!content.includes(Buffer.from(value)), `Sensitive value found in ${path}`);
    }
  }
}

test("two isolated devices transfer keys independently, restore a real Git snapshot, execute fixed scripts safely and preserve pinned dictionary revisions", { timeout: 60000 }, async t => {
  const root = temporary(t), remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  const a = new TestStore(join(root, "A")), b = new TestStore(join(root, "B"));
  const ar = new ConfigRestoreService(a), br = new ConfigRestoreService(b);
  const options = { testTransport: () => remote };
  const ag = new ConfigGitService(a, new WebBridgeConfig(a.root), ar, options);
  const bg = new ConfigGitService(b, new WebBridgeConfig(b.root), br, options);
  const providers = new ProviderRegistry(b), runner = new GraphRunner(b, providers, undefined, false);
  let app: ReturnType<typeof createApp>["app"] | undefined;
  t.after(async () => { await runner.close(); await ag.close(); await bg.close(); if (app) await app.close(); else b.close(); a.close(); });
  const am = management(a), bm = management(b);
  const secret = `credential-${randomUUID()}-雪\nsecond-line`, replacement = `rotated-${randomUUID()}`;
  am.secrets.generate({ requestId: "generate-A", expectedGeneration: 0 });
  const plain = am.dictionaries.create({ requestId: "plain-A", name: "Endpoints", description: "Portable execution config", kind: "plain", enabled: true, operations: [{ op: "set", key: "label", type: "string", value: "A-first" }] });
  const encrypted = am.dictionaries.create({ requestId: "encrypted-A", name: "Credentials", description: "", kind: "encrypted", enabled: true, operations: [{ op: "set", key: "apiToken", type: "string", value: secret }] });
  const definition: ScriptDefinition = {
    id: "portable-script", name: "Portable script", description: "", runtime: "nodejs", entryFile: "main.ts", inputSchema: true, outputSchema: true,
    dictionaryBindings: { settings: { dictionaryId: plain.dictionaryId, kind: "plain", keys: ["label"] }, credentials: { dictionaryId: encrypted.dictionaryId, kind: "encrypted", keys: ["apiToken"] } },
    files: { "main.ts": `export default (input, ctx) => {
      const label = ctx.dictionaries.get("settings", "label");
      const token = ctx.secrets.get("credentials", "apiToken");
      if (label !== input.label || !token.startsWith(input.prefix)) throw new Error("Transferred dictionary values did not match");
      console.log(token); console.error(token);
      return { label, token };
    };` },
  };
  const { files, ...metadata } = definition, tree = a.files.saveScriptTree(files, metadata);
  const created = a.createScript(definition, tree.path, tree.hash), scriptVersion = a.publishScript(definition.id, created.version.revision).version;
  const secretWorkflow: Workflow = { formatVersion: 1, id: "portable-secret-workflow", name: "Portable secret workflow", inputSchema: true, outputSchema: true, entryNodeId: "call", nodes: [{ id: "call", name: "Call fixed script", type: "script", input: { source: "workflow" }, outputSchema: true, config: { scriptId: definition.id, scriptVersionId: scriptVersion.id } }], edges: [], result: { source: "node", nodeId: "call" } };
  const secretVersion = publishWorkflow(a, secretWorkflow);
  const plainWorkflow: Workflow = { formatVersion: 1, id: "portable-plain-workflow", name: "Portable plain workflow", inputSchema: true, outputSchema: { type: "string" }, entryNodeId: "call", nodes: [{ id: "call", name: "Read plain value", type: "script", input: { source: "workflow" }, outputSchema: true, config: { scriptId: definition.id, scriptVersionId: scriptVersion.id } }], edges: [], result: { source: "dictionary", dictionaryId: plain.dictionaryId, key: "label" } };
  // Use an ordinary fixed script for the public result workflow, proving both output policies.
  const identity: ScriptDefinition = { id: "plain-identity", name: "Plain identity", description: "", runtime: "nodejs", entryFile: "main.ts", inputSchema: true, outputSchema: true, files: { "main.ts": "export default x => x;" } };
  const { files: identityFiles, ...identityMetadata } = identity, identityTree = a.files.saveScriptTree(identityFiles, identityMetadata);
  const identityCreated = a.createScript(identity, identityTree.path, identityTree.hash), identityVersion = a.publishScript(identity.id, identityCreated.version.revision).version;
  plainWorkflow.nodes[0]!.config = { scriptId: identity.id, scriptVersionId: identityVersion.id };
  const plainVersion = publishWorkflow(a, plainWorkflow);
  await ag.repository.bind({ remoteUrl: "https://fixture.invalid/portable.git", branch: "main", identity: { name: "Device A", email: "a@fixture.invalid" } });
  const backup = await ag.commitPreview({ theme: "dark", message: "Portable dictionaries and fixed scripts", push: true });
  assert.deepEqual(backup.blockers, []);
  const committed = await ag.commit({ requestId: "push-A", token: backup.token, theme: "dark" }); assert.ok(committed.pushed);
  await bg.repository.bind({ remoteUrl: "https://fixture.invalid/portable.git", branch: "main", identity: { name: "Device B", email: "b@fixture.invalid" } });
  const source = await bg.remoteSyncSource(); assert.equal(source.sourceSha, committed.sha); assert.equal(source.snapshotState, "valid"); assert.ok(source.supportedCategories.includes("dictionaries"));
  const locked = await bg.restorePreview({ source: { kind: "git", sha: source.sourceSha }, categories: ["workflows"] });
  assert.ok(locked.blockerDetails.some(item => item.code === "SECRET_KEY_MISSING")); assert.equal(b.all("SELECT id FROM dictionaries").length, 0);
  const keyBackup = am.secrets.exportBackup({ expectedGeneration: am.secrets.status().generation });
  bm.secrets.import({ requestId: "independent-key-transfer", expectedGeneration: 0, backupText: keyBackup.body, activeKeyId: am.keyring.activeKeyId()! });
  assert.notEqual(am.keyring.path, bm.keyring.path);
  const preview = await bg.restorePreview({ source: { kind: "git", sha: source.sourceSha }, categories: ["workflows"] });
  assert.deepEqual(preview.blockers, []); assert.ok(preview.categories.includes("scripts")); assert.ok(preview.categories.includes("dictionaries"));
  const applied = await bg.apply({ requestId: "restore-B", token: preview.token }); assert.equal(applied.result!.sourceSha, source.sourceSha);
  assert.equal(b.script(definition.id).currentPublishedVersionId, scriptVersion.id);
  const old = runner.create(plainVersion, {}, "queued-first");
  const beforeSync = runner.create(secretVersion, { label: "A-first", prefix: "credential-" }, "queued-secret-first");
  assert.equal(old.status, "queued"); assert.equal(new DictionaryExecution(b).metadata("run", old.id)[0]!.versionId, plain.versionId);
  const aPlainNext = am.dictionaries.update(plain.dictionaryId, { requestId: "plain-A-next", expectedRevision: 1, operations: [{ op: "set", key: "label", type: "string", value: "A-second" }] });
  const aSecretNext = am.dictionaries.update(encrypted.dictionaryId, { requestId: "secret-A-next", expectedRevision: 1, operations: [{ op: "set", key: "apiToken", type: "string", value: replacement }] });
  const nextBackup = await ag.commitPreview({ theme: "dark", message: "Updated dictionary versions", push: true });
  await ag.commit({ requestId: "push-A-next", token: nextBackup.token, theme: "dark" });
  const nextSource = await bg.remoteSyncSource();
  await assert.rejects(bg.restorePreview({ source: { kind: "git", sha: nextSource.sourceSha }, categories: ["dictionaries"] }), { code: "CONFIG_BUSY" });
  // Ordinary edits may coexist with a queue; this also proves that execution does not read the mutable current pointer.
  bm.dictionaries.update(plain.dictionaryId, { requestId: "B-local-edit", expectedRevision: 1, operations: [{ op: "set", key: "label", type: "string", value: "B-local-current" }] });
  bm.dictionaries.update(encrypted.dictionaryId, { requestId: "B-local-secret-edit", expectedRevision: 1, operations: [{ op: "set", key: "apiToken", type: "string", value: replacement }] });
  runner.start();
  await until(() => ["succeeded", "failed"].includes(b.run(old.id).status)); assert.equal(b.run(old.id).status, "succeeded", JSON.stringify(b.run(old.id).error)); assert.equal(b.run(old.id).output, "A-first");
  await until(() => ["succeeded", "failed"].includes(b.run(beforeSync.id).status)); assert.equal(b.run(beforeSync.id).status, "succeeded", JSON.stringify(b.run(beforeSync.id).error)); assert.deepEqual(b.run(beforeSync.id).output, REDACTED);
  // Completion event persistence precedes release of the maintenance barrier by one microtask.
  await new Promise(resolve => setImmediate(resolve));
  const latest = await bg.restorePreview({ source: { kind: "git", sha: nextSource.sourceSha }, categories: ["dictionaries"] }); assert.deepEqual(latest.blockers, []);
  await bg.apply({ requestId: "restore-latest-B", token: latest.token });
  assert.equal(b.one("SELECT current_version_id FROM dictionaries WHERE id=?", plain.dictionaryId)!.current_version_id, aPlainNext.versionId);
  assert.equal(b.one("SELECT current_version_id FROM dictionaries WHERE id=?", encrypted.dictionaryId)!.current_version_id, aSecretNext.versionId);
  assert.equal(new DictionaryExecution(b).metadata("run", old.id)[0]!.versionId, plain.versionId);
  assert.ok(new DictionaryExecution(b).metadata("run", beforeSync.id).some(v => v.versionId === encrypted.versionId));
  assert.ok(new DictionaryExecution(b).metadata("run", beforeSync.id).some(v => v.versionId === plain.versionId));
  const currentPlain = runner.create(plainVersion, {}, "latest-plain"), currentSecret = runner.create(secretVersion, { label: "A-second", prefix: "rotated-" }, "latest-secret");
  await until(() => [currentPlain, currentSecret].every(run => ["succeeded", "failed"].includes(b.run(run.id).status)));
  assert.equal(b.run(currentPlain.id).status, "succeeded"); assert.equal(b.run(currentPlain.id).output, "A-second");
  assert.equal(b.run(currentSecret.id).status, "succeeded", JSON.stringify(b.run(currentSecret.id).error)); assert.deepEqual(b.run(currentSecret.id).output, REDACTED);
  const fixed = new DictionaryExecution(b).metadata("run", currentSecret.id); assert.ok(fixed.some(v => v.versionId === aSecretNext.versionId));
  for (const run of [beforeSync, currentSecret]) {
    const safe = JSON.stringify({ snapshot: runner.snapshot(run.id), events: b.stream("run", run.id) });
    assert.ok(!safe.includes(secret)); assert.ok(!safe.includes(replacement)); assert.ok(!b.stream("run", run.id).some(e => e.type === "node.log"));
    assert.deepEqual(b.nodes(run.id)[0]!.output, REDACTED);
  }
  const tables = b.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) {
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
    const data = JSON.stringify(b.all(`SELECT * FROM ${name}`));
    for (const value of [secret, replacement]) assert.ok(!data.includes(value) && !data.includes(JSON.stringify(value).slice(1, -1)), `Sensitive plaintext in table ${name}`);
  }
  assertFilesExclude(root, [secret, replacement]);
  assert.equal(readdirSync(b.files.path("runs")).some(name => name.startsWith("script-attempt-")), false);
  await runner.close();
  app = createApp(b, providers, undefined, undefined, options).app; await app.ready();
  const response = await app.inject(`/api/runs/${currentSecret.id}`); assert.equal(response.statusCode, 200); assert.ok(!response.body.includes(replacement));
  const listeners = b.events.listenerCount("event");
  const sse = app.inject(`/api/runs/${currentSecret.id}/stream`);
  await until(() => b.events.listenerCount("event") > listeners);
  await app.close();
  const wire = await sse; assert.equal(wire.headers["content-type"], "text/event-stream"); assert.ok(wire.body.includes("run.succeeded")); assert.ok(wire.body.includes("orchardRedacted")); assert.ok(!wire.body.includes(replacement)); assert.ok(!wire.body.includes(secret));
});
