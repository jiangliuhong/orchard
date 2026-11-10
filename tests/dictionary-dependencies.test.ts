import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { normalizeDictionaryBindings, nodeDictionaryBindings, workflowDictionaryRequirements, workflowDictionarySensitivity, assertLegacyWorkflowDictionaries } from "../src/domain/dictionaries.js";
import { validateScript, type ScriptDefinition } from "../src/domain/scripts.js";
import { prepareScriptProposal } from "../src/domain/script-authoring.js";
import { validateWorkflow, resolveBinding } from "../src/domain/validation.js";
import { bindingSchema, schemaSubset } from "../src/domain/schema-compatibility.js";
import { validatePortableScript, validatePortableSnapshot } from "../src/config-git/snapshot-validation.js";
import { executeScript } from "../src/runtime/script.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { GraphRunner } from "../src/runtime/runner.js";
import { setup, temporary, TestStore } from "./helpers.js";
import { exportSnapshot, portableScriptHash } from "../src/config-git/snapshot.js";
import { captureSnapshot } from "../src/config-git/restore-import.js";
import type { Binding, Workflow } from "../src/domain/types.js";

const plainId = "11111111-1111-4111-8111-111111111111";
const secretId = "22222222-2222-4222-8222-222222222222";
const declarations = () => ({ service: { dictionaryId: plainId, kind: "plain" as const, keys: ["url"] } });
const definition = (): ScriptDefinition => ({ id: "dict-script", name: "Dictionary script", description: "", runtime: "nodejs", entryFile: "main.ts", inputSchema: true, outputSchema: true, files: { "main.ts": "export default input => input" } });
const workflow = (): Workflow => ({
  formatVersion: 1, id: "dict-workflow", name: "Dictionary workflow", inputSchema: true, outputSchema: true,
  entryNodeId: "a", nodes: [
    { id: "a", name: "A", type: "code.nodejs", input: { source: "workflow" }, outputSchema: true, config: { script: "scripts/a.ts" } },
    { id: "b", name: "B", type: "shell", input: { source: "node", nodeId: "a" }, outputSchema: true, config: { script: "scripts/b.sh" } },
  ], edges: [{ id: "ab", from: "a", to: "b" }], result: { source: "node", nodeId: "b" },
});
const binding = (): Binding => ({ source: "dictionary", dictionaryId: plainId, key: "url" });

test("declarations normalize deterministically without changing caller arrays or legacy shapes", () => {
  assert.equal(normalizeDictionaryBindings(undefined), undefined);
  assert.equal(normalizeDictionaryBindings({}), undefined);
  const source = { z: { dictionaryId: plainId, kind: "plain", keys: ["z", "a"] }, a: { dictionaryId: secretId, kind: "encrypted", keys: ["token"] } };
  const normalized = normalizeDictionaryBindings(source)!;
  assert.deepEqual(Object.keys(normalized), ["a", "z"]);
  assert.deepEqual(normalized.z!.keys, ["a", "z"]);
  assert.deepEqual(source.z.keys, ["z", "a"]);
  assert.deepEqual(validateScript({ ...definition(), dictionaryBindings: {} }), definition());
  assert.equal(Object.hasOwn(validateScript(definition()), "dictionaryBindings"), false);
  assert.deepEqual(validateScript({ ...definition(), dictionaryBindings: declarations() }).dictionaryBindings, declarations());
});

test("declarations strictly reject unknown fields, duplicate keys, wildcard and malformed identities", () => {
  for (const value of [null, [], { a: null }, { a: { ...declarations().service, extra: true } },
    { a: { ...declarations().service, dictionaryId: "name" } }, { a: { ...declarations().service, kind: "secret" } },
    { a: { ...declarations().service, keys: [] } }, { a: { ...declarations().service, keys: ["url", "url"] } },
    { a: { ...declarations().service, keys: ["*"] } }, { "invalid.alias": declarations().service },
    { a: { ...declarations().service, keys: Array(2) } },
  ]) assert.throws(() => normalizeDictionaryBindings(value), { code: "INVALID_DICTIONARY_BINDINGS" });
  const accessor = Object.defineProperty({}, "a", { enumerable: true, get() { throw new Error("must not run getter"); } });
  assert.throws(() => normalizeDictionaryBindings(accessor), { code: "INVALID_DICTIONARY_BINDINGS" });
});

test("declarations enforce both alias and total-key limits", () => {
  const make = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, declarations().service]));
  assert.equal(Object.keys(normalizeDictionaryBindings(make(32))!).length, 32);
  assert.throws(() => normalizeDictionaryBindings(make(33)), { code: "INVALID_DICTIONARY_BINDINGS" });
  const keys = Array.from({ length: 256 }, (_, i) => `key${i}`);
  assert.equal(normalizeDictionaryBindings({ a: { ...declarations().service, keys } })!.a!.keys.length, 256);
  assert.throws(() => normalizeDictionaryBindings({ a: { ...declarations().service, keys }, b: declarations().service }), { code: "INVALID_DICTIONARY_BINDINGS" });
});

test("prototype-named aliases remain ordinary own declarations", () => {
  const normalized = normalizeDictionaryBindings({ constructor: declarations().service, toString: declarations().service })!;
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  assert.equal(normalized["constructor"]!.dictionaryId, plainId);
  assert.equal(Object.keys(normalized).length, 2);
});

test("workflow accepts nested dictionary bindings and validates pointer, key, ID and config placement", () => {
  const w = workflow();
  w.nodes[0]!.input = { source: "object", properties: { nested: { source: "array", items: [binding()] } } };
  w.result = { ...binding(), pointer: "/a~1b" } as Binding;
  w.nodes[0]!.config.dictionaryBindings = declarations();
  assert.equal(validateWorkflow(w), w);
  for (const patch of [{ key: "*" }, { dictionaryId: "by-name" }, { pointer: "invalid" }, { pointer: "/bad~2" }, { unknown: true }]) {
    assert.throws(() => validateWorkflow({ ...w, result: { ...binding(), ...patch } }));
  }
  w.nodes[0]!.type = "script";
  w.nodes[0]!.config = { scriptId: "dict-script", scriptVersionId: "version-1", dictionaryBindings: declarations() };
  assert.throws(() => validateWorkflow(w), { code: "SCHEMA_MISMATCH" });
});

test("binding resolution requires a pinned context, propagates it recursively and returns copies", () => {
  const source = { nested: { "a/b": [1, 2] } };
  const b: Binding = { source: "object", properties: { value: { source: "array", items: [{ ...binding(), pointer: "/nested/a~1b" } as Binding] } } };
  assert.throws(() => resolveBinding(b, {}, new Map()), { code: "DICTIONARY_ACCESS_DENIED" });
  const result = resolveBinding(b, {}, new Map(), (id, key) => { assert.equal(id, plainId); assert.equal(key, "url"); return source; }) as { value: number[][] };
  assert.deepEqual(result, { value: [[1, 2]] });
  result.value[0]!.push(3);
  assert.deepEqual(source.nested["a/b"], [1, 2]);
  assert.throws(() => resolveBinding({ ...binding(), pointer: "/missing" } as Binding, {}, new Map(), () => source), { code: "MISSING_INPUT" });
  assert.equal(bindingSchema(binding(), workflow()), true);
  assert.equal(schemaSubset(bindingSchema(binding(), workflow()), { type: "string" }), "unknown");
});

test("dependency closure includes final result, nested bindings and exact immutable script declarations", () => {
  const w = workflow();
  w.nodes[0]!.input = { source: "array", items: [binding()] };
  w.nodes[0]!.config.dictionaryBindings = { service: { ...declarations().service, keys: ["timeout"] } };
  w.nodes[1]!.type = "script";
  w.nodes[1]!.config = { scriptId: "dict-script", scriptVersionId: "fixed-version" };
  w.result = { source: "object", properties: { result: { ...binding(), key: "label" } as Binding } };
  const calls: string[][] = [];
  const resolve = (id: string, version: string) => { calls.push([id, version]); return { ...definition(), dictionaryBindings: { credentials: { dictionaryId: secretId, kind: "encrypted" as const, keys: ["token"] } } }; };
  assert.deepEqual(workflowDictionaryRequirements(w, resolve), [
    { dictionaryId: plainId, kind: "plain", keys: ["label", "timeout", "url"] },
    { dictionaryId: secretId, kind: "encrypted", keys: ["token"] },
  ]);
  assert.deepEqual(calls, [["dict-script", "fixed-version"]]);
  assert.throws(() => workflowDictionaryRequirements(w), { code: "DEPENDENCY_MISSING" });
  assert.throws(() => nodeDictionaryBindings(w, () => ({ ...definition(), id: "other" })), { code: "SCRIPT_VERSION_INVALID" });
});

test("same dictionary with inconsistent declared kinds is rejected", () => {
  const w = workflow(); w.nodes[0]!.input = binding();
  w.nodes[1]!.config.dictionaryBindings = { credentials: { dictionaryId: plainId, kind: "encrypted", keys: ["token"] } };
  assert.throws(() => workflowDictionaryRequirements(w), { code: "DICTIONARY_KIND_MISMATCH" });
});

test("encrypted dependencies taint all reachable branches, not upstream nodes", () => {
  const w = workflow();
  w.nodes[1]!.config.dictionaryBindings = { credentials: { dictionaryId: secretId, kind: "encrypted", keys: ["token"] } };
  assert.deepEqual([...workflowDictionarySensitivity(w).nodes], ["b"]);
  assert.equal(workflowDictionarySensitivity(w).output, true);
  w.result = { source: "node", nodeId: "a" };
  assert.equal(workflowDictionarySensitivity(w).output, false);
  w.nodes.push({ ...w.nodes[0]!, id: "c" }, { ...w.nodes[0]!, id: "d" });
  w.edges.push({ id: "bc", from: "b", to: "c" }, { id: "bd", from: "b", to: "d" });
  assert.deepEqual([...workflowDictionarySensitivity(w).nodes], ["b", "c", "d"]);
  w.result = { source: "object", properties: { nested: { source: "array", items: [{ source: "node", nodeId: "c" }] } } };
  assert.equal(workflowDictionarySensitivity(w).output, true);
});

test("sensitive reachability rejects Agent and Bridge sinks, including a fixed script's secret declaration", () => {
  const w = workflow(); w.nodes[0]!.type = "script"; w.nodes[0]!.config = { scriptId: "dict-script", scriptVersionId: "fixed" };
  const resolve = () => ({ ...definition(), dictionaryBindings: { credentials: { dictionaryId: secretId, kind: "encrypted" as const, keys: ["token"] } } });
  for (const type of ["agent", "web-bridge"] as const) {
    w.nodes[1]!.type = type;
    assert.throws(() => workflowDictionarySensitivity(w, resolve), { code: "SECRET_SINK_FORBIDDEN" });
  }
});

test("Agent proposals preserve and update dependency declarations, empty object explicitly removes them", () => {
  const current = { ...definition(), dictionaryBindings: declarations() };
  const proposal = { summary: "update metadata", changes: [], metadata: {} };
  assert.deepEqual(prepareScriptProposal(current, proposal).definition.dictionaryBindings, declarations());
  assert.equal(prepareScriptProposal(current, { ...proposal, metadata: { dictionaryBindings: {} } }).definition.dictionaryBindings, undefined);
  assert.throws(() => prepareScriptProposal(current, { ...proposal, metadata: { dictionaryBindings: { bad: { dictionaryId: plainId, kind: "plain", keys: ["*"] } } } }));
});

test("Git v1 explicitly rejects dictionary declarations and bindings even in incomplete drafts", () => {
  for (const published of [true, false]) assert.throws(() => validatePortableScript({ ...definition(), dictionaryBindings: declarations() }, published), { code: "FORMAT_UNSUPPORTED" });
  const w = workflow(); w.result = { source: "array", items: [binding()] };
  assert.throws(() => assertLegacyWorkflowDictionaries(w), { code: "FORMAT_UNSUPPORTED" });
  const snapshot = { general: { theme: "system" }, providers: [], scripts: [], webBridge: { applications: {}, environments: {}, tools: {}, enabledTools: {} }, workflows: [{ id: w.id, name: w.name, currentPublishedVersionId: null, versions: [], draft: { files: { "workflow.json": JSON.stringify(w), "layout.json": "{}" }, baseVersionId: null } }] };
  assert.throws(() => validatePortableSnapshot(snapshot), { code: "FORMAT_UNSUPPORTED" });
  assert.throws(() => assertLegacyWorkflowDictionaries({ nodes: [{ config: { dictionaryBindings: {} } }] }), { code: "FORMAT_UNSUPPORTED" });
  assert.doesNotThrow(() => assertLegacyWorkflowDictionaries(workflow()));
});

test("export never silently strips declarations and recovery captures keep them in fingerprints", async t => {
  const store = new TestStore(temporary(t));
  t.after(() => store.close());
  const library = new ScriptLibrary(store);
  await library.create({ ...definition(), dictionaryBindings: declarations() });
  const captured = captureSnapshot(store, "system");
  assert.deepEqual(captured.snapshot.scripts[0]!.draft!.dictionaryBindings, declarations());
  assert.notEqual(portableScriptHash("draft", captured.snapshot.scripts[0]!.draft!), portableScriptHash("draft", definition()));
  const bridge = { applications: {}, environments: {}, tools: {}, enabledTools: {} };
  assert.throws(() => exportSnapshot(store, bridge, "system"), { code: "DEPENDENCY_MISSING" });
  store.publishScript("dict-script", 0);
  assert.deepEqual(captureSnapshot(store, "system").snapshot.scripts[0]!.versions[0]!.definition.dictionaryBindings, declarations());
  assert.throws(() => exportSnapshot(store, bridge, "system"), { code: "DEPENDENCY_MISSING" });
});

test("execution without a pinned context is rejected before compilation and process startup", async () => {
  await assert.rejects(executeScript({ ...definition(), dictionaryBindings: declarations(), input: {}, cwd: "/must-not-create-this-directory" }), { code: "DICTIONARY_ACCESS_DENIED" });
});

test("persisted draft and published definitions retain declarations; both test entries reject missing dependencies without tasks", async t => {
  const { store, providers } = setup(t);
  t.after(() => store.close());
  const library = new ScriptLibrary(store);
  const created = await library.create({ ...definition(), dictionaryBindings: declarations(), requestId: randomUUID() });
  const script = store.script("dict-script");
  assert.deepEqual(store.scriptDefinition(script.id, script.currentDraftVersionId!).dictionaryBindings, declarations());
  assert.deepEqual(library.version(script.id, script.currentDraftVersionId!).dictionaryBindings, declarations());
  assert.throws(() => store.createScriptTest(script.id, null, 0, {}), { code: "DICTIONARY_NOT_FOUND" });
  assert.equal(store.all("SELECT id FROM script_tests").length, 0);
  store.publishScript(script.id, 0);
  assert.throws(() => store.createScriptTest(script.id, script.currentDraftVersionId, null, {}), { code: "DICTIONARY_NOT_FOUND" });
  const runner = new GraphRunner(store, providers, undefined, false);
  const w = workflow(); w.nodes[0]!.input = binding();
  assert.doesNotThrow(() => store.assertWorkflowScripts(w));
  assert.equal(store.all("SELECT id FROM runs").length, 0);
  assert.equal(store.all("SELECT * FROM script_test_dictionary_bindings").length, 0);
  assert.equal(created.script.id, script.id);
  await runner.close();
});
