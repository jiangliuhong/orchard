import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createApp } from "../src/server/app.js";
import { setupLegacy as setup, until } from "./helpers.js";
import type { ScriptDefinition } from "../src/domain/scripts.js";

const definition = (id = "delete-script"): ScriptDefinition => ({ id, name: "待删除脚本", description: "", runtime: "nodejs", entryFile: "main.ts", inputSchema: true, outputSchema: true, files: { "main.ts": "export default input => input" } });

test("script deletion removes versions, tests, conversations and receipts, preserves shared sources and is idempotent", async context => {
  const { store, providers, provider } = setup(context), { app, scripts, scriptAgent } = createApp(store, providers);
  context.after(() => app.close());
  await app.ready();
  const input = { ...definition(), requestId: randomUUID() }, created = await scripts.create(input);
  const copy = await scripts.copy(input.id, { id: "kept-script", name: input.name, versionId: created.version.id, requestId: randomUUID() });
  store.publishScript(input.id, 0);
  const record = store.createScriptTest(input.id, created.version.id, null, {}, randomUUID());
  store.setScriptTestRunning(record.id);
  store.finishScriptTest(record.id, { status: "succeeded", stdout: "", stderr: "" });
  await scripts.update(input.id, { ...definition(), expectedRevision: 0 });
  provider.handler = async request => ({ output: { summary: "说明", changes: [], metadata: {} }, providerId: provider.id, modelId: request.modelId });
  const turn = scriptAgent.start(input.id, { prompt: "说明", expectedRevision: 1, providerId: provider.id, modelId: "test-model", requestId: randomUUID() });
  await until(() => !["queued", "running"].includes(scriptAgent.get(input.id, turn.id).status));
  const response = await app.inject({ method: "DELETE", url: `/api/scripts/${input.id}` });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(store.one("SELECT id FROM scripts WHERE id=?", input.id), undefined);
  assert.equal(store.one("SELECT id FROM script_versions WHERE script_id=?", input.id), undefined);
  assert.equal(store.one("SELECT id FROM script_tests WHERE script_id=?", input.id), undefined);
  assert.equal(existsSync(store.files.path(`script-agent/${input.id}`)), false);
  assert.ok(existsSync(store.files.path(copy.version.sourceRef)));
  assert.equal(scripts.detail(copy.script.id).id, copy.script.id);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/scripts/${input.id}` })).statusCode, 200);
  assert.notEqual((await scripts.create(input)).version.id, created.version.id);
});

test("script deletion rejects active tests and Agent turns", async context => {
  const { store, providers, provider } = setup(context), { app, scripts, scriptAgent } = createApp(store, providers);
  context.after(() => app.close());
  await app.ready(); await scripts.create(definition());
  const record = store.createScriptTest("delete-script", null, 0, {});
  assert.equal((await app.inject({ method: "DELETE", url: "/api/scripts/delete-script" })).json().code, "SCRIPT_BUSY");
  store.setScriptTestRunning(record.id);
  assert.throws(() => scripts.delete("delete-script"), { code: "SCRIPT_BUSY" });
  store.finishScriptTest(record.id, { status: "cancelled", stdout: "", stderr: "" });
  provider.handler = request => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  const turn = scriptAgent.start("delete-script", { prompt: "修改", expectedRevision: 0, providerId: provider.id, modelId: "test-model", requestId: randomUUID() });
  assert.throws(() => scripts.delete("delete-script"), { code: "SCRIPT_BUSY" });
  await until(() => scriptAgent.get("delete-script", turn.id).status === "running");
  scriptAgent.cancel("delete-script", turn.id);
  await until(() => scriptAgent.get("delete-script", turn.id).status === "cancelled");
  assert.equal(scripts.delete("delete-script").deleted, true);
});

test("script deletion protects workflow drafts and published references", async context => {
  const { store, providers } = setup(context), { app, scripts, authoring } = createApp(store, providers);
  context.after(() => app.close());
  await app.ready(); const created = await scripts.create(definition());
  const published = store.publishScript(created.script.id, 0);
  const draft = await authoring.create(undefined, randomUUID()), files = authoring.snapshot(draft.id).files;
  const workflow = JSON.parse(files["workflow.json"]!);
  workflow.nodes[0] = { ...workflow.nodes[0], type: "script", config: { scriptId: created.script.id, scriptVersionId: published.version.id }, input: { source: "literal", value: {} }, outputSchema: true };
  files["workflow.json"] = JSON.stringify(workflow);
  const updated = await authoring.update(draft.id, 0, files);
  assert.equal(updated.validation.valid, true);
  assert.throws(() => scripts.delete(created.script.id), { code: "SCRIPT_REFERENCED" });
  await authoring.publish(draft.id, 1, randomUUID());
  assert.throws(() => scripts.delete(created.script.id), { code: "SCRIPT_REFERENCED" });
  assert.ok(scripts.detail(created.script.id));
});
