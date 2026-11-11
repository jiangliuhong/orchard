import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createElement } from "react";
import { JSDOM } from "jsdom";
import { agentKnowledgeSettings } from "../src/agent/settings.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "navigator"])
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] });
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { AgentKnowledgeSettings } = await import("../src/web/features/AgentKnowledgeSettings.js");
afterEach(cleanup);

test("knowledge viewer is read-only, selects long paths and displays package/activation boundaries", async () => {
  const data = agentKnowledgeSettings();
  const calls: { url: string; method: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    calls.push({ url: String(url), method: options?.method ?? "GET" });
    return new Response(JSON.stringify(data), { status: 200 });
  }) as typeof fetch;
  try {
    render(createElement(AgentKnowledgeSettings));
    assert.ok(await screen.findByText(data.hash));
    assert.ok(screen.getByRole("status").textContent?.includes("尚未完成生产切换"));
    const path = ".agents/skills/workflow-authoring/SKILL.md";
    fireEvent.click(screen.getByRole("button", { name: path }));
    const source = screen.getByLabelText(`只读知识内容：${path}`);
    assert.equal(source.textContent, data.files.find(file => file.path === path)!.content);
    assert.equal(source.getAttribute("tabindex"), "0");
    assert.equal(screen.queryByRole("textbox"), null);
    assert.equal(screen.queryByRole("button", { name: /保存|发布|恢复默认/ }), null);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => assert.equal(calls.length, 2));
    assert.ok(calls.every(call => call.method === "GET" && call.url === "/api/settings/agent-knowledge"));
  } finally { globalThis.fetch = original; }
});
