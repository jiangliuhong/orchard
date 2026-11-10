import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { BridgeExecutionHistory } from "../src/web-bridge/history.js";
import { captureHistory, restoredCredentials } from "../src/web-bridge/history-policy.js";
import { assertSchema } from "../src/domain/validation.js";
import { validateStoredHttpTool } from "../src/web-bridge/execution.js";
import { preprocessBrowser, type BrowserExecution } from "../src/web-bridge/browser-execution.js";
import type { WebBridgeTool } from "../src/web-bridge/catalog.js";
import { createApp } from "../src/server/app.js";
import { setup } from "./helpers.js";

const definition = (): WebBridgeTool => ({ application: "crm", toolId: "query", site: "crm", description: "查询", parameters: { type: "object", properties: { password: { type: "string", "x-history": { record: false } }, nested: { type: "array", items: { type: "string", "x-history": { record: false } } } } }, path: "/query", method: "GET", fields: [], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", enabled: true });
const browser = (): BrowserExecution => ({ version: 1, transport: "browser", credentialSchema: { type: "object", properties: { ak: { type: "string", minLength: 1, "x-history": { record: false } }, sk: { type: "string", minLength: 1, "x-history": { record: false } }, label: { type: "string" } }, required: ["ak", "sk"], additionalProperties: false }, preprocess: { runtime: "nodejs", code: "return { ...request, headers: {} };" }, response: { mode: "fullJson", maxBytes: 1000 } });

test("history is bounded, persisted privately, filtered and follows schema policy", t => {
  const { store } = setup(t); t.after(() => store.close());
  const history = new BridgeExecutionHistory(store.files);
  for (let index = 0; index < 502; index++) history.add({ application: "crm", toolId: "query", args: { index, password: "hidden", nested: ["prefix-manual-secret"] }, source: "test", startedAt: index, durationMs: 1, status: "succeeded" }, { tool: definition() });
  const restored = new BridgeExecutionHistory(store.files);
  assert.equal(restored.list("crm", "query").length, 100);
  assert.equal(restored.list("other", "query").length, 0);
  assert.deepEqual(restored.list("crm", "query")[0].args, { index: 501, nested: [null] });
  const path = store.files.path("runtime/bridge-history.json");
  const text = readFileSync(path, "utf8");
  assert.equal(JSON.parse(text).length, 500);
  assert.ok(!text.includes("hidden") && !text.includes("manual-secret"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("gateway records calls, tests and failures; historical args can be executed again", async t => {
  const { store, providers } = setup(t);
  const { app, bridge } = createApp(store, providers); await app.ready(); t.after(() => app.close());
  bridge.saveApplication({ id: "crm", name: "CRM" });
  const environment = bridge.saveEnvironment("crm", { origin: "https://example.test" });
  bridge.saveTool({ application: "crm", toolId: "query", site: "crm", description: "查询", parameters: { type: "object" }, path: "/query", method: "GET", fields: [], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", enabled: true, execution: { version: 1, transport: "localHttp", response: { mode: "fullJson", maxBytes: 1000 } } });
  let calls = 0;
  bridge.httpDependencies.fetch = async () => { calls++; return Response.json({ ok: true }); };
  const base = "/api/web-bridge/applications/crm/tools/query";
  let response = await app.inject({ method: "POST", url: `${base}/test`, payload: { page: 2 } });
  assert.equal(response.statusCode, 200, response.body);
  response = await app.inject({ url: `${base}/history` });
  assert.equal(response.headers["cache-control"], "no-store");
  const record = response.json().items[0];
  assert.equal(record.source, "test"); assert.equal(record.status, "succeeded");
  assert.equal(record.environmentId, environment.id); assert.deepEqual(record.args, { page: 2 });
  assert.equal(calls, 1);
  response = await app.inject({ method: "POST", url: "/api/web-bridge/calls", payload: { application: "crm", tool: "query", args: record.args, environmentId: record.environmentId } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(calls, 2);
  bridge.saveTool({ ...bridge.tools("crm")[0], risk: "write", approval: "user" });
  response = await app.inject({ method: "POST", url: "/api/web-bridge/calls", payload: { application: "crm", tool: "query", args: record.args } });
  assert.equal(response.json().code, "APPROVAL_REQUIRED"); assert.equal(calls, 2);
  const items = (await app.inject({ url: `${base}/history` })).json().items;
  assert.equal(items.length, 3); assert.equal(items[0].status, "failed");
  assert.equal(items[0].errorCode, "APPROVAL_REQUIRED"); assert.equal(items[1].source, "call");
  assert.equal(new BridgeExecutionHistory(store.files).list("crm", "query").length, 3);
});

test("x-history is strictly validated and does not guess sensitive field names", () => {
  assert.doesNotThrow(() => assertSchema("value", { type: "string", "x-history": { record: false } }));
  for (const policy of [false, {}, { record: "false" }, { record: false, extra: true }]) {
    assert.throws(() => assertSchema("value", { type: "string", "x-history": policy }), { code: "INVALID_SCHEMA" });
  }
  const result = captureHistory({ ak: "permitted", password: "also-permitted", value: "[已脱敏]" }, { type: "object" });
  assert.deepEqual(result.value, { ak: "permitted", password: "also-permitted", value: "[已脱敏]" });
  assert.deepEqual(result.sources, {});
});

test("nested policies preserve positions, escape pointers, and parent denial wins", () => {
  const schema = { type: "object", properties: {
    "a/b~c": { type: "string", "x-history": { record: false } },
    user: { type: "object", "x-history": { record: false }, properties: { allowed: { type: "string", "x-history": { record: true } } } },
    items: { type: "array", items: { type: "object", properties: { secret: { type: "string", "x-history": { record: false } } } } },
  } };
  const result = captureHistory({ "a/b~c": "hidden", user: { allowed: "hidden" }, items: [{ secret: "hidden", value: 1 }, { value: 2 }] }, schema);
  assert.deepEqual(result.value, { items: [{ value: 1 }, { value: 2 }] });
  assert.deepEqual(Object.keys(result.sources), ["/a~1b~0c", "/user", "/items/0/secret"]);
  const refs = captureHistory({ key: "hidden", other: 2 }, { type: "object", properties: { key: { $ref: "#/definitions/sensitive" } }, definitions: { sensitive: { type: "string", "x-history": { record: false } } } });
  assert.deepEqual(refs.value, { other: 2 });
  const branch = captureHistory({ value: "hidden" }, { anyOf: [{ properties: { value: { "x-history": { record: false } } } }, {}] });
  assert.deepEqual(branch.value, {});
});

test("history keeps dictionary sources and schema-permitted inline values, never decrypted values", t => {
  const { store } = setup(t); t.after(() => store.close());
  const history = new BridgeExecutionHistory(store.files);
  const tool = { ...definition(), execution: browser() };
  const record = history.add({ application: "crm", toolId: "query", args: { productNo: "P1" }, source: "test", startedAt: 1, durationMs: 1, status: "succeeded" }, { tool, bindings: { ak: { source: "dictionary", dictionaryId: "dict", key: "access" }, sk: { source: "inline", value: "hidden-manual" }, label: { source: "inline", value: "keep-label" } } });
  assert.deepEqual(record.credentialSources, { "/ak": { source: "dictionary", dictionaryId: "dict", key: "access" }, "/sk": { source: "omitted", reason: "schema-policy" } });
  assert.deepEqual(record.credentialValues, { label: "keep-label" });
  assert.deepEqual(restoredCredentials(record.credentialValues, record.credentialSources), { ak: { source: "dictionary", dictionaryId: "dict", key: "access" }, sk: { source: "inline", value: "" }, label: { source: "inline", value: "keep-label" } });
  const text = readFileSync(store.files.path("runtime/bridge-history.json"), "utf8");
  assert.ok(!text.includes("hidden-manual"));
  assert.equal(new BridgeExecutionHistory(store.files).list("crm", "query", tool)[0].toolHash, record.toolHash);
});

test("current stricter policy purges saved values irreversibly and reports definition changes", t => {
  const { store } = setup(t); t.after(() => store.close());
  const history = new BridgeExecutionHistory(store.files), tool = { ...definition(), execution: browser() };
  history.add({ application: "crm", toolId: "query", args: { ordinary: "previous-value" }, source: "test", startedAt: 1, durationMs: 1, status: "succeeded" }, { tool, bindings: { label: { source: "inline", value: "previous-label" }, ak: { source: "dictionary", dictionaryId: "dict", key: "ak" } } });
  const stricter = { ...tool, parameters: { type: "object", "x-history": { record: false } }, execution: { ...browser(), credentialSchema: { ...(browser().credentialSchema as object), "x-history": { record: false } } } };
  const record = history.list("crm", "query", stricter)[0];
  assert.equal(record.args, null);
  assert.equal(record.definitionChanged, true);
  assert.deepEqual(record.credentialValues, {});
  assert.equal(record.credentialSources?.["/ak"].source, "dictionary");
  assert.equal(record.credentialSources?.["/label"].source, "omitted");
  const text = readFileSync(store.files.path("runtime/bridge-history.json"), "utf8");
  assert.ok(!text.includes("previous-value") && !text.includes("previous-label"));
  assert.equal(history.list("crm", "query", tool)[0].args, null);
});

test("credentialSchema validates resolved strings, optional fields and missing references separately", async () => {
  const execution = browser();
  validateStoredHttpTool({ ...definition(), execution });
  const options = { ak: { source: "dictionary" as const, dictionaryId: "d", key: "ak" }, sk: { source: "inline" as const, value: "manual" } };
  const result = await preprocessBrowser(execution, {}, { path: "/query", method: "GET" }, new AbortController().signal, () => "resolved", options);
  assert.deepEqual(result.secrets.slice(0, 2), ["resolved", "manual"]);
  await assert.rejects(preprocessBrowser(execution, {}, { path: "/query", method: "GET" }, new AbortController().signal, () => "resolved", { sk: options.sk }), /缺少调用凭据：ak/);
  await assert.rejects(preprocessBrowser(execution, {}, { path: "/query", method: "GET" }, new AbortController().signal, undefined, options), /服务未配置安全凭据解析器/);
  const bad = { ...execution, credentialSchema: { type: "object", properties: { ak: { type: "string", "x-history": { record: "no" } } }, additionalProperties: false } };
  assert.throws(() => validateStoredHttpTool({ ...definition(), execution: bad }), { code: "INVALID_SCHEMA" });
});

test("legacy histories convert old redaction strings to unknown-source placeholders", t => {
  const { store } = setup(t); t.after(() => store.close());
  const history = new BridgeExecutionHistory(store.files);
  const record = history.add({ application: "crm", toolId: "query", args: {}, source: "test", startedAt: 1, durationMs: 1, status: "failed" });
  const { formatVersion, schemas, argSources, credentialValues, credentialSources, toolHash, ...legacy } = record;
  writeFileSync(store.files.path("runtime/bridge-history.json"), JSON.stringify([{ ...legacy, args: { normal: 1, old: "[已脱敏]" } }]));
  const execution = { ...browser(), preprocess: { ...browser().preprocess, credentials: { ak: { dictionaryId: "current-default", key: "ak" } } } };
  const restored = new BridgeExecutionHistory(store.files).list("crm", "query", { ...definition(), execution })[0];
  assert.equal(restored.legacy, true);
  assert.deepEqual(restored.args, { normal: 1 });
  assert.deepEqual(restored.argSources?.["/old"], { source: "omitted", reason: "legacy-unknown" });
  assert.deepEqual(restored.credentialSources?.["/ak"], { source: "omitted", reason: "legacy-unknown" });
  assert.deepEqual(restoredCredentials(restored.credentialValues, restored.credentialSources).ak, { source: "inline", value: "" });
});

test("API history replay re-resolves dictionary references after rotation rather than storing resolved secrets", async t => {
  const { store, providers } = setup(t);
  const { app, bridge } = createApp(store, providers); await app.ready(); t.after(() => app.close());
  bridge.saveApplication({ id: "crm", name: "CRM" });
  bridge.saveEnvironment("crm", { origin: "https://example.test", profileId: "work" });
  const execution = { ...browser(), preprocess: { runtime: "nodejs" as const, code: "return {...request,headers:{'x-ak':credentials.ak,'x-sk':credentials.sk}};" } };
  bridge.saveTool({ ...definition(), execution });
  let generation = 1;
  bridge.httpDependencies.resolveCredential = (_id, key) => `resolved-${generation}-${key}`;
  const sent: unknown[] = [];
  bridge.browserChannel.call = async (_profile, payload) => { sent.push((payload as { request: { headers: unknown } }).request.headers); return { ok: true }; };
  const payload = { application: "crm", tool: "query", args: { password: "never-save-password" }, source: "test", credentialBindings: { ak: { source: "dictionary", dictionaryId: "dict", key: "access" }, sk: { source: "dictionary", dictionaryId: "dict", key: "secret" }, label: { source: "inline", value: "allowed-label" } } };
  let response = await app.inject({ method: "POST", url: "/api/web-bridge/calls", payload });
  assert.equal(response.statusCode, 200, response.body);
  const record = (await app.inject({ url: "/api/web-bridge/applications/crm/tools/query/history" })).json().items[0];
  assert.deepEqual(record.args, {});
  assert.equal(record.argSources["/password"].source, "omitted");
  assert.equal(record.credentialValues.label, "allowed-label");
  generation = 2;
  response = await app.inject({ method: "POST", url: "/api/web-bridge/calls", payload: { ...payload, args: record.args, credentialBindings: restoredCredentials(record.credentialValues, record.credentialSources) } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(sent, [{ "x-ak": "resolved-1-access", "x-sk": "resolved-1-secret" }, { "x-ak": "resolved-2-access", "x-sk": "resolved-2-secret" }]);
  const text = readFileSync(store.files.path("runtime/bridge-history.json"), "utf8");
  assert.ok(!text.includes("resolved-1") && !text.includes("resolved-2") && !text.includes("never-save-password"));
});
