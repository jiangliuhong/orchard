import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import type { WebBridgeTool } from "../src/web-bridge/catalog.js";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/web-bridge" });
for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "localStorage", "HTMLInputElement", "HTMLTextAreaElement", "DocumentFragment", "NodeFilter", "Element", "MutationObserver", "getComputedStyle", "Event", "CustomEvent"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { BridgeExecutionHistory } = await import("../src/web/features/BridgeExecutionHistory.js");
const { WebBridgeSettings } = await import("../src/web/features/WebBridgeSettings.js");

test("history only loads parameters on explicit action and respects disabled state", async () => {
  const original = globalThis.fetch;
  const record = { id: "one", application: "crm", toolId: "query", source: "test" as const, args: { page: 2 }, startedAt: Date.now(), durationMs: 12, status: "succeeded" as const, redacted: false };
  let requests = 0, reused: unknown;
  globalThis.fetch = async () => { requests++; return Response.json({ items: [record] }); };
  try {
    const view = render(createElement(BridgeExecutionHistory, { application: "crm", toolId: "query", disabled: true, onReuse: value => { reused = value; } }));
    const row = await screen.findByRole("button", { name: /测试 · 成功 · 12 ms/ });
    assert.equal(screen.queryByRole("region", { name: "执行详情" }), null);
    fireEvent.click(row);
    assert.equal(row.getAttribute("aria-expanded"), "true");
    const back = screen.getByRole("button", { name: "返回列表" });
    assert.equal(document.activeElement, back);
    fireEvent.keyDown(back, { key: "Escape" });
    assert.equal(row.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, row);
    fireEvent.click(row);
    const button = screen.getByRole("button", { name: "载入参数并前往测试" });
    assert.equal((button as HTMLButtonElement).disabled, true);
    assert.equal(reused, undefined);
    view.rerender(createElement(BridgeExecutionHistory, { application: "crm", toolId: "query", disabled: false, onReuse: value => { reused = value; } }));
    fireEvent.click(button);
    assert.deepEqual(reused, record);
    assert.equal(requests, 1);
  } finally { cleanup(); globalThis.fetch = original; }
});

test("workspace restores dictionary bindings and permitted inline history without clearing them on tab change", async () => {
  const original = globalThis.fetch;
  localStorage.clear(); localStorage.setItem("orchard.bridge.agentOpen", "false");
  const tool: WebBridgeTool = { application: "crm", toolId: "query", site: "crm", description: "Query", parameters: { type: "object", properties: { product: { type: "string" }, password: { type: "string", minLength: 1, "x-history": { record: false } } }, required: ["product", "password"], additionalProperties: false }, path: "/query", method: "GET", fields: [], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", enabled: true, execution: { version: 1, transport: "browser", credentialSchema: { type: "object", properties: { ak: { type: "string", "x-history": { record: false } }, sk: { type: "string", "x-history": { record: false } }, label: { type: "string" } }, required: ["ak", "sk"], additionalProperties: false }, preprocess: { runtime: "nodejs", code: "return request;" }, response: { mode: "fullJson", maxBytes: 1000 } } };
  const record = { id: "replay", formatVersion: 2, application: "crm", toolId: "query", source: "test", args: { product: "P1" }, argSources: { "/password": { source: "omitted", reason: "schema-policy" } }, credentialValues: { label: "saved-label" }, credentialSources: { "/ak": { source: "dictionary", dictionaryId: "dict", key: "access" }, "/sk": { source: "omitted", reason: "schema-policy" } }, startedAt: Date.now(), durationMs: 1, status: "succeeded", redacted: true };
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.endsWith("/applications")) return Response.json({ items: [{ id: "crm", name: "CRM", enabled: true, environments: [] }] });
    if (path.endsWith("/tools")) return Response.json({ items: [tool] });
    if (path.endsWith("/history")) return Response.json({ items: [record] });
    if (path.endsWith("/calls")) { calls.push(JSON.parse(String(options?.body))); return Response.json({ ok: true }); }
    return Response.json({ items: [], conversations: [] });
  };
  try {
    render(createElement(WebBridgeSettings));
    fireEvent.click(await screen.findByRole("button", { name: "编辑工具 query" }));
    fireEvent.click(screen.getByRole("button", { name: "执行历史" }));
    fireEvent.click(await screen.findByRole("button", { name: /测试 · 成功 · 1 ms/ }));
    fireEvent.click(screen.getByRole("button", { name: "载入参数并前往测试" }));
    assert.equal((screen.getByLabelText("ak:") as HTMLInputElement).value, "{{dictionary:dict:access}}");
    assert.equal((screen.getByLabelText("label:") as HTMLInputElement).value, "saved-label");
    assert.equal((screen.getByLabelText("sk:") as HTMLInputElement).value, "");
    assert.equal((screen.getByRole("button", { name: "执行测试" }) as HTMLButtonElement).disabled, true);
    assert.equal(calls.length, 0);
    fireEvent.change(screen.getByLabelText("sk:"), { target: { value: "new-sk" } });
    fireEvent.change(screen.getByLabelText("password *:"), { target: { value: "new-password" } });
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "执行测试" }) as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole("button", { name: "执行测试" }));
    await waitFor(() => assert.equal(calls.length, 1));
    assert.deepEqual(calls[0].args, { product: "P1", password: "new-password" });
    assert.deepEqual(calls[0].credentialBindings, { ak: { source: "dictionary", dictionaryId: "dict", key: "access" }, sk: { source: "inline", value: "new-sk" }, label: { source: "inline", value: "saved-label" } });
    await waitFor(() => assert.equal((screen.getByLabelText("sk:") as HTMLInputElement).value, ""));
    assert.equal((screen.getByLabelText("ak:") as HTMLInputElement).value, "{{dictionary:dict:access}}");
  } finally { cleanup(); globalThis.fetch = original; localStorage.clear(); }
});
