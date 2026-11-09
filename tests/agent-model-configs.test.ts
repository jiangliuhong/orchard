import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setup, temporary, until } from "./helpers.js";
import { TestStore as Store } from "./helpers.js";
import { AGENT_MODEL_SCHEMA, SCHEMA, MIGRATE_V6_TO_V7, MIGRATE_V7_TO_V8 } from "../src/persistence/schema.js";
import { sql, initializationSql } from "../src/migrations/frozen.js";
import { GraphRunner } from "../src/runtime/runner.js";
import { createApp } from "../src/server/app.js";
import { validateWorkflow } from "../src/domain/validation.js";
import type { Workflow } from "../src/domain/types.js";

const command = () => ({ requestId: randomUUID() });
test("registered Agent migration SQL and initialization match the reviewed schema constants", () => {
  assert.equal(sql[6], MIGRATE_V6_TO_V7);
  assert.equal(sql[7], MIGRATE_V7_TO_V8);
  assert.equal(initializationSql, SCHEMA);
});
function workflow(id: string): Workflow {
  return {
    formatVersion: 1, id, name: "具名模型工作流", inputSchema: true, outputSchema: true, entryNodeId: "first",
    defaults: { agent: { agentConfigId: "test-agent-config" } },
    nodes: [
      { id: "first", name: "分析", type: "agent", input: { source: "workflow" }, outputSchema: true, config: { prompt: "分析输入" } },
      { id: "second", name: "总结", type: "agent", input: { source: "node", nodeId: "first" }, outputSchema: true, config: { prompt: "总结结果" } },
    ],
    edges: [{ id: "next", from: "first", to: "second" }], result: { source: "node", nodeId: "second" },
  };
}

test("model configurations validate choices, normalize names, record immutable revisions and replay commands", t => {
  const { store, providers, provider } = setup(t); t.after(() => store.close());
  const service = providers.modelConfigs;
  const input = { ...command(), name: "  xxx 分析  ", providerId: provider.id, modelId: "test-model" };
  const first = service.create(input);
  assert.equal(first.name, "xxx 分析"); assert.equal(first.revision, 1);
  assert.equal(service.create(input).id, first.id);
  assert.throws(() => service.create({ ...input, ...command(), name: "xxx 分析" }), { code: "AGENT_CONFIG_NAME_CONFLICT" });
  assert.throws(() => service.create({ ...input, ...command(), name: "未知模型", modelId: "missing" }), { code: "MODEL_NOT_FOUND" });
  assert.throws(() => service.create({ ...input, ...command(), name: " " }), { code: "INVALID_NAME" });
  const update = { ...command(), expectedRevision: 1, name: "内容分析", description: "用于分析" };
  const second = service.update(first.id, update);
  assert.equal(second.revision, 2);
  assert.deepEqual(service.update(first.id, update), second);
  assert.throws(() => service.update(first.id, { ...update, ...command() }), { code: "REVISION_CONFLICT" });
  assert.equal(service.get(first.id).name, "内容分析");
  assert.equal(store.one<{ name: string }>("SELECT name FROM agent_model_config_revisions WHERE config_id=? AND revision=1", first.id)!.name, "xxx 分析");
  assert.equal(store.one<{ count: number }>("SELECT count(*) AS count FROM agent_model_config_revisions WHERE config_id=?", first.id)!.count, 2);
  providers.update(provider.id, { enabled: false });
  const disabled = service.update(first.id, { ...command(), expectedRevision: 2, enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(service.view(first.id).available, false);
  assert.throws(() => service.update(first.id, { ...command(), expectedRevision: 3, enabled: true }), { code: "PROVIDER_DISABLED" });
  assert.equal(service.get(first.id).revision, 3);
  assert.equal(service.list(true).items.some(item => item.id === first.id), false);
});

test("failed revision insertion rolls back the current configuration and command receipt", t => {
  const { store, providers } = setup(t); t.after(() => store.close());
  const first = providers.modelConfigs.get("test-agent-config");
  store.db.exec("CREATE TRIGGER reject_config_revision BEFORE INSERT ON agent_model_config_revisions BEGIN SELECT RAISE(ABORT,'fixture revision failure'); END;");
  const request = command();
  assert.throws(() => providers.modelConfigs.update(first.id, { ...request, expectedRevision: 1, name: "不会保存" }), /fixture revision failure/);
  assert.deepEqual(providers.modelConfigs.get(first.id), first);
  assert.equal(store.one("SELECT request_id FROM command_receipts WHERE request_id=?", request.requestId), undefined);
});

test("workflow schema accepts configuration inheritance and rejects direct provider/model references", () => {
  const graph = workflow("named-model-validation");
  assert.equal(validateWorkflow(graph), graph);
  assert.throws(() => validateWorkflow({ ...graph, defaults: { agent: { providerId: "codex-cli", modelId: "old" } } }), /additional properties/);
  assert.throws(() => validateWorkflow({ ...graph, defaults: undefined }), { code: "AGENT_CONFIG_REQUIRED" });
  const direct = structuredClone(graph);
  Object.assign(direct.nodes[0]!.config, { providerId: "codex-cli", modelId: "old" });
  assert.throws(() => validateWorkflow(direct), /additional properties/);
});

test("published workflows follow new revisions while running and queued nodes retain their initial bindings", async t => {
  const { store, providers, provider, authoring } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); await authoring.close(); store.close(); });
  providers.addModel(provider.id, { id: "next-model", name: "Next" });
  const draft = await authoring.create(undefined, randomUUID()), graph = workflow(JSON.parse(authoring.snapshot(draft.id).files["workflow.json"]!).id);
  await authoring.update(draft.id, 0, { "workflow.json": JSON.stringify(graph) });
  const version = await authoring.publish(draft.id, 1, randomUUID()), originalHash = version.contentHash;
  assert.deepEqual(version.definition, graph);
  let release: (() => void) | undefined, firstCall = true;
  provider.handler = async request => {
    if (firstCall) { firstCall = false; await new Promise<void>(resolve => { release = resolve; }); }
    return { output: request.modelId, providerId: provider.id, modelId: request.modelId };
  };
  const active = runner.create(version.id, {}, randomUUID());
  await until(() => release);
  const queuedRequest = randomUUID(), queued = runner.create(version.id, {}, queuedRequest);
  assert.equal(store.run(queued.id).status, "queued");
  const updated = providers.modelConfigs.update("test-agent-config", { ...command(), expectedRevision: 1, name: "新分析", modelId: "next-model" });
  const next = runner.create(version.id, {}, randomUUID());
  providers.modelConfigs.update(updated.id, { ...command(), expectedRevision: 2, enabled: false });
  assert.equal(runner.create(version.id, {}, queuedRequest).id, queued.id);
  assert.throws(() => runner.create(version.id, {}, randomUUID()), { code: "AGENT_CONFIG_DISABLED" });
  release!();
  await until(() => [active, queued, next].every(run => store.run(run.id).status === "succeeded"));
  assert.equal(store.run(active.id).output, "test-model");
  assert.equal(store.run(queued.id).output, "test-model");
  assert.equal(store.run(next.id).output, "next-model");
  assert.equal(store.version(version.id).contentHash, originalHash);
  const oldBindings = runner.snapshot(queued.id).agentBindings;
  assert.equal(oldBindings.length, 2);
  assert.ok(oldBindings.every(binding => binding.configRevision === 1 && binding.name === "测试分析" && binding.modelId === "test-model"));
  assert.ok(runner.snapshot(next.id).agentBindings.every(binding => binding.configRevision === 2 && binding.name === "新分析"));
  assert.equal(providers.modelConfigs.references("test-agent-config").workflowCount, 1);
  const attempt = runner.snapshot(next.id).attempts[0]!.execution as { agentModelConfig: { configRevision: number }; providerRevision: number };
  assert.equal(attempt.agentModelConfig.configRevision, 2);
  assert.ok(attempt.providerRevision > 0);
  authoring.deleteWorkflow(version.workflowId);
  assert.equal(store.all("SELECT * FROM run_agent_bindings").length, 0);
  assert.equal(providers.modelConfigs.get("test-agent-config").revision, 3);
});

test("draft test binding overrides defaults, preserves revisions and fails atomically on unavailable models", async t => {
  const { store, providers, provider, authoring } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); await authoring.close(); store.close(); });
  providers.addModel(provider.id, { id: "override-model" });
  const override = providers.modelConfigs.create({ ...command(), name: "专用分析", providerId: provider.id, modelId: "override-model" });
  const draft = await authoring.create(undefined, randomUUID()), graph = workflow(JSON.parse(authoring.snapshot(draft.id).files["workflow.json"]!).id);
  graph.nodes[1]!.config.agentConfigId = override.id;
  await authoring.update(draft.id, 0, { "workflow.json": JSON.stringify(graph) });
  provider.handler = async request => ({ output: request.modelId, providerId: provider.id, modelId: request.modelId });
  const request = randomUUID(), run = await runner.createDraft(draft.id, 1, {}, request);
  providers.modelConfigs.update(override.id, { ...command(), expectedRevision: 1, enabled: false });
  assert.equal((await runner.createDraft(draft.id, 1, {}, request)).id, run.id);
  await until(() => store.run(run.id).status === "succeeded");
  assert.equal(store.run(run.id).output, "override-model");
  assert.equal(runner.snapshot(run.id).agentBindings.find(binding => binding.nodeId === "second")!.configId, override.id);
  assert.deepEqual(runner.snapshot(run.id).execution.definition, graph);
  assert.equal(providers.modelConfigs.references(override.id).draftCount, 1);
  await assert.rejects(runner.createDraft(draft.id, 1, {}, randomUUID()), { code: "AGENT_CONFIG_DISABLED" });
  assert.equal(store.runs().length, 1);
  assert.equal(store.all("SELECT * FROM run_agent_bindings").length, 2);
});

test("v7 to v8 creates empty configuration tables without converting or deleting prior data", t => {
  const root = temporary(t), database = new DatabaseSync(join(root, "workbench.db"));
  database.exec(readFileSync(new URL("./fixtures/migrations/database/v7.sql", import.meta.url), "utf8"));
  database.exec("INSERT INTO provider_settings VALUES('existing',1,'{}','[]','model',1,1);");
  database.close();
  const store = new Store(root); t.after(() => store.close());
  assert.equal(store.one("PRAGMA user_version")!.user_version, 9);
  assert.ok(store.migrationBackupPath);
  assert.equal(store.provider("existing")!.defaultModel, "model");
  for (const table of ["agent_model_configs", "agent_model_config_revisions", "run_agent_bindings", "dictionaries", "dictionary_versions", "run_dictionary_bindings", "script_test_dictionary_bindings"]) assert.equal(store.all(`SELECT * FROM ${table}`).length, 0);
  assert.deepEqual(store.all("PRAGMA foreign_key_check"), []);
});

test("a queued binding never bypasses a disabled underlying Provider or falls back to its default model", async t => {
  const { store, providers, provider, authoring } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID()), graph = workflow(JSON.parse(authoring.snapshot(draft.id).files["workflow.json"]!).id);
  await authoring.update(draft.id, 0, { "workflow.json": JSON.stringify(graph) });
  const run = await runner.createDraft(draft.id, 1, {}, randomUUID());
  providers.update(provider.id, { enabled: false, defaultModel: "unrelated-default" });
  await until(() => store.run(run.id).status === "failed");
  assert.equal(store.run(run.id).error?.code, "PROVIDER_DISABLED");
  assert.equal(provider.calls.length, 0);
  assert.ok(runner.snapshot(run.id).agentBindings.every(binding => binding.modelId === "test-model"));
  assert.equal(store.nodes(run.id).find(node => node.nodeId === "second")!.status, "skipped");
  assert.equal(runner.snapshot(run.id).agentBindings.length, 2);
});

test("configuration HTTP endpoints validate requests, filter disabled entries and report references", async t => {
  const { store, providers, provider } = setup(t), { app } = createApp(store, providers);
  t.after(() => app.close());
  const payload = { ...command(), name: "API 分析", providerId: provider.id, modelId: "test-model" };
  const created = await app.inject({ method: "POST", url: "/api/agent-model-configs", payload });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  assert.equal((await app.inject({ method: "POST", url: "/api/agent-model-configs", payload })).json().id, id);
  assert.equal((await app.inject({ method: "POST", url: "/api/agent-model-configs", payload: { ...payload, ...command(), name: "未知模型配置", modelId: "unknown" } })).statusCode, 404);
  const updated = await app.inject({ method: "PATCH", url: `/api/agent-model-configs/${id}`, payload: { ...command(), expectedRevision: 1, enabled: false } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal((await app.inject({ url: "/api/agent-model-configs?enabled=true" })).json().items.some((item: { id: string }) => item.id === id), false);
  assert.equal((await app.inject({ url: `/api/agent-model-configs/${id}` })).json().unavailableReason, "配置已禁用");
  assert.deepEqual((await app.inject({ url: `/api/agent-model-configs/${id}/references` })).json(), { items: [], workflowCount: 0, draftCount: 0 });
  assert.equal((await app.inject({ url: "/api/agent-model-configs?enabled=invalid" })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/agent-model-configs/missing" })).statusCode, 404);
});
