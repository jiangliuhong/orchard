import test from "node:test";
import assert from "node:assert/strict";
import { BRIDGE_HTTP_METHODS, allowsRequestBody } from "../src/web-bridge/http-methods.js";
import { preprocessBrowser } from "../src/web-bridge/browser-execution.js";
import { executeHttpTool, validateStoredHttpTool, type BridgeHttpExecution } from "../src/web-bridge/execution.js";
import { inspectBridgeConfig, validateBridgeConfigV1 } from "../src/web-bridge/config-validation.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { setup } from "./helpers.js";

const browser = {
  version: 1 as const, transport: "browser" as const,
  preprocess: { runtime: "nodejs" as const, code: "return {...request, headers: {}, ...(args.body === undefined ? {} : {body: args.body})}" },
  response: { mode: "fullJson" as const, maxBytes: 1000 },
};

test("browser preprocessing accepts every Fetch method and forbids bodies on GET/HEAD", async () => {
  for (const method of BRIDGE_HTTP_METHODS) {
    const defaults = { path: "/api/items", method };
    const body = allowsRequestBody(method) ? '{ "ok": true }' : undefined;
    const { request } = await preprocessBrowser(browser, { body }, defaults, AbortSignal.timeout(5000));
    assert.equal(request.method, method);
    assert.equal(request.body, body);
    if (!allowsRequestBody(method)) await assert.rejects(preprocessBrowser(browser, { body: "{}" }, defaults, AbortSignal.timeout(5000)), { code: "INVALID_BODY" });
  }
  for (const method of ["CONNECT", "TRACE", "TRACK"]) {
    await assert.rejects(preprocessBrowser(browser, {}, { path: "/api/items", method }, AbortSignal.timeout(5000)), { code: "INVALID_REQUEST" });
  }
});

test("local HTTP sends PUT/PATCH/DELETE/OPTIONS bodies and accepts HEAD/204 responses", async () => {
  for (const method of BRIDGE_HTTP_METHODS) {
    const execution: BridgeHttpExecution = { version: 1, transport: "localHttp", response: { mode: "fullJson", maxBytes: 1000 }, ...(allowsRequestBody(method) ? { body: { mode: "rawUtf8", argument: "body" } as const } : {}) };
    const tool = { path: "/api/items", method, execution, fields: [], parameters: { type: "object", properties: { body: { type: "string" } } } };
    validateStoredHttpTool(tool);
    const result = await executeHttpTool(tool, "https://example.test", { body: "{}" }, AbortSignal.timeout(5000), { fetch: async (_url, init) => {
      assert.equal(init?.method, method);
      assert.equal(init?.body, allowsRequestBody(method) ? "{}" : undefined);
      return new Response(null, { status: method === "HEAD" ? 200 : 204 });
    } });
    assert.equal(result, null);
    if (!allowsRequestBody(method)) assert.throws(() => validateStoredHttpTool({ ...tool, execution: { ...execution, body: { mode: "rawUtf8", argument: "body" } } }), { code: "INVALID_BODY" });
  }
});

test("extended methods survive configuration saves, reload and live startup inspection", t => {
  const { store } = setup(t);
  const config = new WebBridgeConfig(store.root);
  config.saveApplication({ id: "crm", name: "CRM" });
  for (const method of BRIDGE_HTTP_METHODS) config.saveTool({
    application: "crm", toolId: method.toLowerCase(), site: "crm", description: method,
    path: "/api/items", method, parameters: { type: "object" }, fields: [], execution: browser,
    risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", enabled: true,
  });
  assert.deepEqual(new WebBridgeConfig(store.root).tools().map(tool => tool.method), BRIDGE_HTTP_METHODS);
  const value = { schemaVersion: 1, applications: { crm: { id: "crm", name: "CRM", enabled: true } }, environments: {}, tools: Object.fromEntries(config.tools().map(tool => [`crm/${tool.toolId}`, tool])), enabledTools: {} };
  assert.equal(inspectBridgeConfig(JSON.stringify(value)).version, 1);
  for (const method of ["CONNECT", "TRACE", "TRACK", "INVALID"]) {
    value.tools["crm/get"]!.method = method as "GET";
    assert.throws(() => validateBridgeConfigV1(JSON.stringify(value)), { code: "CONFIG_INVALID_ENUM" });
  }
  assert.throws(() => validateBridgeConfigV1('{"schemaVersion":1,"schemaVersion":1}'), /CONFIG_DUPLICATE_KEY/);
});
