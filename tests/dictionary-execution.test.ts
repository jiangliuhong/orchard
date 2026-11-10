import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, lstatSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DictionaryService } from "../src/dictionaries/service.js";
import { DictionaryExecution, REDACTED } from "../src/dictionaries/execution.js";
import { KeyringStore, resolveKeyringPath } from "../src/secrets/keyring.js";
import { CommandHmac } from "../src/secrets/command-hmac.js";
import { SecretsService } from "../src/secrets/service.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { ScriptTestRunner } from "../src/runtime/script-tests.js";
import { GraphRunner } from "../src/runtime/runner.js";
import { setup, until, TestStore } from "./helpers.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { ScriptDefinition } from "../src/domain/scripts.js";
import type { Workflow, SourceFiles } from "../src/domain/types.js";
import { configCoordinator } from "../src/config-git/coordinator.js";
import { createApp } from "../src/server/app.js";

const token = "sensitive-value-秘密-" + randomUUID();
function services(t: test.TestContext) {
  const f = setup(t);
  t.after(() => f.store.close());
  const keyring = new KeyringStore(resolveKeyringPath(f.root));
  const secrets = new SecretsService(f.store, keyring, new CommandHmac(f.store, f.root, keyring));
  secrets.generate({ requestId: randomUUID(), expectedGeneration: 0 });
  const dictionaries = new DictionaryService(f.store, secrets);
  const plain = dictionaries.create({ requestId: randomUUID(), name: "Plain", description: "", enabled: true, kind: "plain", operations: [{ op: "set", key: "baseUrl", type: "string", value: "first" }] });
  const encrypted = dictionaries.create({ requestId: randomUUID(), name: "Credentials", description: "", enabled: true, kind: "encrypted", operations: [{ op: "set", key: "token", type: "string", value: token }] });
  const library = new ScriptLibrary(f.store);
  return { ...f, keyring, secrets, dictionaries, plain, encrypted, library };
}
function script(): ScriptDefinition {
  return { id: "dict-execution", name: "Dictionary execution", description: "", runtime: "nodejs", entryFile: "main.ts", inputSchema: true, outputSchema: true, files: { "main.ts": "export default (input,ctx) => ctx.dictionaries.get('service','baseUrl')" } };
}
function graph(): Workflow {
  return { formatVersion: 1, id: "dict-graph", name: "Dictionary graph", inputSchema: true, outputSchema: true, entryNodeId: "a", nodes: [
    { id: "a", name: "Read credential", type: "code.nodejs", input: { source: "workflow" }, outputSchema: true, config: { script: "scripts/a.ts" } },
    { id: "b", name: "Next", type: "code.nodejs", input: { source: "node", nodeId: "a" }, outputSchema: true, config: { script: "scripts/b.ts" } },
  ], edges: [{ id: "ab", from: "a", to: "b" }], result: { source: "object", properties: { value: { source: "node", nodeId: "b" } } } };
}
function allDisk(root: string): string {
  const visit = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) return [];
    return stat.isDirectory() ? visit(path) : [readFileSync(path).toString("utf8")];
  });
  return visit(root).join("\n");
}
async function draft(f: ReturnType<typeof services>, definition: Workflow, source = "export default (input,ctx) => { const value=ctx.secrets.get('credentials','token');console.log(value);console.error(value);return {value}; }") {
  const d = await f.authoring.create(undefined, randomUUID());
  const files: SourceFiles = { "workflow.json": JSON.stringify({ ...definition, id: JSON.parse(f.authoring.snapshot(d.id).files["workflow.json"]!).id }), "scripts/a.ts": source, "scripts/b.ts": "export default input => {console.log(JSON.stringify(input));return input}" };
  const updated = await f.authoring.update(d.id, 0, files);
  return { id: d.id, revision: updated.revision };
}

test("ordinary script tests pin revisions, preserve old queued values and expose only declared keys", async t => {
  const f = services(t), definition = { ...script(), dictionaryBindings: { service: { dictionaryId: f.plain.dictionaryId, kind: "plain" as const, keys: ["baseUrl"] } } };
  await f.library.create(definition);
  const first = f.store.createScriptTest(definition.id, null, 0, {}, "first");
  f.dictionaries.update(f.plain.dictionaryId, { requestId: randomUUID(), expectedRevision: 1, operations: [{ op: "set", key: "baseUrl", type: "string", value: "second" }] });
  const second = f.store.createScriptTest(definition.id, null, 0, {}, "second");
  const tests = new ScriptTestRunner(f.store, false); t.after(() => tests.close()); tests.start();
  await until(() => f.store.scriptTest(first.id).status === "succeeded" && f.store.scriptTest(second.id).status === "succeeded");
  assert.equal(f.store.scriptTest(first.id).output, "first"); assert.equal(f.store.scriptTest(second.id).output, "second");
  assert.equal(f.store.scriptTest(first.id).dictionaryBindings[0]!.versionId, f.plain.versionId);
  f.dictionaries.update(f.plain.dictionaryId, { requestId: randomUUID(), expectedRevision: 2, enabled: false, operations: [] });
  assert.equal(f.store.createScriptTest(definition.id, null, 0, {}, "first").id, first.id);
  assert.throws(() => f.store.createScriptTest(definition.id, null, 0, {}, "third"), { code: "DICTIONARY_DISABLED" });
  assert.throws(() => f.store.createScriptTest(definition.id, null, 0, { different: true }, "first"), { code: "REQUEST_CONFLICT" });
});

test("encrypted independent test hides inputs, logs, output and artifacts without losing execution values", async t => {
  const f = services(t), definition = { ...script(), dictionaryBindings: { credentials: { dictionaryId: f.encrypted.dictionaryId, kind: "encrypted" as const, keys: ["token"] } }, files: { "main.ts": "export default (_,ctx) => {const t=ctx.secrets.get('credentials','token');console.log(t.slice(0,3));console.error(t);return {token:t};}" } };
  await f.library.create(definition);
  const row = f.store.createScriptTest(definition.id, null, 0, { privateInput: "hide this" }, randomUUID());
  assert.equal(row.inputRedacted, true); assert.deepEqual(row.input, REDACTED);
  const tests = new ScriptTestRunner(f.store); t.after(() => tests.close());
  await until(() => f.store.scriptTest(row.id).status === "succeeded");
  const result = f.store.scriptTest(row.id);
  assert.equal(result.outputRedacted, true); assert.equal(result.logsRedacted, true);
  assert.deepEqual(result.output, REDACTED); assert.deepEqual(result.stdout, REDACTED);
  assert.equal(allDisk(f.root).includes(token), false);
  assert.equal(readdirSync(f.store.files.path("runs")).some(name => name.startsWith("script-attempt-")), false);
});

test("encrypted workflow taints downstream inputs, results, events and final output", async t => {
  const f = services(t), definition = graph();
  definition.nodes[0]!.config.dictionaryBindings = { credentials: { dictionaryId: f.encrypted.dictionaryId, kind: "encrypted", keys: ["token"] } };
  const d = await draft(f, definition);
  const runner = new GraphRunner(f.store, f.providers); t.after(() => runner.close());
  const run = await runner.createDraft(d.id, d.revision, {}, randomUUID());
  await until(() => f.store.run(run.id).status === "succeeded" || f.store.run(run.id).status === "failed");
  assert.equal(f.store.run(run.id).status, "succeeded", JSON.stringify(f.store.run(run.id).error));
  assert.equal(f.store.run(run.id).outputRedacted, true);
  for (const node of f.store.nodes(run.id)) { assert.equal(node.inputRedacted, true); assert.equal(node.outputRedacted, true); assert.equal(node.logsRedacted, true); }
  const serialized = JSON.stringify(runner.snapshot(run.id));
  assert.equal(serialized.includes(token), false); assert.equal(JSON.stringify(f.store.stream("run", run.id)).includes(token), false);
  assert.equal(f.store.stream("run", run.id).some(event => event.type === "node.log"), false);
  assert.equal(allDisk(f.root).includes(token), false);
});

test("Shell context and Node whitelist work, no secret values in environment or argv", async t => {
  const f = services(t);
  const definition: ScriptDefinition = { ...script(), runtime: "shell", entryFile: "main.sh", resultMode: "json", dictionaryBindings: {
    credentials: { dictionaryId: f.encrypted.dictionaryId, kind: "encrypted", keys: ["token"] },
    service: { dictionaryId: f.plain.dictionaryId, kind: "plain", keys: ["baseUrl"] },
  }, files: { "main.sh": `"$ORCHARD_NODE_EXECUTABLE" "$ORCHARD_DICTIONARY_HELPER" secret credentials token --raw > "$ORCHARD_RESULT_FILE.token"\n"$ORCHARD_NODE_EXECUTABLE" -e 'const fs=require("fs");const t=fs.readFileSync(process.env.ORCHARD_RESULT_FILE+".token","utf8");if(t.length<3)process.exit(2);fs.writeFileSync(process.env.ORCHARD_RESULT_FILE,JSON.stringify({ok:!process.env.ORCHARD_HOST_SECRET}));'` } };
  process.env.ORCHARD_HOST_SECRET = token; t.after(() => { delete process.env.ORCHARD_HOST_SECRET; });
  await f.library.create(definition);
  const row = f.store.createScriptTest(definition.id, null, 0, {});
  const tests = new ScriptTestRunner(f.store); t.after(() => tests.close());
  await until(() => ["succeeded", "failed"].includes(f.store.scriptTest(row.id).status));
  assert.equal(f.store.scriptTest(row.id).status, "succeeded", JSON.stringify(f.store.scriptTest(row.id).error));
  assert.equal(allDisk(f.root).includes(token), false);
});

test("secret Schema failure, thrown errors, final-result failure and undeclared access stay safe", async t => {
  const f = services(t), definition = graph();
  definition.nodes[0]!.config.dictionaryBindings = { credentials: { dictionaryId: f.encrypted.dictionaryId, kind: "encrypted", keys: ["token"] } };
  definition.outputSchema = { type: "number" };
  const d = await draft(f, definition);
  const runner = new GraphRunner(f.store, f.providers); t.after(() => runner.close());
  const run = await runner.createDraft(d.id, d.revision, {}, randomUUID());
  await until(() => f.store.run(run.id).status === "failed");
  assert.equal(f.store.run(run.id).error?.code, "SCHEMA_MISMATCH");
  assert.equal(f.store.run(run.id).error?.message.includes(token), false);
  assert.equal(allDisk(f.root).includes(token), false);
  const missing = { ...script(), dictionaryBindings: { credentials: { dictionaryId: f.encrypted.dictionaryId, kind: "encrypted" as const, keys: ["token"] } }, files: { "main.ts": "export default (_,ctx)=>ctx.secrets.get('credentials','notDeclared')" } };
  await f.library.create(missing);
  const row = f.store.createScriptTest(missing.id, null, 0, {});
  const tests = new ScriptTestRunner(f.store); t.after(() => tests.close());
  await until(() => f.store.scriptTest(row.id).status === "failed");
  assert.equal((f.store.scriptTest(row.id).error as { code: string })?.code, "PROCESS_FAILED");
  assert.equal(allDisk(f.root).includes(token), false);
});

test("missing keys and admission races leave no task, binding or receipt", async t => {
  const f = services(t), definition = { ...script(), dictionaryBindings: { credentials: { dictionaryId: f.encrypted.dictionaryId, kind: "encrypted" as const, keys: ["token"] } } };
  await f.library.create(definition);
  f.keyring.save({ ...f.keyring.load()!, generation: 2, keys: [], activeKeyId: undefined });
  assert.throws(() => f.store.createScriptTest(definition.id, null, 0, {}, "no-key"), { code: "SECRET_KEY_MISSING" });
  assert.equal(f.store.all("SELECT * FROM script_tests").length, 0);
  assert.equal(f.store.all("SELECT * FROM script_test_dictionary_bindings").length, 0);
  assert.equal(f.store.one("SELECT * FROM command_receipts WHERE request_id='no-key'"), undefined);
  assert.throws(() => configCoordinator(f.store).withWrite(() => f.store.createScriptTest(definition.id, null, 0, {})), { code: "CONFIG_BUSY" });
});

test("restart preserves queued bindings and cleans only the private attempt namespace before execution", async t => {
  const f = services(t), definition = graph();
  definition.nodes[0]!.input = { source: "dictionary", dictionaryId: f.plain.dictionaryId, key: "baseUrl" };
  const d = await draft(f, definition, "export default input=>input");
  const before = new GraphRunner(f.store, f.providers, undefined, false);
  const queued = await before.createDraft(d.id, d.revision, {}, randomUUID());
  f.dictionaries.update(f.plain.dictionaryId, { requestId: randomUUID(), expectedRevision: 1, operations: [{ op: "set", key: "baseUrl", type: "string", value: "after-restart" }] });
  const residue = f.store.files.path(`runs/script-attempt-${randomUUID()}`), unrelated = f.store.files.path("runs/keep-this-run");
  mkdirSync(residue, { recursive: true, mode: 0o700 }); writeFileSync(join(residue, "context.json"), token, { mode: 0o600 });
  mkdirSync(unrelated, { recursive: true }); writeFileSync(join(unrelated, "keep.txt"), "keep");
  await before.close(); f.store.close();
  const reopened = new TestStore(f.root); t.after(() => reopened.close());
  const runner = new GraphRunner(reopened, new ProviderRegistry(reopened)); t.after(() => runner.close());
  assert.equal(existsSync(residue), false); assert.equal(existsSync(join(unrelated, "keep.txt")), true);
  await until(() => ["succeeded", "failed"].includes(reopened.run(queued.id).status));
  assert.equal(reopened.run(queued.id).status, "succeeded", JSON.stringify(reopened.run(queued.id).error));
  assert.deepEqual(reopened.run(queued.id).output, { value: "first" });
  assert.equal(reopened.run(queued.id).dictionaryBindings?.[0]!.versionId, f.plain.versionId);
});

test("large script input and snapshot files prepare outside admission transactions and receipts stay bounded", async t => {
  const f = services(t);
  await f.library.create({ ...script(), files: { "main.ts": "export default input=>input;\n/*" + "x".repeat(40000) + "*/" } });
  const prepare = f.store.prepareReference.bind(f.store);
  const attach = f.store.attachPreparedReference.bind(f.store);
  let preparing = 0, attaching = 0;
  f.store.prepareReference = value => { preparing++; assert.equal(f.store.db.isTransaction, false); return prepare(value); };
  f.store.attachPreparedReference = value => { attaching++; assert.equal(f.store.db.isTransaction, true); return attach(value); };
  const input = { value: "a".repeat(40000) };
  const row = f.store.createScriptTest("dict-execution", null, 0, input, "large-test");
  assert.equal(preparing, 2); assert.equal(attaching, 2);
  assert.deepEqual(f.store.scriptTestInput(row.id), input);
  assert.ok(String(f.store.one("SELECT result_json FROM command_receipts WHERE request_id='large-test'")!.result_json).length < 100);
});
