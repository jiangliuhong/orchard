import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../src/server/app.js";
import { publishExample, setup, until } from "./helpers.js";

test("quick launch routes save a pinned workflow and dispatch once across retries", async t => {
  const { store, providers, authoring } = setup(t);
  const { app } = createApp(store, providers);
  t.after(() => app.close());
  await app.ready();
  const version = await publishExample(authoring);
  const request = (method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers: { host: "localhost" }, payload });
  const options = await request("GET", "/api/quick-launch-targets");
  assert.equal(options.statusCode, 200, options.body);
  const option = options.json().items.find((item: { target: { versionId: string } }) => item.target.versionId === version.id);
  assert.ok(option);
  const group = await request("POST", "/api/quick-launch-groups", { name: "巡检", parentId: null, requestId: randomUUID() });
  assert.equal(group.statusCode, 201, group.body);
  const card = await request("POST", "/api/quick-launches", {
    name: "巡检", note: "", groupId: group.json().id, target: option.target, fixedInput: {}, inputSources: {}, requestId: randomUUID()
  });
  assert.equal(card.statusCode, 201, card.body);
  const saved = card.json();
  const input = { requestId: randomUUID(), revision: saved.revision };
  const start = await request("POST", `/api/quick-launches/${saved.id}/executions`, input);
  assert.equal(start.statusCode, 202, start.body);
  assert.ok(start.json().underlyingId, start.body);
  const replay = await request("POST", `/api/quick-launches/${saved.id}/executions`, input);
  assert.equal(replay.json().id, start.json().id);
  const settled = await until(async () => {
    const history = await request("GET", "/api/executions?source=quick_launch");
    assert.equal(history.statusCode, 200, history.body);
    const data = history.json();
    assert.equal(data.total, 1);
    return ["succeeded", "failed"].includes(data.items[0].status) ? data.items[0] : null;
  });
  assert.equal(settled.status, "succeeded");
  const copy = await request("POST", `/api/quick-launches/${saved.id}/copy`, { requestId: randomUUID() });
  assert.equal(copy.statusCode, 200, copy.body);
  const copied = copy.json();
  const copyRun = await request("POST", `/api/quick-launches/${copied.id}/executions`, { requestId: randomUUID(), revision: copied.revision });
  assert.equal(copyRun.statusCode, 202, copyRun.body);
  const second = await request("POST", `/api/quick-launches/${saved.id}/executions`, { requestId: randomUUID(), revision: saved.revision });
  assert.equal(second.statusCode, 202, second.body);
  const firstPage = (await request("GET", `/api/executions?launchId=${saved.id}&limit=1`)).json();
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.items[0].id, second.json().id);
  const older = (await request("GET", `/api/executions?launchId=${saved.id}&cursor=${encodeURIComponent(firstPage.nextCursor)}`)).json();
  assert.deepEqual(older.items.map((run: { id: string }) => run.id), [settled.id]);
  await until(async () => {
    const records = (await request("GET", "/api/executions")).json().items;
    return records.length === 3 && records.every((item: { status: string }) => item.status === "succeeded");
  });
});

test("script quick launch resolves a dictionary reference without storing it", async t => {
  const { store, providers } = setup(t);
  const services = createApp(store, providers);
  const { app, scripts } = services;
  t.after(() => app.close());
  await app.ready();
  const value = randomUUID();
  const dictionary = services.dictionaries.create({ requestId: randomUUID(), name: "运行设置", description: "", kind: "plain", enabled: true,
    operations: [{ op: "set", key: "region", type: "string", value }] });
  const created = await scripts.create({
    id: "quick-launch-test-script", name: "引用测试", description: "", runtime: "nodejs", entryFile: "main.ts",
    inputSchema: { type: "object", properties: { region: { type: "string" } }, required: ["region"], additionalProperties: false },
    outputSchema: true, files: { "main.ts": "export default input => input" }, requestId: randomUUID()
  });
  const published = store.publishScript(created.script.id, created.version.revision);
  const headers = { host: "localhost" };
  const card = await app.inject({ method: "POST", url: "/api/quick-launches", headers, payload: {
    name: "引用测试", note: "", groupId: null, target: { kind: "script", scriptId: created.script.id, versionId: published.version.id },
    fixedInput: {}, inputSources: { "/region": { source: "dictionary", dictionaryId: dictionary.dictionaryId, key: "region" } }, requestId: randomUUID()
  } });
  assert.equal(card.statusCode, 201, card.body);
  const accepted = await app.inject({ method: "POST", url: `/api/quick-launches/${card.json().id}/executions`, headers,
    payload: { revision: card.json().revision, requestId: randomUUID() } });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const id = accepted.json().underlyingId;
  assert.ok(id, accepted.body);
  const result = await until(() => { const test = store.scriptTest(id); return test.status === "succeeded" || test.status === "failed" ? test : null; });
  assert.equal(result.status, "succeeded");
  assert.ok(!JSON.stringify(result).includes(value));
  const cardId = card.json().id;
  store.exec("UPDATE quick_launches SET input_sources_json=? WHERE id=?",
    JSON.stringify({ "/region": { source: "environment", name: "LEGACY_REGION", valueType: "string" } }), cardId);
  const legacy = await app.inject({ url: `/api/quick-launches/${cardId}`, headers });
  assert.equal(legacy.json().available, false);
  assert.equal(legacy.json().needsReferenceUpdate, true);
  const oldRun = await app.inject({ method: "POST", url: `/api/quick-launches/${cardId}/executions`, headers,
    payload: { revision: card.json().revision, requestId: randomUUID() } });
  assert.equal(oldRun.json().status, "start_failed");
  assert.equal(oldRun.json().underlyingId, null);
  for (const table of ["script_tests", "execution_records", "command_receipts"]) {
    assert.ok(!JSON.stringify(store.all(`SELECT * FROM ${table}`)).includes(value));
  }
});

test("browser quick launch requires confirmation and dispatches one call to the pinned environment", async t => {
  const { store, providers } = setup(t);
  const { app, bridge } = createApp(store, providers);
  t.after(() => app.close());
  await app.ready();
  bridge.saveApplication({ id: "sample", name: "示例" });
  const environment = bridge.saveEnvironment("sample", { origin: "https://example.test" });
  bridge.saveTool({ application: "sample", toolId: "submit", site: "sample", description: "提交示例",
    parameters: { type: "object" }, path: "/submit", method: "POST", fields: [], risk: "write", approval: "user",
    timeoutMs: 1000, catalogVersion: "1", enabled: true,
    execution: { version: 1, transport: "localHttp", response: { mode: "fullJson", maxBytes: 1000 } } });
  let calls = 0;
  bridge.httpDependencies.fetch = async () => { calls++; return Response.json({ ok: true }); };
  const headers = { host: "localhost" };
  const options = (await app.inject({ url: "/api/quick-launch-targets", headers })).json();
  const target = options.items.find((item: { target: { environmentId?: string } }) => item.target.environmentId === environment.id)?.target;
  assert.ok(target);
  const card = await app.inject({ method: "POST", url: "/api/quick-launches", headers,
    payload: { name: "浏览器示例", note: "", groupId: null, target, fixedInput: {}, inputSources: {}, requestId: randomUUID() } });
  assert.equal(card.statusCode, 201, card.body);
  const path = `/api/quick-launches/${card.json().id}`, input = { revision: card.json().revision, requestId: randomUUID() };
  const rejected = await app.inject({ method: "POST", url: path + "/executions", headers, payload: input });
  assert.equal(rejected.json().code, "CONFIRMATION_REQUIRED");
  assert.equal(calls, 0);
  const confirmation = await app.inject({ method: "POST", url: path + "/confirmation", headers, payload: input });
  assert.equal(confirmation.statusCode, 200, confirmation.body);
  const payload = { ...input, confirmationToken: confirmation.json().token };
  const accepted = await app.inject({ method: "POST", url: path + "/executions", headers, payload });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const id = accepted.json().id;
  await until(() => store.one<{ status: string }>("SELECT status FROM execution_records WHERE id=?", id)?.status === "succeeded");
  const replay = await app.inject({ method: "POST", url: path + "/executions", headers, payload });
  assert.equal(replay.json().id, id);
  assert.equal(calls, 1);

  // A transport failure after fetch starts must preserve uncertainty.
  bridge.httpDependencies.fetch = async () => { calls++; throw new Error("lost response"); };
  const next = { ...input, requestId: randomUUID() };
  const nextToken = await app.inject({ method: "POST", url: path + "/confirmation", headers, payload: next });
  const sent = await app.inject({ method: "POST", url: path + "/executions", headers, payload: { ...next, confirmationToken: nextToken.json().token } });
  await until(() => store.one<{ status: string }>("SELECT status FROM execution_records WHERE id=?", sent.json().id)?.status === "unknown");

  // Request preparation fails before fetch for a missing raw body.
  bridge.saveTool({ ...bridge.tools("sample")[0], execution: {
    version: 1, transport: "localHttp", body: { argument: "payload", mode: "rawUtf8" },
    response: { mode: "fullJson", maxBytes: 1000 }
  }, parameters: { type: "object", properties: { payload: { type: "string" } } } });
  const changed = (await app.inject({ url: "/api/quick-launch-targets", headers })).json().items[0].target;
  const prepared = await app.inject({ method: "POST", url: "/api/quick-launches", headers,
    payload: { name: "缺少请求体", note: "", groupId: null, target: changed, fixedInput: {}, inputSources: {}, requestId: randomUUID() } });
  assert.equal(prepared.statusCode, 201, prepared.body);
  const rejectedPath = `/api/quick-launches/${prepared.json().id}`;
  const retry = { revision: 1, requestId: randomUUID() };
  const retryToken = await app.inject({ method: "POST", url: rejectedPath + "/confirmation", headers, payload: retry });
  const notSent = await app.inject({ method: "POST", url: rejectedPath + "/executions", headers, payload: { ...retry, confirmationToken: retryToken.json().token } });
  assert.equal(notSent.statusCode, 202, notSent.body);
  await until(() => store.one<{ status: string }>("SELECT status FROM execution_records WHERE id=?", notSent.json().id)?.status === "start_failed");
  assert.equal(calls, 2);
});

test("backend recovery distinguishes unclaimed work, lost references and uncertain dispatch", async t => {
  const { store, providers } = setup(t);
  const { QuickLaunchService } = await import("../src/quick-launch/service.js");
  const { GraphRunner } = await import("../src/runtime/runner.js");
  const { ScriptTestRunner } = await import("../src/runtime/script-tests.js");
  const { WebBridgeGateway } = await import("../src/web-bridge/gateway.js");
  const { WebBridgeClient } = await import("../src/web-bridge/client.js");
  const runner = new GraphRunner(store, providers, undefined, false);
  const scripts = new ScriptTestRunner(store, false);
  const bridge = new WebBridgeGateway(new WebBridgeClient(store.files.path("runtime/web-bridge.sock"), ""));
  const service = new QuickLaunchService(store, runner, scripts, bridge, () => { throw new Error("References must not be resolved during recovery"); });
  t.after(async () => { await service.close(); await runner.close(); await scripts.close(); bridge.close(); });
  for (const [id, state, references] of [["pending", "claimed", {}], ["private", "pending", { "/value": { source: "dictionary" } }], ["sent", "dispatching", {}]] as const) {
    const snapshot = store.reference({ inputSources: references });
    store.exec(`INSERT INTO execution_records(id,source,target_kind,request_scope,request_id,request_digest,snapshot_ref,underlying_kind,underlying_id,
      status,privacy_policy,accepted_at,output_availability)
      VALUES(?,'quick_launch','browser_tool','test',?,?,?,'bridge_call',?,?, 'restricted',0,'not_recorded')`,
      id, id, id, snapshot, id, state === "dispatching" ? "running" : "queued");
    store.exec("INSERT INTO execution_outbox VALUES (?,?,'dispatch',0,?,0,?,?,0,0)", id, id, state,
      state === "pending" ? null : id, state === "pending" ? null : 1);
  }
  service.recover();
  assert.equal(service.detail("pending").status, "queued");
  assert.equal(store.one<{ state: string }>("SELECT state FROM execution_outbox WHERE id='pending'")?.state, "pending");
  assert.equal(service.detail("private").status, "interrupted");
  assert.equal(service.detail("sent").status, "unknown");
});
