import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { TestStore, temporary } from "./helpers.js";
import { ConfigRestoreService } from "../src/config-git/restore.js";
import { ConfigGitService } from "../src/config-git/service.js";
import { captureSnapshot } from "../src/config-git/restore-import.js";
import { serializeSnapshot, parseSnapshot, exportSnapshot, type PortableSnapshot, type PortableDictionary } from "../src/config-git/snapshot.js";
import { localReference } from "../src/config-git/snapshot-primitives.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { KeyringStore, resolveKeyringPath } from "../src/secrets/keyring.js";
import { generateKeyMaterial, encryptValue } from "../src/secrets/aead.js";
import type { Workflow } from "../src/domain/types.js";

function setup(t: test.TestContext) {
  const root = temporary(t), store = new TestStore(join(root, "data"));
  t.after(() => store.close());
  return { root, store, restore: new ConfigRestoreService(store) };
}
function plain(): PortableDictionary {
  const id = randomUUID(), versionId = randomUUID();
  return { id, kind: "plain", currentVersionId: versionId, versions: [{ id: versionId, dictionaryId: id, kind: "plain", name: "Config", description: "", enabled: true, entries: { current: { type: "string", value: "ok" } } }] };
}
function snapshot(d = plain()): PortableSnapshot {
  return { general: { theme: "dark" }, providers: [], webBridge: { applications: {}, environments: {}, tools: {}, enabledTools: {} }, scripts: [], workflows: [], dictionaries: [d] };
}
function workflow(dictionaryId: string, key = "current"): Workflow {
  return { formatVersion: 1, id: "review-workflow", name: "Review", inputSchema: true, outputSchema: true, entryNodeId: "code", nodes: [{ id: "code", name: "code", type: "code.nodejs", input: { source: "dictionary", dictionaryId, key }, outputSchema: true, config: { script: "scripts/main.ts" } }], edges: [], result: { source: "node", nodeId: "code" } };
}
function files(w: Workflow) { return { "workflow.json": JSON.stringify(w), "layout.json": "{}", "scripts/main.ts": "export default x => x;\n" }; }
function addWorkflow(s: PortableSnapshot, versions: { id: string; workflow: Workflow }[], current: string) {
  s.workflows.push({ id: "review-workflow", name: "Review", currentPublishedVersionId: current, draft: null, versions: versions.map(v => ({ id: v.id, files: files(v.workflow) })) });
}
function encrypted(store: TestStore) {
  const material = generateKeyMaterial(), keyId = randomUUID(), keyring = new KeyringStore(resolveKeyringPath(store.root));
  keyring.save({ formatVersion: 1, generation: 1, keys: [{ keyId, algorithm: "aes-256-gcm", material: material.toString("base64"), createdAt: 1 }], operations: [] });
  const d = plain(); d.kind = "encrypted"; d.versions[0]!.kind = "encrypted";
  d.versions[0]!.entries = { credential: { type: "string", encryptedValue: encryptValue(material, { keyId, dictionaryId: d.id, key: "credential" }, "never-print-this") } };
  return { d, keyring };
}

test("historical removed keys and pointers preserve immutable versions and do not block recovery points", async t => {
  const { store, restore } = setup(t), s = snapshot(), d = s.dictionaries![0]!;
  const historical = workflow(d.id, "removed"); historical.result = { source: "dictionary", dictionaryId: d.id, key: "removed", pointer: "/also-removed" };
  addWorkflow(s, [{ id: "old-workflow", workflow: historical }, { id: "current-workflow", workflow: workflow(d.id) }], "current-workflow");
  const helper = { id: "helper", name: "Helper", description: "", runtime: "nodejs" as const, entryFile: "main.ts", inputSchema: true, outputSchema: true, files: { "main.ts": "export default x => x;\n" } };
  s.scripts.push({ id: "helper", name: "Helper", description: "", runtime: "nodejs", archived: false, currentPublishedVersionId: "helper-new", draft: null, versions: [{ id: "helper-old", definition: { ...helper, dictionaryBindings: { config: { dictionaryId: d.id, kind: "plain", keys: ["removed"] } } } }, { id: "helper-new", definition: helper }] });
  const parsed = parseSnapshot(serializeSnapshot(s).files);
  await restore.apply("initial", (await restore.preview(parsed)).token);
  assert.equal(store.versions("review-workflow").length, 2);
  assert.equal(store.scriptVersions("helper").length, 2);
  const captured = captureSnapshot(store, "dark").snapshot;
  assert.equal((await restore.preview(captured, { categories: ["dictionaries"] })).changes[0]!.changeType, "same");
  assert.doesNotThrow(() => exportSnapshot(store, { ...s.webBridge }, "dark"));
  const next = snapshot({ ...d, currentVersionId: "new-dictionary-version", versions: [{ ...d.versions[0]!, id: "new-dictionary-version", description: "changed" }] });
  const applied = await restore.apply("change", (await restore.preview(next, { categories: ["dictionaries"] })).token);
  const undo = await restore.previewRecoveryPoint(applied.recoveryPointId);
  await restore.apply("undo", undo.token);
  assert.equal(store.one("SELECT current_version_id FROM dictionaries WHERE id=?", d.id)!.current_version_id, d.currentVersionId);
  assert.equal(store.versions("review-workflow").length, 2);
  assert.equal(store.scriptVersions("helper").length, 2);
});

test("current workflow resolves historical fixed script dependencies even when current script has none", async t => {
  const { store, restore } = setup(t), s = snapshot(), d = s.dictionaries![0]!;
  const definition = { id: "helper", name: "Helper", description: "", runtime: "nodejs" as const, entryFile: "main.ts", inputSchema: true, outputSchema: true, files: { "main.ts": "export default x => x;\n" } };
  s.scripts.push({ id: "helper", name: "Helper", description: "", runtime: "nodejs", archived: false, currentPublishedVersionId: "helper-new", draft: null, versions: [{ id: "helper-old", definition: { ...definition, dictionaryBindings: { config: { dictionaryId: d.id, kind: "plain", keys: ["current"] } } } }, { id: "helper-new", definition }] });
  const w = workflow(d.id); w.nodes[0]!.type = "script"; w.nodes[0]!.input = { source: "workflow" }; w.nodes[0]!.config = { scriptId: "helper", scriptVersionId: "helper-old" };
  addWorkflow(s, [{ id: "current-workflow", workflow: w }], "current-workflow");
  const bundle = serializeSnapshot(s), parsed = parseSnapshot(bundle.files);
  assert.equal(parsed.scripts[0]!.versions.length, 2);
  const dep = bundle.manifest.objects.find(o => o.category === "workflows")!.dependencies.find(d => d.category === "dictionaries");
  assert.ok(dep && dep.category === "dictionaries" && dep.keys.includes("current"));
  const missing = structuredClone(s); missing.dictionaries![0]!.versions[0]!.entries = {};
  await assert.rejects(restore.preview(missing, { categories: ["workflows"] }), { code: "DEPENDENCY_MISSING" });
  assert.throws(() => serializeSnapshot(missing), { code: "DICTIONARY_KEY_MISSING" });
  await restore.apply("fixed", (await restore.preview(parsed)).token);
  const exported = exportSnapshot(store, { ...s.webBridge }, "dark");
  assert.ok(exported.snapshot.scripts[0]!.versions.some(v => v.id === "helper-old"));
  assert.ok(exported.snapshot.scripts[0]!.versions.some(v => v.id === "helper-new"));
});

for (const historical of [false, true]) test(`sensitive Agent successor is rejected for ${historical ? "historical" : "current"} published workflows`, async t => {
  const { store, restore } = setup(t), { d } = encrypted(store), s = snapshot(d);
  const ref = localReference("providers", "pi-cli", "executable");
  s.providers.push({ id: "pi-cli", enabled: true, config: { executable: ref, transport: "native" }, defaultModel: "model", models: [{ id: "model", name: "model", source: "configured", enabled: true, deleted: false }], agentModelConfigs: [{ id: "review-model", name: "Review model", description: "", modelId: "model", enabled: true }] });
  const w = workflow(d.id); w.nodes[0]!.input = { source: "workflow" }; w.nodes[0]!.config.dictionaryBindings = { auth: { dictionaryId: d.id, kind: "encrypted", keys: ["credential"] } };
  w.nodes.push({ id: "agent", name: "agent", type: "agent", input: { source: "node", nodeId: "code" }, outputSchema: true, config: { prompt: "x", agentConfigId: "review-model" } });
  w.edges.push({ id: "e", from: "code", to: "agent" }); w.result = { source: "node", nodeId: "agent" };
  addWorkflow(s, [{ id: "unsafe", workflow: w }], "unsafe");
  if (historical) { const safe = workflow(d.id); safe.nodes[0]!.input = { source: "workflow" }; s.workflows[0]!.versions.push({ id: "safe", files: files(safe) }); s.workflows[0]!.currentPublishedVersionId = "safe"; d.versions[0]!.enabled = false; }
  assert.throws(() => serializeSnapshot(s), { code: "SECRET_SINK_FORBIDDEN" });
  await assert.rejects(restore.preview(s, { categories: ["providers", "workflows"], mappings: { [ref.localRef]: "/usr/bin/true" } }), { code: "SECRET_SINK_FORBIDDEN" });
  assert.equal(store.all("SELECT id FROM workflow_versions").length, 0);
});

for (const boundary of ["prepared", "transaction"]) test(`key change at ${boundary} rolls back dictionary updates and successful receipts`, async t => {
  const { store, restore } = setup(t), { d, keyring } = encrypted(store), s = snapshot(d);
  await restore.apply("initial", (await restore.preview(s, { categories: ["dictionaries"] })).token);
  const next = structuredClone(s); next.dictionaries![0]!.currentVersionId = "new-version"; next.dictionaries![0]!.versions[0]!.id = "new-version"; next.dictionaries![0]!.versions[0]!.description = "changed";
  const guarded = new ConfigRestoreService(store, undefined, { fault(phase) { if (phase === boundary) keyring.save({ ...keyring.load()!, generation: 2, keys: [] }); } });
  const preview = await guarded.preview(next, { categories: ["dictionaries"] });
  await assert.rejects(guarded.apply("race", preview.token), { code: "PREVIEW_EXPIRED" });
  assert.equal(store.one("SELECT current_version_id FROM dictionaries WHERE id=?", d.id)!.current_version_id, d.currentVersionId);
  assert.equal(store.one("SELECT count(*) n FROM dictionary_versions")!.n, 1);
  assert.equal(store.one("SELECT revision FROM dictionaries WHERE id=?", d.id)!.revision, 1);
  assert.equal(store.one("SELECT request_id FROM command_receipts WHERE scope='config-git:restore' AND request_id='race'"), undefined);
  assert.equal(guarded.operations().find(o => o.requestId === "race")!.phase, "failed");
});

test("v1 repository backup preview explicitly warns about v2 upgrade before confirmation", async t => {
  const { root, store, restore } = setup(t), remote = join(root, "remote.git"); mkdirSync(remote);
  execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote, stdio: "ignore" });
  const service = new ConfigGitService(store, new WebBridgeConfig(store.root), restore, { testTransport: () => remote });
  t.after(() => service.close());
  await service.repository.bind({ remoteUrl: "https://example.com/review.git", branch: "main", identity: { name: "Review", email: "review@example.com" } });
  const legacy = snapshot(); delete legacy.dictionaries;
  const seed = await service.repository.previewCommit({ files: serializeSnapshot(legacy).files, revision: "seed", message: "v1" });
  const original = await service.repository.confirmCommit({ token: seed.token, revision: "seed", requestId: "seed" });
  const before = (await service.repository.status()).head;
  const preview = await service.commitPreview({ message: "v2", theme: "dark" });
  assert.ok(preview.warnings?.some(w => w.includes("v1") && w.includes("v2") && w.includes("旧版")));
  assert.equal((await service.repository.status()).head, before);
  assert.equal(parseSnapshot(await service.repository.readSnapshot(original.sha!)).dictionaries, undefined);
});
