import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../src/server/app.js";
import { setup } from "./helpers.js";

const definition = () => ({
  site: "crm", description: "查询客户", parameters: { type: "object", properties: {}, additionalProperties: false },
  path: "/api/customers", method: "GET", fields: ["items"], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", enabled: true,
});

test("Bridge tool routes fill omitted identity, reject explicit conflicts and retain the original when copying", async context => {
  const { store, providers } = setup(context), { app, bridge } = createApp(store, providers);
  context.after(() => app.close()); await app.ready();
  bridge.saveApplication({ id: "crm", name: "CRM" });
  const base = "/api/web-bridge/applications/crm/tools";
  const created = await app.inject({ method: "POST", url: base, payload: { ...definition(), toolId: "customers" } });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().application, "crm");
  const updated = await app.inject({ method: "PATCH", url: `${base}/customers/definition`, payload: { ...definition(), description: "更新定义" } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().application, "crm"); assert.equal(updated.json().toolId, "customers");
  assert.equal(bridge.tools("crm")[0]!.description, "更新定义");
  const before = readFileSync(store.files.path("config/web-bridge.json"), "utf8");
  for (const method of ["POST", "PATCH"] as const) {
    const url = method === "POST" ? base : `${base}/customers/definition`;
    const mismatch = await app.inject({ method, url, payload: { ...definition(), toolId: "customers", application: "other" } });
    assert.equal(mismatch.statusCode, 409, mismatch.body);
    assert.equal(mismatch.json().code, "TOOL_APPLICATION_CONFLICT");
    assert.match(mismatch.json().message, /other.*crm/);
  }
  const renamed = await app.inject({ method: "PATCH", url: `${base}/customers/definition`, payload: { ...definition(), toolId: "copy" } });
  assert.equal(renamed.statusCode, 409); assert.equal(renamed.json().code, "TOOL_ID_CONFLICT");
  assert.match(renamed.json().message, /customers.*copy.*另存为新工具/);
  const duplicate = await app.inject({ method: "POST", url: base, payload: { ...definition(), toolId: "customers" } });
  assert.equal(duplicate.statusCode, 409); assert.equal(duplicate.json().code, "TOOL_EXISTS");
  assert.equal(readFileSync(store.files.path("config/web-bridge.json"), "utf8"), before);
  const copy = await app.inject({ method: "POST", url: base, payload: { ...updated.json<Record<string, unknown>>(), toolId: "copy", description: "复制后的修改" } });
  assert.equal(copy.statusCode, 200, copy.body);
  assert.equal(bridge.tools("crm").length, 2);
  assert.equal(bridge.tools("crm").find(tool => tool.toolId === "customers")!.description, "更新定义");
  assert.equal(bridge.tools("crm").find(tool => tool.toolId === "copy")!.description, "复制后的修改");
});

test("Bridge tool routes reject invalid objects and identity types without writing configuration", async context => {
  const { store, providers } = setup(context), { app, bridge } = createApp(store, providers);
  context.after(() => app.close()); await app.ready();
  bridge.saveApplication({ id: "crm", name: "CRM" });
  const before = readFileSync(store.files.path("config/web-bridge.json"), "utf8");
  for (const method of ["POST", "PATCH"] as const) {
    const url = `/api/web-bridge/applications/crm/tools${method === "PATCH" ? "/customers/definition" : ""}`;
    for (const payload of [null, [], "text", 42]) {
      const response = await app.inject({ method, url, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().code, "INVALID_TOOL");
      assert.equal(response.json().message, "工具定义必须是 JSON 对象");
    }
    for (const identity of [{ application: null, toolId: "customers" }, { application: 12, toolId: "customers" }, { toolId: null }, { toolId: 12 }, { toolId: "" }]) {
      const response = await app.inject({ method, url, payload: { ...definition(), ...identity } });
      assert.equal(response.statusCode, method === "PATCH" && identity.toolId === "" ? 409 : 400, response.body);
    }
  }
  for (const toolId of [undefined, "Upper", "bad/id", "a".repeat(101)]) {
    const response = await app.inject({ method: "POST", url: "/api/web-bridge/applications/crm/tools", payload: { ...definition(), toolId } });
    assert.equal(response.statusCode, 400, response.body); assert.equal(response.json().code, "INVALID_TOOL");
  }
  assert.equal(readFileSync(store.files.path("config/web-bridge.json"), "utf8"), before);
});
