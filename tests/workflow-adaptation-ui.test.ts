import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { JSDOM } from "jsdom";
import type { WorkflowNode } from "../src/domain/types.js";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "getComputedStyle", "navigator"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { ScriptNodePicker } = await import("../src/web/features/ScriptNodePicker.js");
const { BridgeNodeCredentials } = await import("../src/web/features/BridgeNodeCredentials.js");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const dictionaryId = "11111111-1111-4111-8111-111111111111";

test("applying a script version replaces obsolete input schema and preserves bindings and shorter timeout", async () => {
  const node: WorkflowNode = { id: "run", name: "Run", type: "script", input: { source: "workflow" }, inputSchema: { type: "object", required: ["old"] }, outputSchema: false, config: { scriptId: "transform", scriptVersionId: "old", timeoutMs: 2000 } };
  const inputSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, outputSchema = { type: "string" };
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes("/scripts/transform")
    ? { id: "transform", status: "published", currentPublishedVersionId: "new", versions: [{ id: "old", number: 1, status: "published", timeoutMs: 1000, inputSchema: node.inputSchema, outputSchema: false }, { id: "new", number: 2, status: "published", timeoutMs: 10000, inputSchema, outputSchema }] }
    : { items: [{ id: "transform", name: "Transform", currentPublishedVersionId: "new", status: "published", runtime: "nodejs" }] }), { status: 200 });
  let applied: WorkflowNode | undefined;
  render(createElement(ScriptNodePicker, { node, disabled: false, onApply: value => { applied = value; } }));
  await screen.findByRole("option", { name: "v2 · 最新发布" });
  fireEvent.change(screen.getByLabelText("固定发布版本"), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "应用此脚本版本" }));
  assert.deepEqual(applied?.inputSchema, inputSchema); assert.deepEqual(applied?.outputSchema, outputSchema);
  assert.deepEqual(applied?.input, node.input); assert.equal(applied?.config.timeoutMs, 2000); assert.equal(applied?.config.scriptVersionId, "new");
});

test("browser node credentials choose string keys without reading values and restore tool defaults", async () => {
  const calls: string[] = [];
  globalThis.fetch = async url => {
    const path = String(url); calls.push(path);
    const value = path.includes("/web-bridge/tools") ? { items: [{ toolId: "lookup", execution: { transport: "browser", credentialInputs: ["token"], preprocess: { credentials: { token: { dictionaryId, key: "defaultToken" } } } } }] }
      : path.includes(`/dictionaries/${dictionaryId}`) ? { id: dictionaryId, enabled: true, readiness: "ready", keys: { token: { type: "string", set: true }, number: { type: "number", set: true } } }
      : { items: [{ id: dictionaryId, name: "Credentials", kind: "encrypted", enabled: true, readiness: "ready" }], nextCursor: null };
    return new Response(JSON.stringify(value), { status: 200 });
  };
  const initial: WorkflowNode = { id: "call", name: "Call", type: "web-bridge", input: { source: "workflow" }, outputSchema: true, config: { application: "crm", tool: "lookup" } };
  let latest = initial;
  function Harness() {
    const [node, setNode] = useState(initial);
    return createElement(BridgeNodeCredentials, { node, disabled: false, onChange: value => {
      latest = { ...node, config: { ...node.config, credentialBindings: value } }; setNode(latest);
    } });
  }
  render(createElement(Harness));
  await screen.findByRole("button", { name: "选择节点凭据 token" });
  assert.equal((screen.getByLabelText("节点凭据 token") as HTMLInputElement).value, `{{dictionary:${dictionaryId}:defaultToken}}`);
  fireEvent.click(screen.getByRole("button", { name: "选择节点凭据 token" }));
  await screen.findByRole("button", { name: "Credentials" });
  fireEvent.click(screen.getByRole("button", { name: "Credentials" }));
  const key = await screen.findByRole("button", { name: "token" });
  assert.equal((screen.getByRole("button", { name: /number/ }) as HTMLButtonElement).disabled, true);
  fireEvent.click(key);
  await waitFor(() => assert.deepEqual(latest.config.credentialBindings, { token: { source: "dictionary", dictionaryId, key: "token" } }));
  fireEvent.click(screen.getByRole("button", { name: "恢复默认凭据 token" }));
  assert.equal(latest.config.credentialBindings, undefined);
  assert.equal((screen.getByLabelText("节点凭据 token") as HTMLInputElement).value, `{{dictionary:${dictionaryId}:defaultToken}}`);
  assert.ok(calls.every(path => !path.includes("/values")));
});
