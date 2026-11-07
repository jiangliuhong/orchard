import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigSnapshotService, canonicalSnapshotJson, encodeSnapshotId, exportSnapshot, localReference, parseDeclarativeConfig, parseSnapshot, portableScriptHash, portableWorkflowHash, refreshManifest, serializeSnapshot, snapshotDigest, type PortableSnapshot } from "../src/config-git/snapshot.js";
import { snapshotPath } from "../src/config-git/snapshot-primitives.js";
import { TestStore, temporary } from "./helpers.js";
import type { ScriptDefinition } from "../src/domain/scripts.js";
import type { SourceFiles } from "../src/domain/types.js";

function workflowFiles(id = "workflow", scriptVersionId = "old-script"): SourceFiles {
  return { "workflow.json": JSON.stringify({ formatVersion: 1, id, name: "Workflow", inputSchema: true, outputSchema: true, entryNodeId: "run", nodes: [{ id: "run", name: "Run", type: "script", input: { source: "workflow" }, outputSchema: true, config: { scriptId: "normalize", scriptVersionId } }], edges: [], result: { source: "node", nodeId: "run" } }), "layout.json": '{"run":{"x":1,"y":2}}\n' };
}
function scriptDefinition(name = "Historical name"): ScriptDefinition {
  return { id: "normalize", name, description: "Historical description", runtime: "nodejs", entryFile: "src/index.ts", inputSchema: true, outputSchema: true, timeoutMs: 10000, resultMode: "json", files: { "src/index.ts": 'import { identity } from "./helper.ts";\nexport default identity;\n', "src/helper.ts": "export const identity = (x: unknown) => x;\n" } };
}
function fixture(): PortableSnapshot {
  return {
    general: { theme: "dark" },
    providers: [{ id: "pi-cli", enabled: true, config: { executable: localReference("providers", "pi-cli", "executable"), transport: "legacy" }, defaultModel: "visible", models: [{ id: "visible", name: "Visible", source: "configured", enabled: true, deleted: false }, { id: "hidden", name: "Hidden", source: "discovered", enabled: false, deleted: true }] }],
    webBridge: { applications: { app: { id: "app", name: "App", enabled: true } }, environments: { app: [{ id: "env.with.dots", origin: "https://example.com", enabled: true, profileId: localReference("webBridge", "app", "env.with.dots", "profileId") }] }, tools: { "app/read": { application: "app", toolId: "read", site: "Example", description: "Read", parameters: { type: "object" }, path: "/api/read", method: "GET", fields: [], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", enabled: false } }, enabledTools: { "app/read": false } },
    scripts: [{ id: "normalize", name: "Current name", description: "Current description", runtime: "nodejs", archived: true, currentPublishedVersionId: "new-script", draft: scriptDefinition("Draft name"), versions: [{ id: "new-script", definition: scriptDefinition("New name") }, { id: "old-script", definition: scriptDefinition() }] }],
    workflows: [{ id: "workflow", name: "Workflow", currentPublishedVersionId: "new-workflow", draft: { files: workflowFiles(), baseVersionId: "old-workflow" }, versions: [{ id: "old-workflow", files: workflowFiles() }, { id: "new-workflow", files: workflowFiles("workflow", "new-script") }] }],
  };
}
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test("complete snapshot roundtrip preserves identity, archived dependencies, hidden models, tools, layout, source and historical metadata", () => {
  const input = fixture(), bundle = serializeSnapshot(input), decoded = parseSnapshot(bundle.files);
  assert.equal(decoded.scripts[0]!.versions[1]!.definition.name, "Historical name");
  assert.equal(decoded.scripts[0]!.draft!.name, "Draft name");
  assert.equal(decoded.providers[0]!.models[0]!.deleted, true);
  assert.equal(decoded.webBridge.enabledTools["app/read"], false);
  assert.equal(decoded.workflows[0]!.draft!.baseVersionId, "old-workflow");
  assert.equal(decoded.scripts[0]!.archived, true);
  assert.deepEqual(serializeSnapshot(decoded).files, bundle.files);
  assert.equal(bundle.digest, snapshotDigest(bundle.files["manifest.json"]!));
  assert.equal(bundle.manifest.files.some(f => f.path === "manifest.json"), false);
  assert.equal(bundle.manifest.objects.find(o => o.category === "workflows")!.dependencies.length, 2);
  assert.equal(new ConfigSnapshotService().parse(bundle.files).general.theme, "dark");
});

test("stable ordering is Unicode code point order, arrays retain business order, source LF normalization is deterministic", () => {
  assert.equal(canonicalSnapshotJson({ "\u{10000}": 1, "\ue000": 2, z: [2, 1], a: 3 }), '{"a":3,"z":[2,1],"":2,"𐀀":1}');
  const first = fixture(), second = fixture(); second.scripts[0]!.versions.reverse(); second.workflows[0]!.versions.reverse(); second.providers[0]!.models.reverse();
  second.scripts[0]!.versions[0]!.definition.files["src/helper.ts"] = second.scripts[0]!.versions[0]!.definition.files["src/helper.ts"]!.replaceAll("\n", "\r\n");
  assert.deepEqual(serializeSnapshot(first).files, serializeSnapshot(second).files);
  for (const value of [NaN, Infinity, undefined, () => 1, new Date(), [, 1]]) assert.throws(() => canonicalSnapshotJson(value));
  const getter = Object.defineProperty({}, "evil", { enumerable: true, get() { throw new Error("EXECUTED"); } });
  assert.throws(() => canonicalSnapshotJson(getter), /accessors/);
});

test("declarative parser accepts comments and trailing commas and never evaluates code", () => {
  assert.equal(canonicalSnapshotJson(parseDeclarativeConfig('/* header */ export default { "value": -2, nested: [true, null, "x",], }; // tail')), '{"nested":[true,null,"x"],"value":-2}');
  const attacks = [
    'import fs from "node:fs"; export default {};', 'export default process.exit();', 'export default (()=>({}))();', 'export default { ...{} };',
    'export default { get theme() { return "dark"; } };', 'export default { set a(x) {} };', 'export default { method() {} };', 'export default { x };',
    'export default { ["theme"]: "dark" };', 'export default { theme:"dark", theme:"light" };', 'export default { "a":1, a:2 };',
    'export default { x:`hello` };', 'export default { x:`${process.exit()}` };', 'export default {x:1+2};', 'export default {x:undefined};',
    'export default {x:NaN};', 'export default {x:Infinity};', 'export default {x:1e999};', 'export default {x:1n};', 'export default {x:/evil/};',
    'export default [,,];', 'export default { x: +1 };', 'export default ({x:1});', 'export default {x:(1)};', 'export default {}; globalThis.executed = true;',
    'export default {} as const;', 'export default <any>{};', 'export default {x: -true};', '#!/bin/node\nexport default {};',
  ];
  for (const attack of attacks) assert.throws(() => parseDeclarativeConfig(attack), code("INVALID_CONFIG_SCRIPT"), attack);
  assert.equal((globalThis as Record<string, unknown>).executed, undefined);
  assert.throws(() => parseDeclarativeConfig(`export default ${"[".repeat(102)}0${"]".repeat(102)}`));
  const proto = parseDeclarativeConfig('export default {"__proto__": {"polluted":true}, "constructor":"data"};') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(proto), null); assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("safe identity encoding is reversible and collision free; unsafe paths and oversized identifiers fail", () => {
  const ids = ["a.b", "a/b", "A", "a", "你好", "../escape"];
  assert.equal(new Set(ids.map(encodeSnapshotId)).size, ids.length);
  for (const id of ids) assert.equal(Buffer.from(encodeSnapshotId(id), "hex").toString("utf8"), id);
  assert.notDeepEqual(localReference("a.b", "c"), localReference("a", "b.c"));
  for (const id of ["", "a".repeat(121), "\ud800", "nul\0"]) assert.throws(() => encodeSnapshotId(id));
  for (const path of ["/abs", "a//b", "../x", "a/./b", "a/../b", "a/.git/x", ".GIT/config", "a\\b", "C:/evil", "x\0", "a\nb"]) assert.throws(() => snapshotPath(path));
});

test("manifest rejects tampering, extra/missing files, duplicate indexes, unknown versions and identity path mismatches", () => {
  const bundle = serializeSnapshot(fixture());
  const mutate = (action: (files: SourceFiles) => void) => { const files = { ...bundle.files }; action(files); assert.throws(() => parseSnapshot(files)); };
  mutate(f => { f["settings/general.config.ts"] = 'export default {theme:"light"};\n'; });
  mutate(f => { f["untracked.txt"] = "extra"; });
  mutate(f => { delete f["settings/general.config.ts"]; });
  mutate(f => { const m = JSON.parse(f["manifest.json"]!); m.files.push(m.files[0]); f["manifest.json"] = JSON.stringify(m); });
  mutate(f => { const m = JSON.parse(f["manifest.json"]!); m.objects.push(m.objects[0]); f["manifest.json"] = JSON.stringify(m); });
  mutate(f => { const m = JSON.parse(f["manifest.json"]!); m.formatVersion = 2; f["manifest.json"] = JSON.stringify(m); });
  mutate(f => { const m = JSON.parse(f["manifest.json"]!); m.minOrchardVersion = "9.0.0"; f["manifest.json"] = JSON.stringify(m); });
  mutate(f => { const m = JSON.parse(f["manifest.json"]!); m.categories.pop(); f["manifest.json"] = JSON.stringify(m); });
  mutate(f => { f["manifest.json"] = f["manifest.json"]!.replace('"formatVersion":1', '"formatVersion":1,"formatVersion":1'); });
  mutate(f => { const path = `settings/providers/${encodeSnapshotId("pi-cli")}.config.ts`; f["settings/providers/PI.config.ts"] = f[path]!; delete f[path]; });
  mutate(f => { f["settings/general.config.ts"] += "\r\n"; });
});

test("refresh updates authoritative object/version/source digests while preserving every edited nonmanifest byte", () => {
  const original = serializeSnapshot(fixture()), files = { ...original.files };
  const source = `scripts/${encodeSnapshotId("normalize")}/versions/${encodeSnapshotId("old-script")}/src/helper.ts`;
  files[source] = "export const identity = (x: unknown) => ({x});\n";
  files["settings/general.config.ts"] = '// User comment\nexport default { theme: "light", };\n';
  assert.throws(() => parseSnapshot(files));
  const refreshed = refreshManifest(files);
  for (const path of Object.keys(files).filter(p => p !== "manifest.json")) assert.equal(refreshed.files[path], files[path]);
  assert.notEqual(refreshed.manifest.objects.find(o => o.category === "scripts")!.versions[1]!.digest, original.manifest.objects.find(o => o.category === "scripts")!.versions[1]!.digest);
  assert.equal(parseSnapshot(refreshed.files).general.theme, "light");
  const bad: SourceFiles = { ...files, "settings/general.config.ts": 'export default {theme:"dark",secret:"VALUE"};\n' };
  assert.throws(() => refreshManifest(bad));
  assert.equal(bad["manifest.json"], original.files["manifest.json"]);
});

test("strict schemas reject unknown fields, invalid localRefs, duplicate identities, missing closure and immutable ownership", () => {
  const reject = (mutate: (s: PortableSnapshot) => void) => { const s = fixture(); mutate(s); assert.throws(() => serializeSnapshot(s)); };
  reject(s => { (s.general as any).unknown = 1; });
  reject(s => { (s.providers[0]!.config as any).token = "SECRET"; });
  reject(s => { (s.providers[0]!.config as any).executable = "/private/path"; });
  reject(s => { s.providers[0]!.config.executable = localReference("wrong"); });
  reject(s => { (s.providers[0]!.config.executable as any).fallback = "/tmp"; });
  reject(s => { (s.webBridge.environments.app![0] as any).bound = true; });
  reject(s => { (s.webBridge.tools["app/read"] as any).token = "SECRET"; });
  reject(s => { s.providers.push(s.providers[0]!); });
  reject(s => { s.providers[0]!.models.push(s.providers[0]!.models[0]!); });
  reject(s => { s.providers[0]!.defaultModel = "hidden"; });
  reject(s => { s.scripts[0]!.versions = s.scripts[0]!.versions.slice(0, 1); });
  reject(s => { s.workflows[0]!.versions.pop(); });
  reject(s => { s.scripts[0]!.versions[0]!.definition.id = "other"; });
  reject(s => { s.workflows[0]!.versions[0]!.id = "new-script"; });
  reject(s => { (s.scripts[0] as any).draft = false; });
  reject(s => { s.scripts[0]!.versions[0]!.definition.files["../escape.ts"] = ""; });
  reject(s => { s.scripts[0]!.versions[0]!.definition.files["src/index.ts"] = "export default (;"; });
});

test("declared Provider and Bridge dependencies remain mandatory, including on unfinished drafts", () => {
  for (const node of [
    { type: "agent", config: { agentConfigId: "missing-config" } },
    { type: "agent", config: { agentConfigId: "unavailable-config" } },
    { type: "web-bridge", config: { application: "missing-app", tool: "read" } },
    { type: "web-bridge", config: { application: "app", tool: "missing-tool" } },
  ]) {
    const s = fixture(); s.workflows[0]!.draft!.files["workflow.json"] = JSON.stringify({ id: "workflow", name: "Unfinished", nodes: [node] });
    if ("agentConfigId" in node.config && node.config.agentConfigId === "unavailable-config") s.providers[0]!.agentModelConfigs = [{ id: "unavailable-config", name: "不可用", description: "", modelId: "hidden", enabled: true }];
    assert.throws(() => serializeSnapshot(s), code("DEPENDENCY_MISSING"));
  }
});

test("published business sources are parsed but never executed during export, parse or refresh", t => {
  const root = temporary(t), marker = join(root, "executed");
  const s = fixture();
  for (const v of s.scripts[0]!.versions) v.definition.files["src/helper.ts"] = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export const identity = (x: unknown) => x;`;
  s.scripts.push({ id: "shell-script", name: "Shell", description: "", runtime: "shell", archived: false, currentPublishedVersionId: "shell-version", draft: null, versions: [{ id: "shell-version", definition: { id: "shell-script", name: "Shell", description: "", runtime: "shell", entryFile: "src/main.sh", inputSchema: true, outputSchema: true, resultMode: "process", files: { "src/main.sh": `#!/bin/bash\nprintf executed > '${marker}'\n` } } }] });
  const bundle = serializeSnapshot(s); parseSnapshot(bundle.files); refreshManifest(bundle.files);
  assert.equal(existsSync(marker), false);
  s.scripts[1]!.versions[0]!.definition.files["src/main.sh"] = "if then; fi";
  assert.throws(() => serializeSnapshot(s), code("INVALID_SCRIPT"));
});

test("portable version hashes normalize source line endings and JSON key order, exclude local database metadata", () => {
  const a = scriptDefinition(), b = scriptDefinition(); b.files["src/helper.ts"] = b.files["src/helper.ts"]!.replaceAll("\n", "\r\n");
  assert.equal(portableScriptHash("v", a), portableScriptHash("v", b));
  assert.notEqual(portableScriptHash("v", a), portableScriptHash("other", a));
  const fa = workflowFiles(), fb = workflowFiles(); fb["layout.json"] = '{"run":{"y":2,"x":1}}';
  assert.equal(portableWorkflowHash("workflow", "v", fa), portableWorkflowHash("workflow", "v", fb));
  assert.notEqual(portableWorkflowHash("workflow", "v", fa), portableWorkflowHash("workflow", "other", fa));
});

test("invalid but identifiable workflow drafts preserve raw files and explicit dependencies are still enforced", () => {
  const s = fixture(); s.workflows[0]!.draft!.files["workflow.json"] = '{"id":"workflow", "name":"Unfinished", "nodes": []}';
  const files = serializeSnapshot(s).files;
  assert.equal(parseSnapshot(files).workflows[0]!.draft!.files["workflow.json"], s.workflows[0]!.draft!.files["workflow.json"]);
  s.workflows[0]!.draft!.files["workflow.json"] = '{"name":"Missing identity"}'; assert.throws(() => serializeSnapshot(s));
});

test("Store export gathers current/baseline workflow and fixed archived script closure, excludes history and local secrets", t => {
  const root = temporary(t), store = new TestStore(root); t.after(() => store.close());
  store.saveProvider({ id: "pi-cli", enabled: true, config: { executable: "/SECRET/cli" }, defaultModel: "visible", models: [{ id: "visible", name: "Visible", source: "configured" }, { id: "hidden", name: "Hidden", source: "discovered", enabled: false, deleted: true }], revision: 55, updatedAt: 123 });
  const now = Date.now();
  store.exec("INSERT INTO scripts(id,name,description,runtime,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", "normalize", "Current name", "Description", "nodejs", "archived", now, now);
  for (const [i, id] of ["unused-script", "old-script", "new-script"].entries()) {
    const d = scriptDefinition(id), { files, ...metadata } = d, tree = store.files.saveScriptTree(files, metadata);
    store.exec("INSERT INTO script_versions(id,script_id,version_no,status,revision,entry_file,timeout_ms,input_schema_json,output_schema_json,source_ref,content_hash,validation_json,created_at,updated_at,published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, "normalize", i + 1, "published", 99, d.entryFile, d.timeoutMs!, "true", "true", tree.path, tree.hash, '{"valid":true}', now, now, now);
  }
  store.exec("UPDATE scripts SET current_published_version_id=? WHERE id=?", "new-script", "normalize");
  store.exec("INSERT INTO workflows(id,name,created_at,updated_at) VALUES(?,?,?,?)", "workflow", "Workflow", now, now);
  for (const [i, id] of ["unused-workflow", "old-workflow", "new-workflow"].entries()) {
    const files = workflowFiles("workflow", id === "old-workflow" ? "old-script" : "new-script"), tree = store.files.saveTree(files);
    store.exec("INSERT INTO workflow_versions(id,workflow_id,version_no,definition_json,layout_json,artifact_path,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)", id, "workflow", i + 1, files["workflow.json"]!, files["layout.json"]!, tree.path, tree.hash, now);
  }
  store.exec("UPDATE workflows SET current_version_id=? WHERE id=?", "new-workflow", "workflow");
  const draftTree = store.files.saveTree(workflowFiles());
  store.exec("INSERT INTO drafts(id,workflow_id,base_version_id,revision,artifact_path,validation_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", "LOCAL-DRAFT-ID", "workflow", "old-workflow", 123, draftTree.path, '{"valid":true}', "draft", now, now);
  const bridge = { applications: { app: { id: "app", name: "App", enabled: true } }, environments: { app: [{ id: "local-env", origin: "https://example.com", enabled: true, bound: true, tabAvailable: true, profileId: "SECRET-PROFILE", extensionId: "SECRET-EXTENSION" }] }, tools: {}, enabledTools: {} };
  const bundle = exportSnapshot(store, bridge, "system"), dto = parseSnapshot(bundle.files);
  assert.deepEqual(dto.workflows[0]!.versions.map(v => v.id), ["new-workflow", "old-workflow"]);
  assert.deepEqual(dto.scripts[0]!.versions.map(v => v.id), ["new-script", "old-script"]);
  assert.equal(dto.scripts[0]!.versions[1]!.definition.name, "old-script");
  const all = JSON.stringify(bundle.files);
  for (const privateText of ["SECRET", "LOCAL-DRAFT-ID", "tabAvailable", "bound", "revision", "unused-script", "unused-workflow", "content_hash"]) assert.equal(all.includes(privateText), false, privateText);
  assert.deepEqual(exportSnapshot(store, bridge, "system").files, bundle.files);
  assert.throws(() => exportSnapshot(store, bridge, undefined as any), code("GENERAL_REQUIRED"));
  store.saveProvider({ ...store.provider("pi-cli")!, config: { executable: "/SECRET/cli", token: "DONT-LEAK" } });
  assert.throws(() => exportSnapshot(store, bridge, "light"), error => String(error).includes("token") && !String(error).includes("DONT-LEAK"));
  assert.equal(existsSync(join(root, "config-git")), false);
});

test("Store export includes never-published drafts and rejects ambiguous draft identities", t => {
  const store = new TestStore(temporary(t)); t.after(() => store.close());
  const files = { "workflow.json": '{"id":"new-workflow","name":"Unfinished","nodes":[]}' }, tree = store.files.saveTree(files), now = Date.now();
  const insert = (id: string) => store.exec("INSERT INTO drafts(id,revision,artifact_path,validation_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", id, 0, tree.path, '{"valid":false}', "draft", now, now);
  insert("draft-1");
  const bridge = { applications: {}, environments: {}, tools: {}, enabledTools: {} };
  const result = exportSnapshot(store, bridge, "light");
  assert.equal(result.snapshot.workflows[0]!.id, "new-workflow"); assert.equal(result.snapshot.workflows[0]!.currentPublishedVersionId, null);
  insert("draft-2"); assert.throws(() => exportSnapshot(store, bridge, "light"), code("DUPLICATE_ID"));
});
