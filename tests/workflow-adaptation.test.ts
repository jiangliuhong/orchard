import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setup, until, TestStore } from "./helpers.js";
import { GraphRunner } from "../src/runtime/runner.js";
import { json } from "../src/persistence/files.js";
import { validateWorkflow } from "../src/domain/validation.js";
import { REDACTED } from "../src/dictionaries/execution.js";
import { DictionaryService } from "../src/dictionaries/service.js";
import { SecretsService } from "../src/secrets/service.js";
import { KeyringStore, resolveKeyringPath } from "../src/secrets/keyring.js";
import { CommandHmac } from "../src/secrets/command-hmac.js";
import { createApp } from "../src/server/app.js";
import type { Workflow, SourceFiles } from "../src/domain/types.js";
import type { ScriptDefinition } from "../src/domain/scripts.js";
import { hasPrivateHistory, privateWorkflowHistory } from "../src/runtime/workflow-history.js";
import { dictionaryDependencies, exportDictionaries } from "../src/config-git/dictionaries.js";
import type { PortableSnapshot } from "../src/config-git/snapshot-types.js";

const secret = "workflow-private-test-value";
const privateSchema = { type: "object", properties: { token: { type: "string", "x-history": { record: false } } }, required: ["token"] };
function scriptWorkflow(store: TestStore, code = "console.log(input.token); return input;", schema = privateSchema) {
  const definition: ScriptDefinition = { id: "private-script", name: "Private", description: "", runtime: "nodejs", entryFile: "main.js", inputSchema: schema, outputSchema: true, files: { "main.js": `export default input => { ${code} }` } };
  const tree = store.files.saveScriptTree(definition.files), created = store.createScript(definition, tree.path, tree.hash);
  const version = store.publishScript(definition.id, created.version.revision).version;
  const workflow: Workflow = { formatVersion: 1, id: "private-workflow", name: "Private workflow", inputSchema: { type: "object" }, outputSchema: true, entryNodeId: "script", nodes: [{ id: "script", name: "Script", type: "script", input: { source: "workflow" }, outputSchema: true, config: { scriptId: definition.id, scriptVersionId: version.id } }], edges: [], result: { source: "node", nodeId: "script" } };
  return workflow;
}
function publish(store: TestStore, workflow: Workflow) {
  validateWorkflow(workflow);
  const tree = store.files.saveTree({ "workflow.json": json(workflow), "layout.json": "{}" }), id = randomUUID(), now = Date.now();
  store.exec("INSERT INTO workflows VALUES(?,?,NULL,?,?)", workflow.id, workflow.name, now, now);
  store.exec("INSERT INTO workflow_versions VALUES(?,?,?,?,?,?,?,?)", id, workflow.id, 1, json(workflow), "{}", tree.path, tree.hash, now);
  store.exec("UPDATE workflows SET current_version_id=? WHERE id=?", id, workflow.id);
  return id;
}
function noSecret(store: TestStore, id: string) {
  assert.ok(!json({ run: store.run(id), nodes: store.nodes(id), attempts: store.attempts(id), events: store.stream("run", id) }).includes(secret));
  for (const table of ["runs", "node_runs", "node_attempts", "stream_events", "command_receipts"]) {
    assert.ok(!json(store.all(`SELECT * FROM ${table}`)).includes(secret), table);
  }
  const scan = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name); if (entry.isDirectory()) scan(child); else assert.ok(!readFileSync(child).includes(Buffer.from(secret)), child);
  } };
  scan(store.files.path("artifacts"));
}

test("private script contracts protect published workflow input, output, logs, events, artifacts and keyed replay", async t => {
  const { store, providers } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); store.close(); });
  const version = publish(store, scriptWorkflow(store)), requestId = randomUUID();
  const run = runner.create(version, { token: secret }, requestId);
  assert.deepEqual(run.input, REDACTED); assert.equal(run.inputRedacted, true);
  await until(() => store.run(run.id).status === "succeeded");
  assert.deepEqual(store.run(run.id).output, REDACTED);
  assert.equal(runner.create(version, { token: secret }, requestId).id, run.id);
  assert.throws(() => runner.create(version, { token: "different" }, requestId), { code: "REQUEST_CONFLICT" });
  const receipt = store.one<{ request_hash: string }>("SELECT request_hash FROM command_receipts WHERE scope=? AND request_id=?", `private-run:${version}`, requestId)!;
  assert.notEqual(receipt.request_hash, createHash("sha256").update(json({ token: secret })).digest("hex"));
  noSecret(store, run.id);
});

test("private draft runs hide echoed errors, preserve idempotency and clear transient values", async t => {
  const { store, providers, authoring } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); store.close(); });
  const workflow = scriptWorkflow(store, "throw new Error(input.token)");
  workflow.inputSchema = privateSchema;
  const files: SourceFiles = { "workflow.json": json(workflow), "layout.json": "{}" };
  const initial = await authoring.create(undefined, randomUUID());
  workflow.id = JSON.parse(authoring.snapshot(initial.id).files["workflow.json"]!).id;
  files["workflow.json"] = json(workflow);
  const draft = await authoring.update(initial.id, initial.revision, files), requestId = randomUUID();
  const run = await runner.createDraft(draft.id, draft.revision, { token: secret }, requestId);
  await until(() => store.run(run.id).status === "failed");
  assert.equal((await runner.createDraft(draft.id, draft.revision, { token: secret }, requestId)).id, run.id);
  assert.equal((runner as any).privateInputs.has(run.id), false);
  noSecret(store, run.id);
});

test("queued private workflow inputs are cleared by cancellation and cannot resume after restart", async t => {
  const { store, providers, root } = setup(t), runner = new GraphRunner(store, providers, undefined, false);
  const version = publish(store, scriptWorkflow(store));
  const cancelled = runner.create(version, { token: secret }, randomUUID());
  runner.cancel(cancelled.id);
  assert.equal((runner as any).privateInputs.has(cancelled.id), false);
  const requestId = randomUUID(), queued = runner.create(version, { token: secret }, requestId);
  store.close();
  const recovered = new TestStore(root), restarted = new GraphRunner(recovered, providers, undefined, false);
  t.after(async () => { await restarted.close(); recovered.close(); });
  assert.equal(restarted.create(version, { token: secret }, requestId).id, queued.id);
  restarted.start();
  await until(() => recovered.run(queued.id).status === "failed");
  assert.equal(recovered.run(queued.id).error?.code, "INTERRUPTED");
  noSecret(recovered, queued.id);
});

test("private history policy detects nested branches, references and bridge parameter schemas", () => {
  assert.equal(hasPrivateHistory({ $defs: { private: privateSchema }, $ref: "#/$defs/private" }), true);
  assert.equal(hasPrivateHistory({ anyOf: [true, privateSchema] }), true);
  assert.equal(hasPrivateHistory({ type: "object", properties: { value: { type: "string" } } }), false);
  const workflow: Workflow = { formatVersion: 1, id: "bridge-policy", name: "Bridge policy", inputSchema: true, outputSchema: true, entryNodeId: "call", nodes: [{ id: "call", name: "Call", type: "web-bridge", input: { source: "workflow" }, outputSchema: true, config: { application: "crm", tool: "lookup" } }], edges: [], result: { source: "node", nodeId: "call" } };
  assert.equal(privateWorkflowHistory(workflow, () => { throw new Error("not a script"); }, () => privateSchema), true);
  assert.equal(privateWorkflowHistory(workflow, () => { throw new Error("not a script"); }, () => true), false);
});

for (const succeeds of [true, false]) test(`private workflow bridge history omits arguments on ${succeeds ? "success" : "failure"}`, async t => {
  const { store, providers } = setup(t), { app, bridge, runner } = createApp(store, providers);
  await app.ready(); t.after(() => app.close());
  bridge.saveApplication({ id: "crm", name: "CRM" });
  const tool = { toolId: "lookup", application: "crm", site: "crm", description: "Lookup", path: "/lookup", method: "GET" as const, parameters: { type: "object" }, fields: [], risk: "read" as const, approval: "none" as const, timeoutMs: 5000, catalogVersion: "1", enabled: true,
    execution: { version: 1 as const, transport: "browser" as const, preprocess: { runtime: "nodejs" as const, code: "return {...request, headers: {}};" }, response: { mode: "fullJson" as const, maxBytes: 262144 } } };
  bridge.saveTool(tool);
  if (succeeds) {
    bridge.saveEnvironment("crm", { origin: "https://gateway.test", profileId: "work" });
    bridge.browserChannel.register("work", "a".repeat(32));
  }
  const workflow: Workflow = { formatVersion: 1, id: "private-bridge", name: "Private bridge", inputSchema: privateSchema, outputSchema: true, entryNodeId: "call",
    nodes: [{ id: "call", name: "Call", type: "web-bridge", input: { source: "workflow" }, outputSchema: true, config: { application: "crm", tool: "lookup" } }], edges: [], result: { source: "node", nodeId: "call" } };
  const run = runner.create(publish(store, workflow), { token: secret }, randomUUID());
  if (succeeds) {
    const calls = await until(() => { const calls = bridge.browserChannel.poll("work"); return calls.length ? calls : false; });
    bridge.browserChannel.complete("work", calls[0]!.id, { ok: true });
  }
  await until(() => store.run(run.id).status === (succeeds ? "succeeded" : "failed"));
  noSecret(store, run.id);
  // Reapplying the permissive tool policy must not restore omitted workflow arguments.
  const record = bridge.history.list("crm", "lookup", tool)[0]!;
  assert.equal(record.status, succeeds ? "succeeded" : "failed");
  assert.equal(record.args, null);
  assert.equal(record.redacted, true);
  assert.deepEqual(record.argSources, { "": { source: "omitted", reason: "schema-policy" } });
  assert.ok(!readFileSync(store.files.path("runtime/bridge-history.json"), "utf8").includes(secret));

  // Ordinary calls retain their independently permitted arguments.
  await bridge.call("crm", "lookup", { token: "public-example" }, { environmentId: "missing" }).catch(() => {});
  assert.deepEqual(bridge.history.list("crm", "lookup", tool)[0]!.args, { token: "public-example" });
});

for (const kind of ["plain", "encrypted"] as const) test(`${kind} browser workflow credentials pin dictionary values, override defaults and remain separate from arguments`, async t => {
  const { store, providers } = setup(t), { app, bridge } = createApp(store, providers);
  await app.ready(); t.after(() => app.close());
  const keyring = new KeyringStore(resolveKeyringPath(store.root));
  const secrets = new SecretsService(store, keyring, new CommandHmac(store, store.root, keyring));
  if (kind === "encrypted") secrets.generate({ requestId: randomUUID(), expectedGeneration: 0 });
  const dictionaries = new DictionaryService(store, secrets);
  const dictionary = dictionaries.create({ requestId: randomUUID(), name: "Browser credential", description: "", kind, enabled: true, operations: [{ op: "set", key: "token", type: "string", value: "first-token" }] });
  bridge.saveApplication({ id: "crm", name: "CRM" });
  bridge.saveEnvironment("crm", { origin: "https://gateway.test", profileId: "work" });
  bridge.browserChannel.register("work", "a".repeat(32));
  bridge.httpDependencies.resolveCredential = () => "default-token";
  bridge.saveTool({ toolId: "lookup", application: "crm", site: "crm", description: "Lookup", path: "/lookup", method: "GET", parameters: { type: "object", additionalProperties: false }, fields: [], risk: "read", approval: "none", timeoutMs: 5000, catalogVersion: "1", enabled: true, execution: { version: 1, transport: "browser", credentialInputs: ["token", "other"], preprocess: { runtime: "nodejs", code: "return {...request, headers:{Authorization:credentials.token, other:credentials.other}}", credentials: { other: { dictionaryId: "legacy-default", key: "other" } } }, response: { mode: "fullJson", maxBytes: 262144 } } });
  const workflow: Workflow = { formatVersion: 1, id: "browser-workflow", name: "Browser workflow", inputSchema: true, outputSchema: true, entryNodeId: "call", nodes: [{ id: "call", name: "Call", type: "web-bridge", input: { source: "literal", value: {} }, outputSchema: true, config: { application: "crm", tool: "lookup", credentialBindings: { token: { source: "dictionary", dictionaryId: dictionary.dictionaryId, key: "token" } } } }], edges: [], result: { source: "node", nodeId: "call" } };
  const runner = new GraphRunner(store, providers, bridge, false);
  t.after(() => runner.close());
  const version = publish(store, workflow), run = runner.create(version, {}, randomUUID());
  dictionaries.update(dictionary.dictionaryId, { requestId: randomUUID(), expectedRevision: dictionary.revision, operations: [{ op: "set", key: "token", type: "string", value: "second-token" }] });
  runner.start();
  const calls = await until(() => { const calls = bridge.browserChannel.poll("work"); return calls.length ? calls : false; });
  const payload = calls[0].payload as { request: { headers: Record<string, string> } };
  assert.deepEqual(payload.request.headers, { Authorization: "first-token", other: "default-token" });
  bridge.browserChannel.complete("work", calls[0].id, { ok: true });
  await until(() => store.run(run.id).status === "succeeded");
  assert.deepEqual(store.nodes(run.id)[0]!.input, {});
  assert.ok(!json(runner.snapshot(run.id)).includes("first-token"));
  const invalid = structuredClone(workflow); (invalid.nodes[0]!.config as any).credentialBindings.token = { source: "inline", value: secret };
  assert.throws(() => validateWorkflow(invalid), { code: "SCHEMA_MISMATCH" });
  const snapshot: PortableSnapshot = { general: { theme: "system" }, providers: [], scripts: [], dictionaries: exportDictionaries(store), webBridge: { applications: {}, environments: {}, tools: {}, enabledTools: {} }, workflows: [{ id: workflow.id, name: workflow.name, currentPublishedVersionId: version, draft: null, versions: [{ id: version, files: { "workflow.json": json(workflow), "layout.json": "{}" } }] }] };
  assert.ok(dictionaryDependencies(snapshot, snapshot.workflows.find(w => w.id === workflow.id)!).some(d => d.id === dictionary.dictionaryId));
});
