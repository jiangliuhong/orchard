import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TestStore, temporary } from "./helpers.js";
import { DictionaryReferenceScanner } from "../src/dictionaries/references.js";
import { DictionaryService } from "../src/dictionaries/service.js";
import { SecretsService } from "../src/secrets/service.js";
import { KeyringStore, resolveKeyringPath } from "../src/secrets/keyring.js";
import { CommandHmac } from "../src/secrets/command-hmac.js";
import { dictionaryDependencyMetadata, validateWorkflowDictionaries, validateScriptDictionaries } from "../src/dictionaries/validation.js";
import type { Workflow } from "../src/domain/types.js";
import type { ScriptDefinition } from "../src/domain/scripts.js";
function setup(t: TestContext) {
  const root = temporary(t), store = new TestStore(root); t.after(() => store.close());
  const keyring = new KeyringStore(resolveKeyringPath(root));
  const secrets = new SecretsService(store, keyring, new CommandHmac(store, root, keyring));
  const dictionaries = new DictionaryService(store, secrets);
  const id = dictionaries.create({ requestId: randomUUID(), name: "Config", description: "", kind: "plain", enabled: true, operations: [{ op: "set", key: "url", type: "json", value: { nested: "private-value" } }] }).dictionaryId;
  return { store, dictionaries, id };
}
function workflow(id: string): Workflow {
  return { formatVersion: 1, id: "consumer", name: "Consumer", inputSchema: true, outputSchema: true, entryNodeId: "a", nodes: [{ id: "a", name: "a", type: "code.nodejs", input: { source: "object", properties: { url: { source: "dictionary", dictionaryId: id, key: "url", pointer: "/nested" } } }, outputSchema: true, config: { script: "scripts/a.ts" } }], edges: [], result: { source: "dictionary", dictionaryId: id, key: "url" } };
}
function addVersion(store: TestStore, w: Workflow, no: number, current = true) {
  store.exec("INSERT OR IGNORE INTO workflows VALUES(?,?,NULL,1,1)", w.id, w.name);
  const versionId = randomUUID();
  store.exec("INSERT INTO workflow_versions VALUES(?,?,?,?,?,?,?,?)", versionId, w.id, no, JSON.stringify(w), "{}", "unused", "hash", 1);
  if (current) store.exec("UPDATE workflows SET current_version_id=? WHERE id=?", versionId, w.id);
  return versionId;
}
function addDraft(store: TestStore, w: Workflow, id = randomUUID()) {
  const tree = store.files.saveTree({ "workflow.json": JSON.stringify(w) });
  store.exec("INSERT INTO drafts(id,workflow_id,revision,artifact_path,validation_json,status,created_at,updated_at) VALUES(?,?,0,?,'{}','draft',1,1)", id, w.id, tree.path);
  return id;
}
test("reference scan includes nested bindings, result, drafts and all versions with object dedup", t => {
  const { store, id } = setup(t), w = workflow(id), scanner = new DictionaryReferenceScanner(store);
  addVersion(store, w, 1); addVersion(store, w, 2); addDraft(store, w);
  const scan = scanner.list(id, { limit: 1 });
  assert.equal(scan.complete, true); assert.equal(scan.counts.workflows, 1); assert.equal(scan.counts.versions, 3); assert.equal(scan.counts.nodes, 3);
  assert.deepEqual(scanner.keyReferences(id, ["url"]), [{ key: "url", workflows: 1, scripts: 0 }]);
  assert.equal(scanner.list(id, { view: "history" }).counts.versions, 1);
  assert.equal(scanner.list(id, { view: "current" }).counts.versions, 2);
  assert.ok(scan.nextCursor); assert.equal(scanner.list(id, { limit: 1, cursor: scan.nextCursor! }).items.length, 1);
  addVersion(store, w, 3);
  assert.throws(() => scanner.list(id, { cursor: scan.nextCursor! }), { code: "INVALID_CURSOR" });
  assert.ok(!JSON.stringify(scan).includes("private-value"));
});
test("unreadable drafts are incomplete and removal confirmation binds reference identities", t => {
  const { store, dictionaries, id } = setup(t), w = workflow(id);
  addVersion(store, w, 1);
  store.exec("INSERT INTO drafts(id,revision,artifact_path,validation_json,status,created_at,updated_at) VALUES('broken',0,'not/a/tree','{}','draft',1,1)");
  const scan = dictionaries.referenceList(id); assert.equal(scan.complete, false); assert.equal(scan.issues.length, 1);
  const input = { requestId: randomUUID(), expectedRevision: 1, operations: [{ op: "remove", key: "url" }] };
  let token = "";
  try { dictionaries.update(id, input); assert.fail(); } catch (error) { assert.equal((error as { code: string }).code, "CONFIRMATION_REQUIRED"); token = (error as { details: { confirmationToken: string } }).details.confirmationToken; }
  addVersion(store, { ...w, id: "second" }, 1);
  assert.throws(() => dictionaries.update(id, { ...input, confirmationToken: token }), { code: "PREVIEW_EXPIRED" });
});
test("static validation checks pointers, missing keys, disabled and sensitive sinks without crypto", t => {
  const { store, dictionaries, id } = setup(t), w = workflow(id);
  assert.deepEqual([...validateWorkflowDictionaries(store, w).nodes], []);
  w.result = { source: "dictionary", dictionaryId: id, key: "url", pointer: "/absent" };
  assert.throws(() => validateWorkflowDictionaries(store, w), { code: "DICTIONARY_POINTER_INVALID" });
  w.result = { source: "dictionary", dictionaryId: id, key: "absent" };
  assert.throws(() => validateWorkflowDictionaries(store, w), { code: "DICTIONARY_KEY_MISSING" });
  const definition: ScriptDefinition = { id: "consumer", name: "consumer", description: "", runtime: "nodejs", entryFile: "a.ts", files: { "a.ts": "return {}" }, inputSchema: true, outputSchema: true, dictionaryBindings: { config: { dictionaryId: id, kind: "plain", keys: ["url"] } } };
  validateScriptDictionaries(store, definition);
  assert.ok(!JSON.stringify(dictionaryDependencyMetadata(store)).includes("private-value"));
  dictionaries.update(id, { requestId: randomUUID(), expectedRevision: 1, enabled: false, operations: [] });
  assert.throws(() => validateScriptDictionaries(store, definition), { code: "DICTIONARY_DISABLED" });
});
test("script indirect refs resolve fixed published version instead of current pointer", t => {
  const { store, id } = setup(t);
  const definition: ScriptDefinition = { id: "helper", name: "helper", description: "", runtime: "nodejs", entryFile: "a.ts", files: { "a.ts": "return {}" }, inputSchema: true, outputSchema: true, dictionaryBindings: { config: { dictionaryId: id, kind: "plain", keys: ["url"] } } };
  const tree = store.files.saveScriptTree(definition.files, definition);
  const created = store.createScript(definition, tree.path, tree.hash);
  const fixed = created.version.id;
  store.exec("UPDATE script_versions SET status='published',published_at=1 WHERE id=?", fixed);
  store.exec("UPDATE scripts SET current_published_version_id=?,current_draft_version_id=NULL,status='published' WHERE id='helper'", fixed);
  const newer = { ...definition, dictionaryBindings: undefined };
  const newerTree = store.files.saveScriptTree(newer.files, newer);
  const newerVersion = store.updateScriptDraft("helper", 0, newer, newerTree.path, newerTree.hash).version.id;
  store.exec("UPDATE script_versions SET status='published',published_at=2 WHERE id=?", newerVersion);
  store.exec("UPDATE scripts SET current_published_version_id=?,current_draft_version_id=NULL WHERE id='helper'", newerVersion);
  const w = workflow(id); w.nodes[0]!.input = { source: "workflow" }; w.result = { source: "literal", value: null };
  w.nodes[0]!.type = "script"; w.nodes[0]!.config = { scriptId: "helper", scriptVersionId: fixed };
  addVersion(store, w, 1);
  const scanner = new DictionaryReferenceScanner(store);
  assert.equal(scanner.scan(id).complete, true);
  assert.equal(scanner.scan(id).items.find(i => i.objectType === "workflow")?.via, "script");
  assert.deepEqual(scanner.keyReferences(id, ["url"]), [{ key: "url", workflows: 1, scripts: 1 }]);
});

test("encrypted static declarations reject plain bindings and Agent successors without key access", t => {
  const { store, dictionaries, id } = setup(t);
  dictionaries.secrets.generate({ requestId: randomUUID(), expectedGeneration: 0, makeActive: true });
  const secretId = dictionaries.create({ requestId: randomUUID(), name: "Credentials", description: "", kind: "encrypted", enabled: true, operations: [{ op: "set", key: "token", type: "string", value: "never-display" }] }).dictionaryId;
  dictionaries.secrets.keyMaterials = () => { throw new Error("static validation must not access keyring"); };
  const w = workflow(id);
  w.nodes[0]!.config.dictionaryBindings = { auth: { dictionaryId: secretId, kind: "encrypted", keys: ["token"] } };
  assert.deepEqual([...validateWorkflowDictionaries(store, w).nodes], ["a"]);
  w.nodes.push({ id: "sink", name: "sink", type: "agent", input: { source: "node", nodeId: "a" }, outputSchema: true, config: { prompt: "x", agentConfigId: "model" } });
  w.edges.push({ id: "e", from: "a", to: "sink" });
  assert.throws(() => validateWorkflowDictionaries(store, w), { code: "SECRET_SINK_FORBIDDEN" });
  delete w.nodes[0]!.config.dictionaryBindings;
  w.result = { source: "dictionary", dictionaryId: secretId, key: "token" };
  assert.throws(() => validateWorkflowDictionaries(store, w), { code: "SECRET_BINDING_FORBIDDEN" });
  assert.ok(!JSON.stringify(dictionaryDependencyMetadata(store)).includes("never-display"));
  assert.ok(!JSON.stringify(dictionaryDependencyMetadata(store)).includes("keyId"));
});
