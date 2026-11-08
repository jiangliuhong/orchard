import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createApp } from "../src/server/app.js";
import { BridgeAgentService } from "../src/web-bridge/agent.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import type { WebBridgeTool } from "../src/web-bridge/catalog.js";
import { prepareBridgeProposal } from "../src/web-bridge/authoring.js";
import { setup, until } from "./helpers.js";

const definition = (application = "crm", toolId = "customers"): WebBridgeTool => ({
  application, toolId, site: application, description: "查询客户", parameters: { type: "object", properties: {}, additionalProperties: false },
  path: "/api/customers", method: "GET", fields: ["items"], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", enabled: true,
});
const proposal = (tool = definition()) => ({ summary: "添加查询工具", changes: [{ operation: "create", toolId: tool.toolId, definition: tool }] });
const request = () => ({ prompt: "根据说明新增工具", conversationId: randomUUID(), requestId: randomUUID(), providerId: "test-provider", modelId: "test-model" });

test("Bridge Agent conversations persist, isolate context and only apply reviewed proposals", async context => {
  const { store, providers, provider } = setup(context), { app, bridge } = createApp(store, providers);
  context.after(() => app.close()); await app.ready();
  bridge.saveApplication({ id: "crm", name: "客户系统" });
  bridge.saveApplication({ id: "private", name: "PRIVATE_APPLICATION_MARKER" });
  const schema = store.all("SELECT name, sql FROM sqlite_master ORDER BY name");
  provider.handler = async input => {
    assert.ok(!input.prompt.includes("PRIVATE_APPLICATION_MARKER"));
    return { output: proposal(), providerId: provider.id, modelId: input.modelId };
  };
  const input = request(), base = "/api/web-bridge/applications/crm/agent/turns";
  const first = await app.inject({ method: "POST", url: base, payload: input });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal((await app.inject({ method: "POST", url: base, payload: input })).json().id, first.json().id);
  assert.equal((await app.inject({ method: "POST", url: base, payload: { ...input, prompt: "different" } })).statusCode, 409);
  await until(async () => (await app.inject({ url: base })).json().items[0]?.status === "succeeded");
  assert.equal(bridge.tools("crm").length, 0);
  const history = (await app.inject({ url: base })).json();
  assert.equal(history.conversations[0].id, input.conversationId);
  assert.equal(history.items[0].snapshot, undefined);
  assert.equal(history.items[0].requestHash, undefined);
  const applyUrl = `${base}/${first.json().id}/apply`;
  const applied = await app.inject({ method: "POST", url: applyUrl });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.deepEqual(bridge.tools("crm"), [definition()]);
  assert.deepEqual((await app.inject({ method: "POST", url: applyUrl })).json(), applied.json());
  bridge.saveTool({ ...definition(), description: "manual edit" });
  await app.inject({ method: "POST", url: applyUrl });
  assert.equal(bridge.tools("crm")[0].description, "manual edit");
  provider.handler = async input => ({ output: { summary: "回答用户问题，无需修改", changes: [] }, providerId: provider.id, modelId: input.modelId });
  const second = await app.inject({ method: "POST", url: base, payload: { ...request(), conversationId: input.conversationId, prompt: "继续解释" } });
  await until(async () => (await app.inject({ url: base })).json().items.find((item: { id: string }) => item.id === second.json().id)?.status === "succeeded");
  assert.ok(provider.calls.at(-1)!.prompt.includes(input.prompt));
  assert.ok(provider.calls.at(-1)!.prompt.includes("添加查询工具"));
  assert.equal((await app.inject({ method: "POST", url: `${base}/${second.json().id}/apply` })).json().code, "NO_CHANGES");
  const other = request();
  await app.inject({ method: "POST", url: base, payload: other });
  await until(async () => !(await app.inject({ url: base })).json().active);
  assert.ok(!provider.calls.at(-1)!.prompt.includes("继续解释"));
  assert.equal((await app.inject({ url: `${base}?conversationId=${other.conversationId}` })).json().items.length, 1);
  assert.equal((await app.inject({ method: "POST", url: base, payload: { ...request(), arbitrary: true } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: base, headers: { origin: "https://evil.test" }, payload: request() })).statusCode, 403);
  assert.deepEqual(store.all("SELECT name, sql FROM sqlite_master ORDER BY name"), schema);
});

test("Bridge proposals validate all changes before writing and reject stale snapshots", async context => {
  const { store, providers, provider } = setup(context);
  const config = new WebBridgeConfig(store.root), service = new BridgeAgentService(store.files, config, providers);
  context.after(async () => { await service.close(); store.close(); });
  config.saveApplication({ id: "crm", name: "CRM" });
  config.saveTool(definition());
  const original = config.authoringSnapshot("crm");
  assert.throws(() => config.applyProposal("crm", original.hash, {
    summary: "batch", changes: [
      { operation: "delete", toolId: "customers", definition: null },
      { operation: "create", toolId: "orders", definition: { ...definition("crm", "orders"), application: "private" } },
    ],
  }), { code: "INVALID_PROPOSAL" });
  assert.equal(config.authoringSnapshot("crm").hash, original.hash);
  assert.throws(() => config.saveTool({ ...definition(), parameters: { type: "INVALID" } }));
  assert.equal(config.authoringSnapshot("crm").hash, original.hash);
  for (const path of ["//evil.test", "/\\evil.test", "/api/\ncustomers"]) assert.throws(() => prepareBridgeProposal("crm", [], proposal({ ...definition(), path })));
  assert.throws(() => prepareBridgeProposal("crm", [], { summary: "duplicate", changes: [...proposal().changes, ...proposal().changes] }));
  provider.handler = async input => ({ output: { summary: "修改", changes: [{ operation: "update", toolId: "customers", definition: { ...definition(), description: "Agent edit" } }] }, providerId: provider.id, modelId: input.modelId });
  const turn = service.start("crm", request());
  await until(() => service.list("crm").items[0]?.status === "succeeded");
  config.saveTool({ ...definition(), enabled: false, description: "new manual edit" });
  assert.throws(() => service.apply("crm", turn.id), { code: "REVISION_CONFLICT" });
  assert.equal(config.tools("crm")[0].enabled, false);
  assert.equal(config.tools("crm")[0].description, "new manual edit");
  const snapshot = config.authoringSnapshot("crm");
  config.applyProposal("crm", snapshot.hash, { summary: "replace", changes: [
    { operation: "delete", toolId: "customers", definition: null },
    { operation: "create", toolId: "orders", definition: definition("crm", "orders") },
  ] });
  assert.deepEqual(config.tools("crm").map(tool => tool.toolId), ["orders"]);
  assert.deepEqual(JSON.parse(JSON.stringify(new WebBridgeConfig(store.root).tools("crm"))), config.tools("crm"));
});

test("Bridge Agent cancels tasks, blocks restore and deletion while active, and recovers interrupted history", async context => {
  const { store, providers, provider } = setup(context);
  const config = new WebBridgeConfig(store.root), service = new BridgeAgentService(store.files, config, providers);
  context.after(async () => { await service.close(); store.close(); });
  config.saveApplication({ id: "crm", name: "CRM" });
  provider.handler = input => new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
  const turn = service.start("crm", request());
  await until(() => provider.calls.length > 0);
  assert.throws(() => service.start("crm", request()), { code: "TURN_ACTIVE" });
  assert.throws(() => service.deleteApplication("crm"), { code: "TURN_ACTIVE" });
  assert.throws(() => config.coordinator.withExclusive(() => {}), { code: "CONFIG_BUSY" });
  service.cancel("crm", turn.id);
  await until(() => service.list("crm").items[0]?.status === "cancelled");
  await until(() => config.coordinator.activeCount === 0);
  const path = store.files.path(`web-bridge-agent/crm/${turn.id}.json`);
  const record = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...record, status: "running" }));
  const restarted = new BridgeAgentService(store.files, config, providers);
  assert.equal(restarted.list("crm").items[0].status, "interrupted");
  await restarted.close();
  service.deleteApplication("crm");
  config.saveApplication({ id: "crm", name: "new CRM" });
  assert.deepEqual(service.list("crm").items, []);
});
