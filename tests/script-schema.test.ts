import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setup, until, TestStore } from "./helpers.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { ScriptTestRunner } from "../src/runtime/script-tests.js";
import { ScriptAgentService } from "../src/authoring/script-agent.js";
import { DictionaryService } from "../src/dictionaries/service.js";
import { SecretsService } from "../src/secrets/service.js";
import { KeyringStore, resolveKeyringPath } from "../src/secrets/keyring.js";
import { CommandHmac } from "../src/secrets/command-hmac.js";
import { createApp } from "../src/server/app.js";
import { parseEditorSchema, schemaEditorReason, renameSchemaProperty, deleteSchemaProperty, changeSchemaType } from "../src/web/lib/schema-editor.js";
import { historyPolicyRelaxed, schemaChanges } from "../src/domain/schema-diff.js";
import { normalizeScriptInputSources, captureScriptInput } from "../src/domain/script-test-input.js";
import type { ScriptDefinition } from "../src/domain/scripts.js";
import type { JsonSchema } from "../src/domain/types.js";

const definition = (schema: JsonSchema = { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false }): ScriptDefinition => ({ id: "schema-script", name: "Schema", description: "", runtime: "nodejs", entryFile: "main.ts", inputSchema: schema, outputSchema: true, files: { "main.ts": "export default input => { console.log(JSON.stringify(input)); return input; }" } });
function disk(root: string): string {
  return readdirSync(root).map(name => { const path = join(root, name), stat = lstatSync(path); return stat.isSymbolicLink() ? "" : stat.isDirectory() ? disk(path) : readFileSync(path).toString(); }).join("\n");
}
function services(t: test.TestContext) {
  const f = setup(t); t.after(() => f.store.close());
  const ring = new KeyringStore(resolveKeyringPath(f.store.root)), secrets = new SecretsService(f.store, ring, new CommandHmac(f.store, f.store.root, ring));
  const dictionaries = new DictionaryService(f.store, secrets), library = new ScriptLibrary(f.store);
  return { ...f, ring, secrets, dictionaries, library };
}

test("schema field operations preserve omitted constraints, special keys and required membership", () => {
  const schema = parseEditorSchema('{"type":"object","properties":{"a":{"type":"string","minLength":0}},"required":["a"]}') as Record<string, unknown>;
  assert.equal(schemaEditorReason(schema), undefined);
  const renamed = renameSchemaProperty(schema, "a", "__proto__");
  assert.equal(Object.hasOwn(renamed.properties as object, "__proto__"), true);
  assert.deepEqual(renamed.required, ["__proto__"]);
  assert.equal(Object.hasOwn(renamed, "additionalProperties"), false);
  assert.deepEqual(deleteSchemaProperty(renamed, "__proto__").required, []);
  assert.throws(() => renameSchemaProperty({ properties: { a: true, b: true } }, "a", "b"));
  assert.deepEqual(changeSchemaType({ type: "object", properties: { a: true }, description: "keep" }, "string"), { type: "string", description: "keep" });
  assert.deepEqual(schema, JSON.parse(JSON.stringify(schema)));
});
test("schema parsing rejects duplicate keys and invalid constraints; complex schemas remain JSON-only", () => {
  for (const text of ['{"type":"string","type":"number"}', '{"type":"string","minLength":-1}', '{"type":"string","minLength":3,"maxLength":1}', '{"type":"number","default":"wrong"}', '{"type":"integer","enum":[1.5]}']) assert.throws(() => parseEditorSchema(text));
  for (const schema of [true, false, { type: "null" }, { type: "array", items: { type: "object", properties: { x: { type: "integer", minimum: 0 } } } }, { type: "string", "x-ui": { widget: "textarea", rows: 4 }, "x-history": { record: false } }] as JsonSchema[]) assert.equal(schemaEditorReason(parseEditorSchema(JSON.stringify(schema))), undefined);
  for (const schema of [{ anyOf: [{ type: "string" }, { type: "number" }] }, { type: "object", additionalProperties: { type: "string" } }, { type: "array", items: [{ type: "string" }] }, { type: ["string", "null"] }]) assert.ok(schemaEditorReason(schema));
  assert.equal(historyPolicyRelaxed({ type: "string", "x-history": { record: false } }, { type: "string" }), true);
  assert.ok(schemaChanges({ type: "string" }, { type: "number" }).some(c => c.path === "/type"));
});
test("input references reject complex paths and history policy defaults match bridge", () => {
  const id = randomUUID(), schema = definition().inputSchema;
  for (const path of ["", "/token/nested", "/unknown", "/0", "/token~"]) assert.throws(() => normalizeScriptInputSources({ [path]: { source: "dictionary", dictionaryId: id, key: "token" } }, schema));
  assert.throws(() => normalizeScriptInputSources({ "/token": { source: "dictionary", dictionaryId: id, key: "token", pointer: "/x" } }, schema));
  assert.equal(captureScriptInput({ token: "public" }, schema, {}).transient, false);
  const captured = captureScriptInput({ token: "private" }, { type: "object", properties: { token: { type: "string", "x-history": { record: false } } } }, {});
  assert.deepEqual(captured.input, {}); assert.equal(captured.transient, true);
});
test("dictionary test inputs pin versions, merge code dependencies, preserve types and replay idempotently", async t => {
  const f = services(t);
  const created = f.dictionaries.create({ requestId: randomUUID(), name: "Parameters", kind: "plain", enabled: true, description: "", operations: [{ op: "set", key: "token", type: "string", value: "first" }, { op: "set", key: "count", type: "number", value: 5 }] });
  const d = definition({ type: "object", properties: { token: { type: "string" }, count: { type: "integer" } }, required: ["token", "count"], additionalProperties: false });
  d.dictionaryBindings = { config: { dictionaryId: created.dictionaryId, kind: "plain", keys: ["count"] } };
  await f.library.create(d);
  const sources = { "/token": { source: "dictionary", dictionaryId: created.dictionaryId, key: "token" }, "/count": { source: "dictionary", dictionaryId: created.dictionaryId, key: "count" } };
  const first = f.store.createScriptTest(d.id, null, 0, { token: "shadow-must-not-persist" }, "first", undefined, sources);
  f.dictionaries.update(created.dictionaryId, { requestId: randomUUID(), expectedRevision: 1, operations: [{ op: "set", key: "token", type: "string", value: "second" }] });
  const next = f.store.createScriptTest(d.id, null, 0, {}, "next", undefined, sources);
  assert.equal(f.store.createScriptTest(d.id, null, 0, { token: "shadow-must-not-persist" }, "first", undefined, sources).id, first.id);
  assert.throws(() => f.store.createScriptTest(d.id, null, 0, {}, "first", undefined, sources), { code: "REQUEST_CONFLICT" });
  assert.equal(first.dictionaryBindings.length, 1); assert.deepEqual(first.reusableInput, {}); assert.deepEqual(first.inputSources, sources);
  const runner = new ScriptTestRunner(f.store); t.after(() => runner.close());
  await until(() => f.store.scriptTest(next.id).status === "succeeded");
  assert.deepEqual(f.store.scriptTest(first.id).output, { token: "first", count: 5 });
  assert.deepEqual(f.store.scriptTest(next.id).output, { token: "second", count: 5 });
  assert.equal(disk(f.store.root).includes("shadow-must-not-persist"), false);
});
test("encrypted parameter references never leak into history, results, logs, receipts or Agent context", async t => {
  const f = services(t), secret = `ENCRYPTED-${randomUUID()}`;
  f.secrets.generate({ requestId: randomUUID(), expectedGeneration: 0 });
  const dictionary = f.dictionaries.create({ requestId: randomUUID(), name: "Secret parameters", kind: "encrypted", enabled: true, description: "", operations: [{ op: "set", key: "token", type: "string", value: secret }] });
  await f.library.create(definition());
  const row = f.store.createScriptTest("schema-script", null, 0, {}, "encrypted-test", undefined, { "/token": { source: "dictionary", dictionaryId: dictionary.dictionaryId, key: "token" } });
  const runner = new ScriptTestRunner(f.store); t.after(() => runner.close());
  await until(() => f.store.scriptTest(row.id).status === "succeeded");
  const result = f.store.scriptTest(row.id); assert.equal(result.outputRedacted, true); assert.equal(JSON.stringify(result).includes(secret), false);
  const agent = new ScriptAgentService(f.store, f.providers); t.after(() => agent.close());
  f.provider.handler = async request => { assert.equal(request.prompt.includes(secret), false); return { output: { summary: "Safe", changes: [], metadata: {} }, providerId: f.provider.id, modelId: request.modelId }; };
  const turn = agent.start("schema-script", { providerId: f.provider.id, modelId: "test-model", prompt: "review", expectedRevision: 0, testId: row.id, requestId: randomUUID() });
  await until(() => agent.get("schema-script", turn.id).status === "succeeded");
  assert.equal(disk(f.store.root).includes(secret), false);
});
test("non-recordable manual values exist only in memory, run correctly, and are cleared on success and failure", async t => {
  const f = services(t), secret = `MANUAL-${randomUUID()}`;
  const d = definition({ type: "object", properties: { token: { type: "string", "x-history": { record: false } } }, required: ["token"] });
  await f.library.create(d);
  const row = f.store.createScriptTest(d.id, null, 0, { token: secret }, "manual");
  assert.deepEqual(f.store.scriptTestInput(row.id), { token: secret }); assert.deepEqual(row.reusableInput, {});
  assert.equal(disk(f.store.root).includes(secret), false);
  const runner = new ScriptTestRunner(f.store); t.after(() => runner.close());
  await until(() => f.store.scriptTest(row.id).status === "succeeded");
  assert.equal(f.store.scriptTestHasTransient(row.id), false); assert.equal(f.store.scriptTest(row.id).outputRedacted, true);
  await f.library.update(d.id, { ...d, expectedRevision: 0, files: { "main.ts": "export default input => {throw new Error(input.token)}" } });
  const failed = f.store.createScriptTest(d.id, null, 1, { token: secret }, "failure"); runner.enqueue(failed.id);
  await until(() => f.store.scriptTest(failed.id).status === "failed");
  assert.equal(f.store.scriptTestHasTransient(failed.id), false); assert.equal(disk(f.store.root).includes(secret), false);
  assert.throws(() => f.store.createScriptTest(d.id, null, 1, { token: "different" }, "manual"), { code: "REQUEST_CONFLICT" });
});
test("cancelling queued and running transient tests releases values and never restores them on replay", async t => {
  const f = services(t), secret = `CANCEL-${randomUUID()}`;
  const d = definition({ type: "object", properties: { token: { type: "string", "x-history": { record: false } } } });
  d.files = { "main.ts": "export default async input => {console.log(input.token); await new Promise(r=>setTimeout(r,10000));return input}" };
  await f.library.create(d);
  const queued = f.store.createScriptTest(d.id, null, 0, { token: secret }, "cancel-queued");
  const runner = new ScriptTestRunner(f.store, false); t.after(() => runner.close());
  runner.cancel(queued.id); assert.equal(f.store.scriptTestHasTransient(queued.id), false);
  assert.equal(f.store.createScriptTest(d.id, null, 0, { token: secret }, "cancel-queued").id, queued.id);
  assert.equal(f.store.scriptTestHasTransient(queued.id), false);
  const running = f.store.createScriptTest(d.id, null, 0, { token: secret }, "cancel-running"); runner.start();
  await until(() => f.store.scriptTest(running.id).status === "running"); runner.cancel(running.id);
  await until(() => f.store.scriptTest(running.id).status === "cancelled");
  assert.equal(f.store.scriptTestHasTransient(running.id), false); assert.equal(disk(f.store.root).includes(secret), false);
});

test("restart interrupts queued transient inputs and retains safe replay and history", async t => {
  const f = services(t), secret = `RESTART-${randomUUID()}`;
  await f.library.create(definition({ type: "object", properties: { token: { type: "string" } }, "x-history": { record: false } }));
  const row = f.store.createScriptTest("schema-script", null, 0, { token: secret }, "restart");
  f.store.close();
  const reopened = new TestStore(f.store.root); t.after(() => reopened.close());
  const runner = new ScriptTestRunner(reopened); t.after(() => runner.close());
  assert.equal(reopened.scriptTest(row.id).status, "failed");
  assert.equal(reopened.createScriptTest("schema-script", null, 0, { token: secret }, "restart").id, row.id);
  assert.equal(disk(reopened.root).includes(secret), false);
});
test("Agent applies source and both schemas atomically and generated contracts govern testing", async t => {
  const f = services(t); await f.library.create(definition());
  const inputSchema = { type: "object", properties: { count: { type: "integer", minimum: 0 } }, required: ["count"], additionalProperties: false };
  const outputSchema = { type: "object", properties: { total: { type: "integer" } }, required: ["total"], additionalProperties: false };
  const agent = new ScriptAgentService(f.store, f.providers); t.after(() => agent.close());
  f.provider.handler = async request => {
    assert.match(request.prompt, /x-history/); assert.match(request.prompt, /top-level object parameters/);
    return { output: { summary: "同步维护输入、实现与返回定义", changes: [{ operation: "update", path: "main.ts", content: "export default input => ({total:input.count*2})" }], metadata: { inputSchema, outputSchema }, testInput: { count: 3 } }, providerId: f.provider.id, modelId: request.modelId };
  };
  const turn = agent.start("schema-script", { providerId: f.provider.id, modelId: "test-model", prompt: "change", expectedRevision: 0, requestId: randomUUID() });
  await until(() => agent.get("schema-script", turn.id).status === "succeeded");
  assert.deepEqual(f.library.detail("schema-script").draft!.inputSchema, definition().inputSchema);
  await agent.apply("schema-script", { turnId: turn.id, expectedRevision: 0, requestId: randomUUID() });
  const draft = f.library.detail("schema-script").draft!;
  assert.equal(draft.revision, 1); assert.deepEqual(draft.inputSchema, inputSchema); assert.deepEqual(draft.outputSchema, outputSchema);
  const row = f.store.createScriptTest("schema-script", null, 1, { count: 3 }, randomUUID());
  const runner = new ScriptTestRunner(f.store); t.after(() => runner.close());
  await until(() => f.store.scriptTest(row.id).status === "succeeded");
  assert.deepEqual(f.store.scriptTest(row.id).output, { total: 6 });
});

test("test API accepts structured sources, rejects nested targets, and fails type mismatch before script execution", async t => {
  const f = services(t), { app } = createApp(f.store, f.providers); t.after(() => app.close()); await app.ready();
  await f.library.create(definition());
  const dictionary = f.dictionaries.create({ requestId: randomUUID(), name: "Wrong type", kind: "plain", enabled: true, description: "", operations: [{ op: "set", key: "value", type: "number", value: 7 }] });
  const ref = { source: "dictionary", dictionaryId: dictionary.dictionaryId, key: "value" };
  const bad = await app.inject({ method: "POST", url: "/api/scripts/schema-script/tests", payload: { draftRevision: 0, input: {}, inputSources: { "/token/nested": ref }, requestId: randomUUID() } });
  assert.equal(bad.statusCode, 400);
  const response = await app.inject({ method: "POST", url: "/api/scripts/schema-script/tests", payload: { draftRevision: 0, input: {}, inputSources: { "/token": ref }, requestId: randomUUID() } });
  assert.equal(response.statusCode, 200, response.body); const id = response.json().id;
  await until(() => f.store.scriptTest(id).status === "failed");
  assert.equal((f.store.scriptTest(id).error as { code: string }).code, "SCHEMA_MISMATCH"); assert.equal(f.store.scriptTest(id).exitCode, null);
});
