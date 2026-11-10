import test from "node:test";
import assert from "node:assert/strict";
import { validateScript } from "../src/domain/scripts.js";
import { executeScript } from "../src/runtime/script.js";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { setup, until } from "./helpers.js";
import { checkScriptSource } from "../src/runtime/script.js";
import { ScriptTestRunner } from "../src/runtime/script-tests.js";

const valid = () => ({
  id: "normalize-text", name: "Normalize text", description: "trim text", runtime: "nodejs" as const,
  entryFile: "main.ts", inputSchema: { type: "object" }, outputSchema: { type: "object" }, files: { "main.ts": "export default input => input" },
});

test("script definition accepts a version-local Node.js entry file", () => {
  assert.equal(validateScript(valid()).entryFile, "main.ts");
});

test("script validation rejects path traversal and wrong runtime extensions", () => {
  assert.throws(() => validateScript({ ...valid(), entryFile: "../main.ts", files: { "../main.ts": "x" } }), /入口文件无效/);
  assert.throws(() => validateScript({ ...valid(), runtime: "shell", entryFile: "main.ts", files: { "main.ts": "x" } }), /入口文件无效/);
});

test("script validation rejects a missing entry file and oversized source", () => {
  assert.throws(() => validateScript({ ...valid(), entryFile: "missing.ts" }), /入口文件不存在/);
  assert.throws(() => validateScript({ ...valid(), files: { "main.ts": "x".repeat(1024 * 1024 + 1) } }), /超过 1 MiB/);
});

test("script execution uses the same bounded process protocol for Node.js and Shell", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchard-script-"));
  const node = await executeScript({ runtime: "nodejs", entryFile: "main.ts", files: { "main.ts": "export default value => ({ doubled: value.n * 2 })" }, input: { n: 3 }, cwd, timeoutMs: 5000 });
  assert.deepEqual(node.output, { doubled: 6 });
  const shell = await executeScript({ runtime: "shell", entryFile: "main.sh", files: { "main.sh": "read input; printf '%s' \"$input\"" }, input: { ok: true }, cwd, timeoutMs: 5000 });
  assert.equal((shell.output as { stdout: string }).stdout, JSON.stringify({ ok: true }));
});

test("dictionary runtime files do not collide with version-local source filenames", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "orchard-script-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const declared of [false, true]) {
    const result = await executeScript({
      runtime: "nodejs", entryFile: "dictionary-helper.mjs",
      files: { "dictionary-helper.mjs": declared ? "export default (_, ctx) => ctx.dictionaries.get('settings', 'value')" : "export default () => 42" },
      ...(declared ? {
        dictionaryBindings: { settings: { dictionaryId: randomUUID(), kind: "plain" as const, keys: ["value"] } },
        dictionaryContext: { dictionaries: { settings: { value: 42 } }, secrets: {} },
      } : {}),
      input: {}, cwd, timeoutMs: 5000,
    });
    assert.equal(result.output, 42);
    assert.deepEqual(readdirSync(cwd), []);
  }
});

test("script execution enforces timeout and output limits", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchard-script-"));
  await assert.rejects(executeScript({ runtime: "shell", entryFile: "main.sh", files: { "main.sh": "sleep 2" }, input: {}, cwd, timeoutMs: 20 }), { code: "TIMEOUT" });
  await assert.rejects(executeScript({ runtime: "shell", entryFile: "main.sh", files: { "main.sh": "head -c 100000 /dev/zero" }, input: {}, cwd, timeoutMs: 5000, maxBytes: 1024 }), { code: "OUTPUT_LIMIT" });
});

test("script validation checks output schema even when null does not match the input schema", () => {
  assert.throws(() => validateScript({ ...valid(), outputSchema: { type: "invalid-type" } }), /脚本输出/);
  assert.throws(() => validateScript({ ...valid(), inputSchema: undefined }), /Schema 必须声明/);
});

test("script source checks reject syntax errors and imports outside the version without executing code", async () => {
  await assert.rejects(checkScriptSource({ ...valid(), files: { "main.ts": "export default function(" } }));
  await assert.rejects(checkScriptSource({ ...valid(), files: { "main.ts": "export const missingDefault = true" } }), { code: "INVALID_SCRIPT" });
  await assert.rejects(checkScriptSource({ ...valid(), files: { "main.ts": "import secret from '/etc/passwd'; export default () => secret" } }));
  await assert.rejects(checkScriptSource({ ...valid(), files: { "main.ts": "import dependency from 'react'; export default () => dependency" } }));
  await assert.rejects(checkScriptSource({ runtime: "shell", entryFile: "main.sh", files: { "main.sh": "if then" } }));
  await checkScriptSource({ ...valid(), files: { "main.ts": "throw new Error('must not execute'); export default input => input" } });
});

test("HTTP script management preserves versions, validates publication, copies and filters", async t => {
  const { store, providers } = setup(t), { app } = createApp(store, providers);
  t.after(() => app.close());
  const call = async (method: "GET" | "POST" | "PATCH", path: string, payload?: unknown, status = 200) => {
    const response = await app.inject({ method, url: `/api${path}`, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }) });
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  };
  const definition = valid();
  const created = await call("POST", "/scripts", definition);
  assert.equal(created.version.revision, 0);
  const publish = { expectedRevision: 0, requestId: randomUUID() };
  const first = await call("POST", `/scripts/${definition.id}/publish`, publish);
  assert.equal((await call("POST", `/scripts/${definition.id}/publish`, publish)).version.id, first.version.id);
  assert.equal((await call("GET", "/scripts?status=published&runtime=nodejs&q=normalize")).total, 1);
  assert.equal((await call("GET", "/scripts?q=missing")).total, 0);
  await call("GET", "/scripts?limit=0", undefined, 400);
  await call("PATCH", `/scripts/${definition.id}/draft`, { ...definition, expectedRevision: 0, files: { "main.ts": "export default () => ({next:true})" } });
  assert.equal(store.script(definition.id).status, "published");
  assert.equal(store.scriptVersion(first.version.id).contentHash, first.version.contentHash);
  await call("PATCH", `/scripts/${definition.id}/draft`, { ...definition, expectedRevision: 0 }, 409);
  const invalid = await call("PATCH", `/scripts/${definition.id}/draft`, { ...definition, expectedRevision: 1, files: { "main.ts": "export default function(" } });
  assert.equal(invalid.version.validation.valid, false);
  assert.ok(invalid.version.validation.diagnostics.length);
  assert.equal((await call("POST", `/scripts/${definition.id}/publish`, publish)).version.id, first.version.id);
  await call("POST", `/scripts/${definition.id}/publish`, { expectedRevision: 2, requestId: randomUUID() }, 400);
  const copyPayload = { id: "script-copy", name: "Copy", versionId: first.version.id, requestId: randomUUID() };
  const copy = await call("POST", `/scripts/${definition.id}/copy`, copyPayload);
  assert.equal(copy.script.status, "draft");
  assert.deepEqual((await call("GET", `/scripts/${copy.script.id}/versions/${copy.version.id}`)).files, definition.files);
  assert.equal((await call("POST", `/scripts/${definition.id}/copy`, copyPayload)).script.id, copy.script.id);
  await call("POST", `/scripts/${definition.id}/copy`, { ...copyPayload, versionId: copy.version.id, requestId: randomUUID() }, 404);
  await call("POST", `/scripts/${definition.id}/archive`);
  await call("PATCH", `/scripts/${definition.id}/draft`, { ...definition, expectedRevision: 2 }, 400);
  assert.equal((await call("GET", `/scripts/${definition.id}/versions/${first.version.id}`)).files["main.ts"], definition.files["main.ts"]);
});

test("HTTP script tests reject invalid input and retain output and logs on schema failure", async t => {
  const { store, providers } = setup(t), { app } = createApp(store, providers);
  t.after(() => app.close());
  const definition = { ...valid(), outputSchema: { type: "object", required: ["expected"], properties: { expected: { type: "boolean" } } }, files: { "main.ts": "export default input => { console.log('test log'); return input; }" } };
  const created = await app.inject({ method: "POST", url: "/api/scripts", payload: definition });
  assert.equal(created.statusCode, 200, created.body);
  for (const input of [null, { wrong: true }]) {
    const response = await app.inject({ method: "POST", url: `/api/scripts/${definition.id}/tests`, payload: { draftRevision: 0, input, requestId: randomUUID() } });
    assert.equal(response.statusCode, 200, response.body);
    const done = await until(() => { const test = store.scriptTest(response.json().id); return test.status === "failed" && test; });
    assert.equal((done.error as { code: string }).code, "SCHEMA_MISMATCH");
    if (input !== null) {
      assert.deepEqual(done.output, input);
      assert.match(done.stdout as string, /test log/);
      assert.equal(done.exitCode, 0);
    }
  }
});

test("script tests cancel queued and running work and recover interrupted tests", async t => {
  const { store } = setup(t);
  t.after(() => store.close());
  const definition = { ...valid(), files: { "main.ts": "export default async () => { await new Promise(resolve => setTimeout(resolve, 5000)); return {}; }" } };
  const tree = store.files.saveScriptTree(definition.files);
  store.createScript(definition, tree.path, tree.hash);
  const interrupted = store.createScriptTest(definition.id, null, 0, {});
  store.setScriptTestRunning(interrupted.id);
  const runner = new ScriptTestRunner(store);
  t.after(() => runner.close());
  assert.equal(store.scriptTest(interrupted.id).status, "failed");
  assert.equal((store.scriptTest(interrupted.id).error as { code: string }).code, "INTERRUPTED");
  const queued = store.createScriptTest(definition.id, null, 0, {});
  assert.equal(runner.cancel(queued.id).status, "cancelled");
  const running = store.createScriptTest(definition.id, null, 0, {});
  runner.enqueue(running.id);
  await until(() => store.scriptTest(running.id).status === "running");
  runner.cancel(running.id);
  await until(() => store.scriptTest(running.id).status === "cancelled");
});

test("script failures retain process logs and exit codes", async t => {
  const { store } = setup(t), runner = new ScriptTestRunner(store);
  t.after(async () => { await runner.close(); store.close(); });
  const definition = { ...valid(), runtime: "shell" as const, entryFile: "main.sh", files: { "main.sh": "echo 'progress'; echo 'reason' >&2; exit 7" } };
  const tree = store.files.saveScriptTree(definition.files);
  store.createScript(definition, tree.path, tree.hash);
  const test = store.createScriptTest(definition.id, null, 0, {});
  runner.enqueue(test.id);
  const done = await until(() => { const current = store.scriptTest(test.id); return current.status === "failed" && current; });
  assert.equal(done.exitCode, 7);
  assert.equal(done.stdout, "progress\n");
  assert.equal(done.stderr, "reason\n");
});
