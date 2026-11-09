import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { JSDOM } from "jsdom";
import { registerHooks } from "node:module";
import type { AgentModelConfigView, Binding, ConversationView, ProviderView, NodeRun, StreamEvent, Workflow } from "../src/domain/types.js";
import type { AgentChatConfig, ChatSubmission } from "../src/web/agent-chat/types.js";
import { projectGraph, applyEventStatus, renderableWorkflow } from "../src/web/features/graph.js";
import { mergeEvents } from "../src/web/lib/api.js";
import { exampleFiles } from "./helpers.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\/CodeEditor(?:\.(?:js|tsx))?$/.test(specifier) && context.parentURL?.includes("/src/web/features/")) {
      return { url: new URL("./fixtures/code-editor.mjs", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const name of ["window", "document", "HTMLElement", "HTMLFormElement", "HTMLSelectElement", "HTMLInputElement", "HTMLButtonElement", "HTMLOptionElement", "DocumentFragment", "Element", "Node", "NodeFilter", "MutationObserver", "Event", "MouseEvent", "CustomEvent", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, name, { value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true });
}
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.window.localStorage, configurable: true });
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
class EventSourceStub { onmessage: ((message: MessageEvent) => void) | null = null; close() {} }
Object.defineProperty(globalThis, "EventSource", { value: EventSourceStub, configurable: true });
Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverStub, configurable: true });
Object.defineProperty(dom.window, "ResizeObserver", { value: ResizeObserverStub, configurable: true });
Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get: () => 900, configurable: true });
Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get: () => 600, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", { value: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), configurable: true });
Object.defineProperty(globalThis, "cancelAnimationFrame", { value: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), configurable: true });
Object.defineProperty(dom.window, "requestAnimationFrame", { value: globalThis.requestAnimationFrame, configurable: true });
Object.defineProperty(dom.window, "cancelAnimationFrame", { value: globalThis.cancelAnimationFrame, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
const { render, screen, fireEvent, cleanup, waitFor, act } = await import("@testing-library/react");
const { ProviderPicker } = await import("../src/web/features/ProviderPicker.js");
const { AgentModelConfigPicker } = await import("../src/web/features/AgentModelConfigPicker.js");
const { SettingsPage } = await import("../src/web/features/SettingsPage.js");
const { WebBridgeSettings } = await import("../src/web/features/WebBridgeSettings.js");
const { ModelManager } = await import("../src/web/features/ModelManager.js");
const { DraftPage } = await import("../src/web/features/DraftPage.js");
const { RunPage } = await import("../src/web/features/RunPages.js");
const { DeleteWorkflowButton } = await import("../src/web/features/DeleteWorkflowButton.js");
const { WorkflowsPage, WorkflowPage } = await import("../src/web/features/WorkflowPages.js");
const { SourceFileList, SourceTabs } = await import("../src/web/features/SourceTabs.js");
const { WorkflowOutputEditor } = await import("../src/web/features/WorkflowOutputEditor.js");
const { FinalResult } = await import("../src/web/features/FinalResult.js");
const { BusinessApp: App } = await import("../src/web/App.js");
const { ScriptPage, ScriptsPage } = await import("../src/web/features/ScriptPages.js");
const { ScriptNodePicker } = await import("../src/web/features/ScriptNodePicker.js");
const { ScriptAgentPanel, ScriptAgentPreview } = await import("../src/web/features/ScriptAgentPanel.js");
const { AgentChat } = await import("../src/web/agent-chat/AgentChat.js");
const { ArchiveConversationButton } = await import("../src/web/features/ArchiveConversationButton.js");
const { ScriptCleanup, ScriptReferences } = await import("../src/web/features/ScriptVersionPanels.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { ThemePicker, ThemeProvider, themeStorageKey } = await import("../src/web/lib/theme.js");
afterEach(() => cleanup());

interface TestChatContext {
  allowAttachments: boolean;
  send: (submission: ChatSubmission) => Promise<void>;
}

const testChatConfig: AgentChatConfig<TestChatContext> = {
  id: "custom", label: "测试对话", promptLabel: "测试需求", placeholder: "请输入",
  welcome: { title: "开始对话", description: "自定义接入" },
  useSession: context => {
    const [conversationId, setConversationId] = useState("initial");
    return {
      conversationId, title: "新对话", conversations: [], messages: [],
      newConversation: () => setConversationId(crypto.randomUUID()),
      selectConversation: setConversationId,
      send: context.send,
    };
  },
  attachments: {
    enabled: context => context.allowAttachments,
    renderPicker: ({ onAdd, onClose }) => createElement("button", { onClick: () => {
      onAdd({ id: "custom-resource", kind: "custom", label: "自定义资料", payload: { resource: "sample" } });
      onClose();
    } }, "添加自定义资料"),
  },
};

test("shared Agent chat lets integrations hide attachments and provide their own picker and payload", async () => {
  const originalFetch = globalThis.fetch, submissions: ChatSubmission[] = [];
  globalThis.fetch = async () => Response.json({ items: [provider({ models: [{ id: "test-model", name: "Test", source: "configured" }] })] });
  localStorage.setItem("orchard-workbench-agent", JSON.stringify({ providerId: "third-provider", modelId: "test-model" }));
  try {
    const context: TestChatContext = { allowAttachments: false, send: async input => { submissions.push(input); } };
    const view = render(createElement(AgentChat<TestChatContext>, { config: testChatConfig, context, resourceKey: "resource" }));
    assert.equal(screen.queryByRole("button", { name: "添加引用" }), null);
    view.rerender(createElement(AgentChat<TestChatContext>, { config: testChatConfig, context: { ...context, allowAttachments: true }, resourceKey: "resource" }));
    fireEvent.click(screen.getByRole("button", { name: "添加引用" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加自定义资料" }));
    assert.ok(screen.getByText("自定义资料"));
    assert.equal(screen.queryByRole("button", { name: "添加自定义资料" }), null);
    fireEvent.change(screen.getByLabelText("测试需求"), { target: { value: "带引用的问题" } });
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, false));
    fireEvent.keyDown(screen.getByLabelText("测试需求"), { ctrlKey: true, key: "Enter" });
    await waitFor(() => assert.equal(submissions.length, 1));
    assert.equal(submissions[0]!.prompt, "带引用的问题");
    assert.deepEqual(submissions[0]!.attachments[0]!.payload, { resource: "sample" });
    fireEvent.click(screen.getByRole("button", { name: "移除引用：自定义资料" }));
    assert.equal(screen.queryByText("自定义资料"), null);
    view.rerender(createElement(AgentChat<TestChatContext>, { config: { ...testChatConfig, attachments: undefined }, context, resourceKey: "resource" }));
    assert.equal(screen.queryByRole("button", { name: "添加引用" }), null);
  } finally { globalThis.fetch = originalFetch; localStorage.clear(); }
});

test("shared Agent chat keeps send controls outside the scrollable composer body for long prompts", async () => {
  const originalFetch = globalThis.fetch, submissions: ChatSubmission[] = [];
  globalThis.fetch = async () => Response.json({ items: [provider({ models: [{ id: "test-model", name: "Test", source: "configured" }] })] });
  localStorage.setItem("orchard-workbench-agent", JSON.stringify({ providerId: "third-provider", modelId: "test-model" }));
  try {
    const context: TestChatContext = { allowAttachments: false, send: async input => { submissions.push(input); } };
    render(createElement(AgentChat<TestChatContext>, { config: testChatConfig, context, resourceKey: "long-prompt" }));
    const input = screen.getByLabelText("测试需求");
    const prompt = "这是一段很长的代码和说明。\n".repeat(500);
    fireEvent.change(input, { target: { value: prompt } });
    const send = screen.getByRole("button", { name: "发送" });
    await waitFor(() => assert.equal((send as HTMLButtonElement).disabled, false));
    const body = input.closest(".chat-compose-body");
    assert.ok(body);
    assert.equal(body.contains(send), false);
    assert.equal(send.closest(".compose-footer")?.parentElement, body.parentElement);
    fireEvent.click(send);
    await waitFor(() => assert.equal(submissions.length, 1));
    assert.equal(submissions[0]!.prompt, prompt.trim());
  } finally { globalThis.fetch = originalFetch; localStorage.clear(); }
});

test("shared Agent chat quotes only selected text into the editable prompt and follows sends", async () => {
  const originalFetch = globalThis.fetch, submissions: ChatSubmission[] = [];
  globalThis.fetch = async () => Response.json({ items: [provider({ models: [{ id: "test-model", name: "Test", source: "configured" }] })] });
  localStorage.setItem("orchard-workbench-agent", JSON.stringify({ providerId: "third-provider", modelId: "test-model" }));
  let fail = true;
  const config: AgentChatConfig<TestChatContext> = {
    ...testChatConfig,
    useSession: (context, choice, choose) => ({
      ...testChatConfig.useSession(context, choice, choose),
      messages: [{ id: "answer", role: "assistant", text: "开头：第一行\n第二行：结尾" }],
    }),
  };
  try {
    const context: TestChatContext = { allowAttachments: false, send: async input => {
      submissions.push(input);
      if (fail) throw new Error("发送失败");
    } };
    render(createElement(AgentChat<TestChatContext>, { config, context, resourceKey: "reply" }));
    const transcript = document.querySelector(".agent-chat-messages") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { value: 1800, configurable: true });
    transcript.scrollTop = 0;
    fireEvent.scroll(transcript);
    assert.ok(!screen.queryByRole("button", { name: "引用回复" }));
    const input = screen.getByLabelText("测试需求") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "已有的问题" } });
    const node = screen.getByText(/开头：第一行/).firstChild!;
    const range = document.createRange();
    range.setStart(node, 3);
    range.setEnd(node, 10);
    Object.defineProperty(range, "getClientRects", { value: () => [{ top: 200, left: 100, width: 120 }] });
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(transcript);
    const quoteButton = screen.getByRole("button", { name: "引用回复" });
    assert.equal(quoteButton.style.top, "192px");
    assert.equal(quoteButton.style.left, "160px");
    assert.equal(quoteButton.parentElement, document.body, "floating action is not clipped by the message scroller");
    fireEvent.keyDown(document, { key: "Escape" });
    assert.ok(!screen.queryByRole("button", { name: "引用回复" }));
    fireEvent.mouseUp(transcript);
    fireEvent.click(screen.getByRole("button", { name: "引用回复" }));
    assert.equal(input.value, "已有的问题\n\n>第一行\n>第二行\n\n");
    assert.equal(document.activeElement, input);
    assert.ok(!screen.queryByRole("button", { name: "引用回复" }));
    assert.equal(transcript.scrollTop, 0, "quoting should not interrupt reading history");
    fireEvent.change(input, { target: { value: input.value + "请详细解释" } });
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("发送失败");
    assert.equal(transcript.scrollTop, 1800);
    assert.equal(submissions[0]!.prompt, "已有的问题\n\n>第一行\n>第二行\n\n请详细解释");
    assert.equal(input.value, submissions[0]!.prompt, "failed sends preserve the editable quote");
    fail = false;
    fireEvent.keyDown(input, { ctrlKey: true, key: "Enter" });
    await waitFor(() => assert.equal(input.value, ""));
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0]!.requestId, submissions[1]!.requestId);
  } finally { window.getSelection()?.removeAllRanges(); globalThis.fetch = originalFetch; localStorage.clear(); }
});

test("shared Agent chat preserves failed prompts and request IDs, prevents duplicate sends, and resets resources", async () => {
  const originalFetch = globalThis.fetch, submissions: ChatSubmission[] = [];
  globalThis.fetch = async () => Response.json({ items: [provider({ models: [{ id: "test-model", name: "Test", source: "configured" }] })] });
  localStorage.setItem("orchard-workbench-agent", JSON.stringify({ providerId: "third-provider", modelId: "test-model" }));
  let rejectSend: (error: Error) => void = () => {};
  try {
    const context: TestChatContext = { allowAttachments: true, send: input => {
      submissions.push(input);
      return new Promise<void>((_resolve, reject) => { rejectSend = reject; });
    } };
    const view = render(createElement(AgentChat<TestChatContext>, { config: testChatConfig, context, resourceKey: "first" }));
    fireEvent.change(screen.getByLabelText("测试需求"), { target: { value: "请解释这个问题" } });
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.keyDown(screen.getByLabelText("测试需求"), { metaKey: true, key: "Enter" });
    assert.equal(submissions.length, 1);
    await act(async () => rejectSend(new Error("暂时不可用")));
    assert.ok(await screen.findByText("暂时不可用"));
    assert.equal((screen.getByLabelText("测试需求") as HTMLTextAreaElement).value, "请解释这个问题");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0]!.requestId, submissions[1]!.requestId);
    view.rerender(createElement(AgentChat<TestChatContext>, { config: testChatConfig, context, resourceKey: "second" }));
    assert.equal((screen.getByLabelText("测试需求") as HTMLTextAreaElement).value, "");
    await act(async () => rejectSend(new Error("旧资源失败")));
    assert.equal(screen.queryByText("旧资源失败"), null);
  } finally { globalThis.fetch = originalFetch; localStorage.clear(); }
});
test("Web Bridge displays the browser extension directory while no browser is connected", async () => {
  const originalFetch = globalThis.fetch;
  const directory = "/Applications/Orchard/dist/web-bridge/extension";
  globalThis.fetch = async url => {
    if (String(url).endsWith("/extension")) return Response.json({ directory });
    if (String(url).endsWith("/auth")) return Response.json({ configured: true, last4: "1234" });
    return Response.json({ items: [] });
  };
  try {
    render(createElement(WebBridgeSettings));
    fireEvent.click(screen.getByRole("button", { name: "浏览器连接" }));
    await waitFor(() => assert.equal((screen.getByLabelText("浏览器插件目录") as HTMLInputElement).value, directory));
    assert.ok((screen.getByLabelText("浏览器插件目录") as HTMLInputElement).readOnly);
    assert.ok(screen.getByText(/chrome:\/\/extensions/));
    assert.ok(await screen.findByText("创建第一个网页应用"));
  } finally { globalThis.fetch = originalFetch; }
});

test("Web Bridge reports extension directory loading failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith("/extension")
    ? Response.json({ message: "无法读取插件目录" }, { status: 500 })
    : Response.json({ items: [] });
  try {
    render(createElement(WebBridgeSettings));
    fireEvent.click(screen.getByRole("button", { name: "浏览器连接" }));
    assert.ok(await screen.findByText("无法读取插件目录"));
    assert.equal((screen.getByLabelText("浏览器插件目录") as HTMLInputElement).placeholder, "目录加载失败");
  } finally { globalThis.fetch = originalFetch; }
});

test("Web Bridge refreshes browser profiles and offers newly registered profiles for environment binding", async () => {
  const originalFetch = globalThis.fetch;
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  let connected = false;
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.endsWith("/extension")) return Response.json({ directory: "/orchard/extension" });
    if (path.endsWith("/auth")) return Response.json({ configured: true, last4: "1234" });
    if (path.endsWith("/applications")) return Response.json({ items: [{ id: "crm", name: "CRM", enabled: true, environments: [] }] });
    if (path.endsWith("/profiles")) return Response.json({ items: connected ? [{ id: extensionId, name: "Chrome · klmnop", extensionId, connected: true, lastSeen: Date.now() }] : [] });
    return Response.json({ items: [] });
  };
  try {
    render(createElement(WebBridgeSettings));
    fireEvent.click(await screen.findByRole("button", { name: "环境" }));
    assert.ok(screen.getByText("暂无已连接的浏览器资料，请先启动 Chrome 扩展。"));
    connected = true;
    fireEvent.click(screen.getByRole("button", { name: "浏览器连接" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新浏览器资料" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    assert.ok(await screen.findByRole("option", { name: "Chrome · klmnop · ijklmnop · 已连接" }));
    assert.equal(screen.queryByText("浏览器资料：1 个在线"), null);
  } finally { globalThis.fetch = originalFetch; }
});

test("Web Bridge lists named browser profiles with details and refreshes names without changing bindings", async () => {
  const originalFetch = globalThis.fetch;
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  let name = "工作 Chrome";
  const lastSeen = Date.UTC(2026, 10, 6, 9);
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.endsWith("/extension")) return Response.json({ directory: "/orchard/extension" });
    if (path.endsWith("/auth")) return Response.json({ configured: true, last4: "1234" });
    if (path.endsWith("/applications")) return Response.json({ items: [{ id: "crm", name: "CRM", enabled: true, environments: [{ id: "prod", origin: "https://example.test", profileId: "profile-work", bound: true }] }] });
    if (path.endsWith("/profiles")) return Response.json({ items: [
      { id: "profile-work", name, extensionId, connected: true, lastSeen },
      { id: "profile-test", name: "测试 Chrome", extensionId, connected: false, lastSeen },
    ] });
    return Response.json({ items: [] });
  };
  try {
    render(createElement(WebBridgeSettings));
    fireEvent.click(screen.getByRole("button", { name: "浏览器连接" }));
    await screen.findByText("已注册的浏览器资料：2");
    const list = screen.getByRole("region", { name: "浏览器资料列表" });
    assert.ok(list.textContent?.includes("工作 Chrome"));
    assert.ok(list.textContent?.includes("测试 Chrome"));
    assert.ok(list.textContent?.includes("profile-work"));
    assert.ok(list.textContent?.includes(extensionId));
    assert.equal(list.querySelector("time")!.dateTime, new Date(lastSeen).toISOString());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(await screen.findByRole("button", { name: "环境" }));
    const select = screen.getByRole("combobox", { name: "选择浏览器资料" }) as HTMLSelectElement;
    const work = screen.getByRole("option", { name: "工作 Chrome · ile-work · 已连接" }) as HTMLOptionElement;
    assert.equal(work.value, "profile-work");
    assert.equal((screen.getByRole("option", { name: "测试 Chrome · ile-test · 已断开" }) as HTMLOptionElement).disabled, true);
    fireEvent.change(select, { target: { value: "profile-work" } });
    name = "财务工作浏览器";
    fireEvent.click(screen.getByRole("button", { name: "刷新网页桥接" }));
    await screen.findByRole("option", { name: "财务工作浏览器 · ile-work · 已连接" });
    assert.equal(select.value, "profile-work");
    assert.ok(screen.getByText("财务工作浏览器 · 已绑定"));
  } finally { globalThis.fetch = originalFetch; }
});

function clearBridgePreferences() {
  for (const key of Object.keys(localStorage)) if (key.startsWith("orchard.bridge.")) localStorage.removeItem(key);
}
const bridgeTestTool = (application: string, toolId = "query") => ({
  application, toolId, site: application, description: `${application} 查询`, parameters: { type: "object", properties: {} },
  path: "/api/query", method: "GET", fields: ["items"], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", enabled: true,
});
test("Bridge application deletion confirms, preserves failures and selects the next application", async () => {
  clearBridgePreferences(); localStorage.setItem("orchard.bridge.agentOpen", "false");
  localStorage.setItem("orchard.bridge.crm.tool", "missing");
  const originalFetch = globalThis.fetch;
  let applications = ["crm", "orders"], deletes = 0, fail = true;
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (options?.method === "DELETE") {
      deletes++;
      if (fail) return Response.json({ message: "请先停止此应用的 Agent 生成任务" }, { status: 409 });
      applications = applications.filter(id => !path.endsWith(`/${id}`));
      return Response.json({ applicationId: path.split("/").at(-1), environments: 0, tools: 1 });
    }
    if (path.endsWith("/applications")) return Response.json({ items: applications.map(id => ({ id, name: id, enabled: true, environments: [] })) });
    if (path.endsWith("/tools")) return Response.json({ items: applications.map(id => bridgeTestTool(id)) });
    return Response.json({ items: [], conversations: [] });
  };
  try {
    render(createElement(WebBridgeSettings));
    fireEvent.click(await screen.findByRole("button", { name: "删除应用 crm" }));
    assert.ok(await screen.findByText(/0 个环境和 1 个工具定义，且无法撤销/));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    assert.equal(deletes, 0);
    fireEvent.click(screen.getByRole("button", { name: "删除应用 crm" }));
    fireEvent.click(screen.getByRole("button", { name: "删除应用" }));
    await waitFor(() => assert.equal(deletes, 1));
    assert.ok(await screen.findByRole("dialog", { name: "删除应用" }));
    assert.ok(document.querySelector('[aria-label="选择应用 crm"]'));
    fail = false;
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "删除应用" }) as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole("button", { name: "删除应用" }));
    await waitFor(() => assert.equal(screen.queryByRole("button", { name: "选择应用 crm" }), null));
    assert.equal(screen.getByRole("button", { name: "选择应用 orders" }).getAttribute("aria-pressed"), "true");
    assert.equal(localStorage.getItem("orchard.bridge.crm.tool"), "");
    fireEvent.click(screen.getByRole("button", { name: "删除应用 orders" }));
    fireEvent.click(screen.getByRole("button", { name: "删除应用" }));
    assert.ok(await screen.findByText("创建第一个网页应用"));
  } finally { globalThis.fetch = originalFetch; clearBridgePreferences(); }
});

test("Bridge workspace protects unsaved tools, keeps tests isolated by application and tolerates unavailable profiles", async () => {
  clearBridgePreferences();
  localStorage.setItem("orchard.bridge.agentOpen", "false");
  const originalFetch = globalThis.fetch;
  let saved = 0, testCalls = 0;
  const tools = [bridgeTestTool("crm"), bridgeTestTool("orders")];
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.endsWith("/profiles")) return Response.json({ message: "资料暂不可用" }, { status: 500 });
    if (path.endsWith("/applications")) return Response.json({ items: ["crm", "orders"].map(id => ({ id, name: id, enabled: true, environments: [] })) });
    if (path.endsWith("/definition")) { saved++; tools[0] = JSON.parse(String(options?.body)); return Response.json(tools[0]); }
    if (path.endsWith("/tools")) return Response.json({ items: tools });
    if (path.endsWith("/test")) { testCalls++; return Response.json({ items: ["CRM_RESULT"] }); }
    return Response.json({ items: [], conversations: [] });
  };
  try {
    render(createElement(WebBridgeSettings));
    fireEvent.click(await screen.findByRole("button", { name: "编辑工具 query" }));
    fireEvent.change(screen.getByLabelText("工具说明"), { target: { value: "手动修改" } });
    fireEvent.click(screen.getByRole("button", { name: "选择应用 orders" }));
    assert.ok(await screen.findByRole("dialog", { name: "有未保存的工具修改" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    assert.equal((screen.getByLabelText("工具说明") as HTMLInputElement).value, "手动修改");
    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    assert.equal((screen.getByRole("button", { name: "执行测试" }) as HTMLButtonElement).disabled, true);
    fireEvent.click(screen.getByRole("button", { name: "工具定义" }));
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => assert.equal(saved, 1));
    await screen.findByText("工具定义已保存");
    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    fireEvent.click(screen.getByRole("button", { name: "执行测试" }));
    await screen.findByText(/CRM_RESULT/);
    fireEvent.click(screen.getByRole("button", { name: "选择应用 orders" }));
    fireEvent.click(await screen.findByRole("button", { name: "编辑工具 query" }));
    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    assert.equal(screen.queryByText(/CRM_RESULT/), null);
    assert.equal(testCalls, 1);
    assert.equal(screen.queryByText("浏览器资料：状态不可用"), null);
  } finally { globalThis.fetch = originalFetch; clearBridgePreferences(); }
});

test("Bridge JSON saves fill missing identity and use the returned definition for forms and tests", async () => {
  clearBridgePreferences(); localStorage.setItem("orchard.bridge.agentOpen", "false");
  const originalFetch = globalThis.fetch;
  let tools = [bridgeTestTool("crm")];
  const writes: { url: string; method?: string; body: ReturnType<typeof bridgeTestTool> }[] = [];
  let tested = "";
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (options?.method === "PATCH" || options?.method === "POST") {
      if (path.endsWith("/test")) { tested = path; return Response.json({ items: ["NORMALIZED_RESULT"] }); }
      const definition = { ...JSON.parse(String(options.body)), catalogVersion: "server-version" };
      writes.push({ url: path, method: options.method, body: definition });
      tools = [...tools.filter(tool => tool.toolId !== definition.toolId), definition];
      return Response.json(definition);
    }
    if (path.endsWith("/applications")) return Response.json({ items: [{ id: "crm", name: "CRM", enabled: true, environments: [] }] });
    return Response.json({ items: path.endsWith("/tools") ? tools : [] });
  };
  try {
    render(createElement(WebBridgeSettings));
    fireEvent.click(await screen.findByRole("button", { name: "编辑工具 query" }));
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const { application: _application, toolId: _toolId, ...content } = bridgeTestTool("crm");
    fireEvent.change(screen.getByLabelText("工具 JSON 定义"), { target: { value: JSON.stringify(content) } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("工具定义已保存");
    assert.equal(writes[0]!.method, "PATCH");
    assert.ok(writes[0]!.url.endsWith("/crm/tools/query/definition"));
    assert.equal(writes[0]!.body.application, "crm"); assert.equal(writes[0]!.body.toolId, "query");
    assert.equal(JSON.parse((screen.getByLabelText("工具 JSON 定义") as HTMLTextAreaElement).value).catalogVersion, "server-version");
    assert.equal((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled, true);
    fireEvent.click(screen.getByRole("button", { name: "表单" }));
    assert.equal((screen.getByLabelText("工具 ID") as HTMLInputElement).value, "query");
    assert.equal((screen.getByLabelText("定义版本") as HTMLInputElement).value, "server-version");
    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    fireEvent.click(screen.getByRole("button", { name: "执行测试" }));
    await screen.findByText(/NORMALIZED_RESULT/);
    assert.ok(tested.endsWith("/crm/tools/query/test"));
    fireEvent.click(screen.getByRole("button", { name: "工具列表" }));
    fireEvent.click(screen.getByRole("button", { name: "新建工具" }));
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    fireEvent.change(screen.getByLabelText("工具 JSON 定义"), { target: { value: JSON.stringify(content) } });
    fireEvent.click(screen.getByRole("button", { name: "表单" }));
    assert.equal((screen.getByLabelText("工具 ID") as HTMLInputElement).value, "");
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    fireEvent.change(screen.getByLabelText("工具 JSON 定义"), { target: { value: JSON.stringify({ ...content, toolId: "new_query" }) } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => assert.equal(writes.length, 2));
    await screen.findByText("工具定义已保存");
    assert.equal(writes[1]!.method, "POST"); assert.equal(writes[1]!.body.application, "crm");
    assert.equal(writes[1]!.body.toolId, "new_query");
  } finally { globalThis.fetch = originalFetch; clearBridgePreferences(); }
});

test("Bridge JSON conflicts can be corrected or saved as a new tool without changing the original", async () => {
  clearBridgePreferences(); localStorage.setItem("orchard.bridge.agentOpen", "false");
  const originalFetch = globalThis.fetch, original = bridgeTestTool("crm");
  const tools = [original];
  let attempts = 0, tested = "";
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (options?.method === "POST") {
      if (path.endsWith("/test")) { tested = path; return Response.json({ items: ["COPY_RESULT"] }); }
      attempts++;
      if (attempts === 1) return Response.json({ message: "暂时无法保存" }, { status: 500 });
      const definition = JSON.parse(String(options.body)); tools.push(definition); return Response.json(definition);
    }
    assert.notEqual(options?.method, "PATCH");
    if (path.endsWith("/applications")) return Response.json({ items: [{ id: "crm", name: "CRM", enabled: true, environments: [] }] });
    return Response.json({ items: path.endsWith("/tools") ? tools : [] });
  };
  try {
    render(createElement(WebBridgeSettings));
    fireEvent.click(await screen.findByRole("button", { name: "编辑工具 query" }));
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    fireEvent.change(screen.getByLabelText("工具 JSON 定义"), { target: { value: JSON.stringify({ ...original, application: "other", toolId: "copy_query", description: "复制后的修改" }) } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    assert.ok(screen.getByRole("alert").textContent?.includes('JSON 中的应用 ID 为 "other"，当前应用为 crm'));
    fireEvent.click(screen.getByRole("button", { name: "使用当前应用 ID" }));
    assert.equal(JSON.parse((screen.getByLabelText("工具 JSON 定义") as HTMLTextAreaElement).value).application, "crm");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    assert.ok(screen.getByRole("alert").textContent?.includes("当前工具 ID 为 query"));
    assert.equal(attempts, 0);
    fireEvent.click(screen.getByRole("button", { name: "另存为新工具" }));
    assert.equal((screen.getByLabelText("新工具 ID") as HTMLInputElement).value, "copy_query");
    fireEvent.change(screen.getByLabelText("新工具 ID"), { target: { value: "query" } });
    fireEvent.click(screen.getByRole("button", { name: "创建新工具" }));
    assert.ok(screen.getAllByText("工具 ID 已存在，请使用其他 ID").length);
    assert.equal(attempts, 0);
    fireEvent.change(screen.getByLabelText("新工具 ID"), { target: { value: "copy_query" } });
    fireEvent.click(screen.getByRole("button", { name: "创建新工具" }));
    await screen.findAllByText("暂时无法保存");
    assert.ok(screen.getByRole("dialog", { name: "另存为新工具" }));
    assert.ok((screen.getByLabelText("工具 JSON 定义") as HTMLTextAreaElement).value.includes("复制后的修改"));
    fireEvent.click(screen.getByRole("button", { name: "创建新工具" }));
    await screen.findByText("已另存为新工具");
    assert.equal(screen.queryByRole("dialog"), null);
    assert.deepEqual(tools[0], original); assert.equal(tools.length, 2);
    assert.equal(tools[1]!.toolId, "copy_query"); assert.equal(tools[1]!.application, "crm");
    assert.equal((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled, true);
    fireEvent.click(screen.getByRole("button", { name: "表单" }));
    assert.equal((screen.getByLabelText("工具 ID") as HTMLInputElement).value, "copy_query");
    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    fireEvent.click(screen.getByRole("button", { name: "执行测试" }));
    await screen.findByText(/COPY_RESULT/);
    assert.ok(tested.endsWith("/crm/tools/copy_query/test"));
  } finally { globalThis.fetch = originalFetch; clearBridgePreferences(); }
});

test("Bridge JSON rejects invalid roots and keeps the draft after a failed save", async () => {
  clearBridgePreferences(); localStorage.setItem("orchard.bridge.agentOpen", "false");
  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (url, options) => {
    if (options?.method === "PATCH") { writes++; return Response.json({ message: "定义校验失败" }, { status: 400 }); }
    if (String(url).endsWith("/applications")) return Response.json({ items: [{ id: "crm", name: "CRM", enabled: true, environments: [] }] });
    return Response.json({ items: String(url).endsWith("/tools") ? [bridgeTestTool("crm")] : [] });
  };
  try {
    render(createElement(WebBridgeSettings));
    fireEvent.click(await screen.findByRole("button", { name: "编辑工具 query" }));
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    for (const value of ["null", "[]", '"text"', "12"]) {
      fireEvent.change(screen.getByLabelText("工具 JSON 定义"), { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      assert.ok(screen.getByText("工具定义必须是 JSON 对象"));
    }
    assert.equal(writes, 0);
    const value = JSON.stringify({ ...bridgeTestTool("crm"), description: "保留草稿" });
    fireEvent.change(screen.getByLabelText("工具 JSON 定义"), { target: { value } });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await screen.findByText("定义校验失败");
    assert.equal(writes, 1);
    assert.equal((screen.getByLabelText("工具 JSON 定义") as HTMLTextAreaElement).value, value);
    fireEvent.click(screen.getByRole("button", { name: "工具列表" }));
    assert.ok(screen.getByRole("dialog", { name: "有未保存的工具修改" }));
  } finally { globalThis.fetch = originalFetch; clearBridgePreferences(); }
});

test("Bridge tool forms preserve invalid JSON until corrected and failed deletion remains retryable", async () => {
  clearBridgePreferences(); localStorage.setItem("orchard.bridge.agentOpen", "false");
  const originalFetch = globalThis.fetch;
  let deletes = 0;
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (options?.method === "DELETE") { deletes++; return deletes === 1 ? Response.json({ message: "请先停止任务" }, { status: 409 }) : Response.json({ ok: true }); }
    if (path.endsWith("/applications")) return Response.json({ items: [{ id: "crm", name: "CRM", enabled: true, environments: [] }] });
    if (path.endsWith("/tools")) return Response.json({ items: [bridgeTestTool("crm")] });
    return Response.json({ items: [] });
  };
  try {
    render(createElement(WebBridgeSettings));
    fireEvent.click(await screen.findByRole("button", { name: "编辑工具 query" }));
    fireEvent.change(screen.getByLabelText("参数 Schema（JSON）"), { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "工具列表" }));
    assert.ok(screen.getByRole("dialog", { name: "有未保存的工具修改" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    assert.equal((screen.getByLabelText("参数 Schema（JSON）") as HTMLTextAreaElement).value, "{");
    assert.equal((screen.getByRole("button", { name: "测试" }) as HTMLButtonElement).disabled, true);
    fireEvent.change(screen.getByLabelText("参数 Schema（JSON）"), { target: { value: '{"type":"object","properties":{}}' } });
    fireEvent.click(screen.getByRole("button", { name: "工具列表" }));
    fireEvent.click(screen.getByRole("button", { name: "删除工具 query" }));
    fireEvent.click(screen.getByRole("button", { name: "删除工具" }));
    await screen.findAllByText("请先停止任务");
    assert.ok(screen.getByRole("dialog", { name: "删除工具" }));
    fireEvent.click(screen.getByRole("button", { name: "删除工具" }));
    await waitFor(() => assert.equal(screen.queryAllByRole("dialog").length, 0));
    assert.equal(deletes, 2);
  } finally { globalThis.fetch = originalFetch; clearBridgePreferences(); }
});

test("Bridge Agent sends scoped conversations, reviews changes without mutation and applies explicitly", async () => {
  clearBridgePreferences();
  localStorage.setItem("orchard.bridge.provider", JSON.stringify({ providerId: "third-provider", modelId: "model" }));
  const originalFetch = globalThis.fetch;
  let turn: Record<string, unknown> | undefined, applied = 0;
  let received: Record<string, unknown> | undefined;
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.endsWith("/applications")) return Response.json({ items: [{ id: "crm", name: "CRM", enabled: true, environments: [] }] });
    if (path.endsWith("/tools")) return Response.json({ items: [] });
    if (path.endsWith("/providers")) return Response.json({ items: [provider({ defaultModel: "model", models: [{ id: "model", name: "Model", source: "configured", enabled: true }] })] });
    if (path.endsWith("/apply")) { applied++; return Response.json({ hash: "applied-hash" }); }
    if (path.includes("/agent/turns")) {
      if (options?.method === "POST") {
        received = JSON.parse(String(options.body));
        turn = { id: "turn", application: "crm", conversationId: received!.conversationId, prompt: received!.prompt, status: "succeeded", baseHash: "base", base: [], proposal: { summary: "建议新增查询工具", changes: [{ operation: "create", toolId: "query", definition: bridgeTestTool("crm") }] } };
        return Response.json(turn);
      }
      return Response.json({ items: turn ? [turn] : [], conversations: turn ? [{ id: turn.conversationId, title: turn.prompt, updatedAt: 1 }] : [] });
    }
    return Response.json({ items: [] });
  };
  try {
    render(createElement(WebBridgeSettings));
    await screen.findByText("当前应用：CRM");
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, true));
    fireEvent.change(screen.getByLabelText("Agent 维护需求"), { target: { value: "请新增查询工具" } });
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.click(await screen.findByRole("button", { name: "审阅 1 项变更" }));
    assert.ok(await screen.findByLabelText("变更差异：query.json"));
    assert.equal(applied, 0);
    assert.equal(received?.prompt, "请新增查询工具");
    assert.equal(received?.providerId, "third-provider");
    assert.equal(received?.testContext, undefined);
    fireEvent.click(screen.getByRole("button", { name: "确认应用变更" }));
    await waitFor(() => assert.equal(applied, 1));
    await screen.findByRole("button", { name: "已应用" });
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await waitFor(() => assert.equal(screen.getByRole("complementary", { name: "应用 Agent 维护" }).querySelector(".agent-chat-messages")!.textContent?.includes("请新增查询工具"), false));
    assert.equal(applied, 1);
  } finally { globalThis.fetch = originalFetch; clearBridgePreferences(); }
});

test("script list filters request server pagination and exposes script creation", async () => {
  const originalFetch = globalThis.fetch, requests: string[] = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    return Response.json({ total: 1, items: [{ id: "normalize", name: "文本清洗", runtime: "nodejs", status: "published", currentDraftVersionId: "draft-id", currentPublishedVersionId: "version-id", publishedVersion: 2, updatedAt: 0 }] });
  };
  try {
    render(createElement(ScriptsPage));
    assert.ok(await screen.findByRole("link", { name: /文本清洗/ }));
    assert.ok(screen.getByText(/发布版本 v2/));
    fireEvent.change(screen.getByLabelText("搜索脚本"), { target: { value: "clean" } });
    fireEvent.change(screen.getByLabelText("筛选运行时"), { target: { value: "shell" } });
    await waitFor(() => assert.ok(requests.some(url => url.includes("q=clean") && url.includes("runtime=shell") && url.includes("offset=0"))));
    fireEvent.click(screen.getByRole("button", { name: "新建脚本" }));
    assert.ok(screen.getByLabelText("脚本 ID"));
    assert.ok(screen.getByLabelText("运行时"));
  } finally { globalThis.fetch = originalFetch; }
});

test("scripts empty-state add button opens the creation dialog", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ items: [], total: 0 });
  try {
    render(createElement(ScriptsPage));
    await screen.findByText("没有匹配的脚本");
    fireEvent.click(screen.getByRole("button", { name: "添加脚本" }));
    assert.ok(screen.getByRole("dialog"));
    assert.ok(screen.getByLabelText("脚本 ID"));
    assert.ok(screen.getByLabelText("脚本名称"));
    assert.ok(screen.getByLabelText("运行时"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
    fireEvent.click(screen.getByRole("button", { name: "新建脚本" }));
    assert.ok(screen.getByRole("dialog"));
  } finally { globalThis.fetch = originalFetch; }
});

test("script three-column workspace keeps Agent visible and preserves run input across inspector tabs", async () => {
  const originalFetch = globalThis.fetch;
  const version = { id: "draft-v1", number: 1, status: "draft", revision: 1, files: {}, entryFile: "main.ts", inputSchema: true, outputSchema: true, timeoutMs: 1000, validation: { valid: true, diagnostics: [] } };
  globalThis.fetch = async url => Response.json(String(url) === "/api/scripts/test"
    ? { id: "test", name: "测试脚本", description: "", runtime: "nodejs", status: "draft", currentDraftVersionId: version.id, versions: [version], draft: version }
    : String(url).endsWith("/versions/draft-v1") ? version : { items: [], total: 0, activeCount: 0 });
  try {
    render(createElement(ScriptPage, { id: "test" }));
    const runTab = await screen.findByRole("tab", { name: "运行" });
    assert.equal(runTab.getAttribute("aria-selected"), "true");
    assert.ok(screen.getByRole("complementary", { name: "Agent 对话" }));
    const testInput = screen.getByLabelText("测试输入 JSON");
    fireEvent.change(testInput, { target: { value: '{"message":"保留测试输入"}' } });
    fireEvent.change(screen.getByLabelText("描述脚本需求或修复要求"), { target: { value: "保留这个需求" } });
    fireEvent.keyDown(runTab, { key: "ArrowRight" });
    const referencesTab = screen.getByRole("tab", { name: "引用" });
    assert.equal(document.activeElement, referencesTab);
    assert.equal(screen.getByRole("tabpanel").id, "script-panel-references");
    assert.ok(screen.getByLabelText("描述脚本需求或修复要求"));
    assert.ok(screen.getByLabelText("新文件路径"));
    assert.equal((screen.getByLabelText("描述脚本需求或修复要求") as HTMLTextAreaElement).value, "保留这个需求");
    fireEvent.keyDown(referencesTab, { key: "Home" });
    assert.equal(screen.getByRole("tabpanel").id, "script-panel-run");
    assert.equal((screen.getByLabelText("测试输入 JSON") as HTMLTextAreaElement).value, '{"message":"保留测试输入"}');
  } finally { globalThis.fetch = originalFetch; }
});

test("workflow script picker applies a fixed published version and retains the input binding", async () => {
  const originalFetch = globalThis.fetch;
  const script = { id: "normalize", name: "文本清洗", runtime: "nodejs", status: "published", currentPublishedVersionId: "version-2" };
  globalThis.fetch = async url => Response.json(String(url).includes("/scripts/normalize")
    ? { ...script, versions: [{ id: "version-1", number: 1, status: "published", timeoutMs: 60000, inputSchema: true, outputSchema: { type: "object" } }, { id: "version-2", number: 2, status: "published", timeoutMs: 300000, inputSchema: true, outputSchema: true }], draft: null }
    : { items: [script] });
  try {
    const node = JSON.parse(exampleFiles()["workflow.json"]).nodes[0], applied: unknown[] = [];
    node.config.timeoutMs = 120000;
    const view = render(createElement(ScriptNodePicker, { node, disabled: false, onApply: value => applied.push(value) }));
    await screen.findByRole("option", { name: /文本清洗/ });
    fireEvent.change(screen.getByLabelText("脚本"), { target: { value: "normalize" } });
    await screen.findByRole("option", { name: "v1" });
    fireEvent.change(screen.getByLabelText("固定发布版本"), { target: { value: "version-1" } });
    fireEvent.click(screen.getByRole("button", { name: "应用此脚本版本" }));
    assert.deepEqual(applied, [{ ...node, type: "script", config: { scriptId: "normalize", scriptVersionId: "version-1", timeoutMs: 60000 }, outputSchema: { type: "object" } }]);
    const shorter = { ...node, config: { ...node.config, timeoutMs: 5000 } };
    view.rerender(createElement(ScriptNodePicker, { node: shorter, disabled: false, onApply: value => applied.push(value) }));
    fireEvent.click(screen.getByRole("button", { name: "应用此脚本版本" }));
    assert.equal((applied[1] as { config: { timeoutMs: number } }).config.timeoutMs, 5000);
  } finally { globalThis.fetch = originalFetch; }
});
test("script references link to the referenced historical workflow version", async () => {
  const originalFetch = globalThis.fetch, requests: string[] = [], originalUrl = window.location.href;
  const files = exampleFiles(), definition = JSON.parse(files["workflow.json"]!), old = { id: "old-version", workflowId: "example", number: 1, definition, layout: {}, files, createdAt: 0 };
  globalThis.fetch = async url => {
    requests.push(String(url));
    if (String(url).endsWith("/references")) return Response.json({ items: [{ workflowId: "example", workflowName: "历史工作流", versionId: "old-version", version: 1, nodeId: "a", scriptVersionId: "script-version" }] });
    if (String(url).includes("/versions/")) return Response.json(old);
    return Response.json({ id: "example", name: "历史工作流", currentVersionId: "latest-version", versions: [old, { ...old, id: "latest-version", number: 2 }] });
  };
  try {
    const reference = render(createElement(ScriptReferences, { scriptId: "normalize" }));
    const link = await screen.findByRole("link", { name: /历史工作流/ });
    assert.equal(link.getAttribute("href"), "/workflows/example?versionId=old-version");
    reference.unmount();
    window.history.replaceState({}, "", "/workflows/example?versionId=old-version");
    render(createElement(WorkflowPage, { id: "example" }));
    await waitFor(() => assert.ok(requests.some(url => url.endsWith("/versions/old-version"))));
    assert.equal(requests.some(url => url.endsWith("/versions/latest-version")), false);
  } finally { globalThis.fetch = originalFetch; window.history.replaceState({}, "", originalUrl); }
});
test("script Agent proposal requires explicit confirmation and saves one revision", async () => {
  const originalFetch = globalThis.fetch, requests: unknown[] = [];
  const script = { id: "normalize", currentDraftVersionId: "draft-v1", draft: { revision: 2 } } as import("../src/web/features/ScriptPages.js").ScriptDetail;
  const turn = { id: "turn-id", status: "succeeded", scriptId: script.id, draftVersionId: "draft-v1", baseRevision: 2, appliedRevision: null as number | null, validation: { valid: true, diagnostics: [] }, proposal: { summary: "增加清洗功能", changes: [], metadata: { name: "清洗脚本" } } };
  globalThis.fetch = async (_url, options) => {
    if (options?.method === "POST") { requests.push(JSON.parse(String(options.body))); turn.appliedRevision = 3; return Response.json({ version: { revision: 3 } }); }
    return Response.json(turn);
  };
  let applied = 0;
  try {
    render(createElement(ScriptAgentPreview, { script, turnId: turn.id, disabled: false, onApplied: () => applied++, onTestInput: () => {} }));
    await screen.findByText("增加清洗功能");
    assert.equal(requests.length, 0);
    fireEvent.click(screen.getByRole("button", { name: "确认应用变更…" }));
    assert.equal(requests.length, 0);
    fireEvent.click(screen.getByRole("button", { name: "确认并保存草稿" }));
    await waitFor(() => assert.equal(requests.length, 1));
    assert.equal((requests[0] as { expectedRevision: number }).expectedRevision, 2);
    await waitFor(() => assert.equal(applied, 1));
    await screen.findByText("已应用为草稿修订 3。");
  } finally { globalThis.fetch = originalFetch; }
});
test("script Agent preview blocks stale revision application and retains readable proposal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: "turn-id", status: "succeeded", draftVersionId: "old-draft", baseRevision: 0, appliedRevision: null, proposal: { summary: "历史提案", changes: [], metadata: { name: "new" } }, validation: { valid: true, diagnostics: [] } });
  try {
    const script = { id: "normalize", currentDraftVersionId: "new-draft", draft: { revision: 1 } } as import("../src/web/features/ScriptPages.js").ScriptDetail;
    render(createElement(ScriptAgentPreview, { script, turnId: "turn-id", disabled: false, onApplied: () => assert.fail("must not apply"), onTestInput: () => {} }));
    await screen.findByText(/草稿已改变/);
    assert.equal(screen.queryByRole("button", { name: "确认应用变更…" }), null);
    assert.ok(screen.getByText("历史提案"));
  } finally { globalThis.fetch = originalFetch; }
});
test("script cleanup previews a range before the destructive request", async () => {
  const originalFetch = globalThis.fetch, requests: { url: string; body: unknown }[] = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(String(options?.body)) });
    return Response.json(String(url).endsWith("/preview") ? { count: 7, token: "preview-token" } : { deletedTests: 7, deletedArtifacts: 2 });
  };
  let cleaned = 0;
  try {
    render(createElement(ScriptCleanup, { scriptId: "normalize", onCleaned: () => cleaned++ }));
    fireEvent.click(screen.getByText("测试数据保留与清理"));
    assert.equal(requests.length, 0);
    fireEvent.click(screen.getByRole("button", { name: "预览清理范围" }));
    await screen.findByText(/将永久删除 7 条/);
    assert.equal(requests.length, 1);
    fireEvent.click(screen.getByRole("button", { name: "确认永久清理" }));
    await waitFor(() => assert.equal(cleaned, 1));
    assert.equal((requests[1]!.body as { token: string }).token, "preview-token");
    assert.equal((requests[1]!.body as { keepLatest: number }).keepLatest, 100);
  } finally { globalThis.fetch = originalFetch; }
});
test("archive confirmation stays inside the drawer and above its trigger when space permits", async () => {
  const prototype = dom.window.HTMLElement.prototype;
  const originalRect = prototype.getBoundingClientRect;
  const widthDescriptor = Object.getOwnPropertyDescriptor(prototype, "offsetWidth")!;
  const heightDescriptor = Object.getOwnPropertyDescriptor(prototype, "offsetHeight")!;
  const clientWidthDescriptor = Object.getOwnPropertyDescriptor(prototype, "clientWidth")!;
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(prototype, "clientHeight")!;
  const rect = (left: number, top: number, width: number, height: number) => new dom.window.DOMRect(left, top, width, height);
  const isPopover = (element: HTMLElement) => element.hasAttribute("data-radix-popper-content-wrapper") || element.hasAttribute("data-conversation-archive-confirm");
  prototype.getBoundingClientRect = function () {
    if (this.classList.contains("conversation-drawer")) return rect(100, 80, 310, 600);
    if (this.getAttribute("aria-label") === "归档定位测试") return rect(300, 240, 54, 24);
    if (isPopover(this)) return rect(0, 0, 260, 110);
    return originalRect.call(this);
  };
  Object.defineProperty(prototype, "offsetWidth", { configurable: true, get() { return isPopover(this) ? 260 : widthDescriptor.get!.call(this); } });
  Object.defineProperty(prototype, "offsetHeight", { configurable: true, get() { return isPopover(this) ? 110 : heightDescriptor.get!.call(this); } });
  Object.defineProperty(prototype, "clientWidth", { configurable: true, get() { return this.classList.contains("conversation-drawer") ? 310 : clientWidthDescriptor.get!.call(this); } });
  Object.defineProperty(prototype, "clientHeight", { configurable: true, get() { return this.classList.contains("conversation-drawer") ? 600 : clientHeightDescriptor.get!.call(this); } });
  try {
    render(createElement("div", { className: "conversation-drawer" }, createElement(ArchiveConversationButton, { disabled: false, label: "归档定位测试", onConfirm: () => assert.fail("positioning must not archive") })));
    fireEvent.click(screen.getByRole("button", { name: "归档定位测试" }));
    const confirmation = await screen.findByRole("dialog", { name: "确认归档此对话？" });
    await waitFor(() => {
      assert.equal(confirmation.getAttribute("data-side"), "top");
      const wrapper = confirmation.closest<HTMLElement>("[data-radix-popper-content-wrapper]")!;
      const position = wrapper.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
      assert.ok(position, wrapper.style.transform);
      const left = Number(position[1]), top = Number(position[2]);
      assert.ok(left >= 112 && left + 260 <= 398, `popover left=${left} must fit inside the drawer`);
      assert.ok(top >= 92 && top + 110 <= 232, `popover top=${top} must be above its trigger`);
    });
  } finally {
    cleanup();
    prototype.getBoundingClientRect = originalRect;
    Object.defineProperty(prototype, "offsetWidth", widthDescriptor);
    Object.defineProperty(prototype, "offsetHeight", heightDescriptor);
    Object.defineProperty(prototype, "clientWidth", clientWidthDescriptor);
    Object.defineProperty(prototype, "clientHeight", clientHeightDescriptor);
  }
});

test("script Agent starts blank and opens, continues and archives conversations through history", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let archived = false;
  globalThis.fetch = async (url, options) => {
    const path = String(url); requests.push(path);
    if (options?.method === "POST" && path.endsWith("/archive")) { archived = true; return Response.json({ id: "old-chat" }); }
    if (path.endsWith("/conversations")) return Response.json({ items: [{ id: "old-chat", draftVersionId: "draft-v1", title: "之前的脚本需求", updatedAt: 1, archived, active: false }] });
    return Response.json({ items: [], total: 0, activeCount: 0 });
  };
  try {
    const script = { id: "normalize", status: "draft", currentDraftVersionId: "draft-v1", draft: { revision: 0 } } as import("../src/web/features/ScriptPages.js").ScriptDetail;
    render(createElement(ScriptAgentPanel, { script, dirty: false, onApplied: () => {}, onTestInput: () => {} }));
    await waitFor(() => assert.ok(requests.some(path => path.includes("conversationId="))));
    assert.ok(screen.getByRole("heading", { name: "新对话" }));
    assert.equal(screen.queryByText("与 Agent 创作"), null);
    assert.ok(requests.filter(path => path.includes("conversationId=")).every(path => !path.endsWith("draft-v1")));
    assert.equal(screen.queryByText("之前的脚本需求"), null);
    const historyButton = screen.getByRole("button", { name: "历史对话" });
    historyButton.focus();
    fireEvent.click(historyButton);
    const drawer = await screen.findByRole("dialog", { name: "历史对话" });
    assert.ok(drawer.closest(".script-agent-panel"));
    fireEvent.click(screen.getByRole("button", { name: "关闭历史对话" }));
    await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "历史对话" }), null));
    await waitFor(() => assert.equal(document.activeElement, historyButton));
    fireEvent.click(historyButton);
    fireEvent.keyDown(await screen.findByRole("dialog", { name: "历史对话" }), { key: "Escape" });
    await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "历史对话" }), null));
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    assert.equal((await screen.findByRole("button", { name: "继续对话" })).getAttribute("data-variant"), "ghost");
    fireEvent.click(await screen.findByRole("button", { name: "继续对话" }));
    await waitFor(() => assert.ok(requests.some(path => path.endsWith("conversationId=old-chat"))));
    assert.equal(screen.getByRole("heading", { name: "之前的脚本需求" }).getAttribute("title"), "之前的脚本需求");
    assert.equal(screen.queryByRole("dialog", { name: "历史对话" }), null);
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    assert.equal(archived, false);
    const confirmation = await screen.findByRole("dialog", { name: "确认归档此对话？" });
    assert.ok(confirmation.hasAttribute("data-conversation-archive-confirm"));
    assert.ok(screen.getByRole("button", { name: "归档" }));
    assert.ok(screen.getByRole("dialog", { name: "历史对话" }));
    await userEvent.setup({ document: dom.window.document }).click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "确认归档此对话？" }), null));
    assert.equal(archived, false);
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    fireEvent.keyDown(await screen.findByRole("dialog", { name: "确认归档此对话？" }), { key: "Escape" });
    await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "确认归档此对话？" }), null));
    assert.ok(screen.getByRole("dialog", { name: "历史对话" }));
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => assert.equal(archived, true));
    await waitFor(() => assert.equal(screen.getByRole("button", { name: "历史对话" }).getAttribute("aria-expanded"), "false"));
    assert.ok(screen.getByRole("heading", { name: "新对话" }));
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    assert.ok(await screen.findByText(/已归档/));
    assert.equal(screen.queryByRole("button", { name: "继续对话" }), null);
  } finally { globalThis.fetch = originalFetch; }
});

test("script Agent heading uses the first submitted prompt and resets for a new conversation", async () => {
  const originalFetch = globalThis.fetch;
  const firstPrompt = "请为这个脚本增加严格的输入校验，并保留详细的错误说明和兼容性检查";
  let turn: { id: string; conversationId: string; prompt: string; status: string; baseRevision: number; appliedRevision: null } | undefined;
  localStorage.setItem("orchard-workbench-agent", JSON.stringify({ providerId: "third-provider", modelId: "test-model" }));
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path === "/api/providers") return Response.json({ items: [provider({ models: [{ id: "test-model", name: "Test", source: "configured" }] })] });
    if (options?.method === "POST" && path.endsWith("/turns")) {
      const input = JSON.parse(String(options.body));
      turn = { id: "title-turn", conversationId: input.conversationId, prompt: input.prompt, status: "failed", baseRevision: 0, appliedRevision: null };
      return Response.json(turn);
    }
    if (path.endsWith("/conversations")) return Response.json({ items: turn ? [{ id: turn.conversationId, title: firstPrompt, draftVersionId: "draft-v1", archived: false }] : [] });
    if (path.endsWith("/turns/title-turn")) return Response.json(turn);
    if (path.includes("/turns?")) return Response.json({ items: turn && path.endsWith(`conversationId=${turn.conversationId}`) ? [turn] : [], total: turn ? 1 : 0, activeCount: 0 });
    return Response.json({ items: [] });
  };
  try {
    const script = { id: "normalize", status: "draft", currentDraftVersionId: "draft-v1", draft: { revision: 0 } } as import("../src/web/features/ScriptPages.js").ScriptDetail;
    render(createElement(ScriptAgentPanel, { script, dirty: false, onApplied: () => {}, onTestInput: () => {} }));
    await screen.findByRole("combobox", { name: "模型" });
    fireEvent.change(screen.getByLabelText("描述脚本需求或修复要求"), { target: { value: firstPrompt } });
    const generate = screen.getByRole("button", { name: "发送" });
    await waitFor(() => assert.equal((generate as HTMLButtonElement).disabled, false));
    fireEvent.click(generate);
    const heading = await screen.findByRole("heading", { name: firstPrompt });
    assert.equal(heading.getAttribute("title"), firstPrompt);
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    assert.ok(screen.getByRole("heading", { name: "新对话" }));
    assert.equal((screen.getByLabelText("描述脚本需求或修复要求") as HTMLTextAreaElement).value, "");
  } finally { globalThis.fetch = originalFetch; localStorage.clear(); }
});

test("script Agent sends selected references and renders ordinary answers without change controls", async () => {
  const originalFetch = globalThis.fetch, requests: Record<string, unknown>[] = [];
  let conversationId = "";
  localStorage.setItem("orchard-workbench-agent", JSON.stringify({ providerId: "third-provider", modelId: "test-model" }));
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path === "/api/providers") return Response.json({ items: [provider({ models: [{ id: "test-model", name: "Test", source: "configured" }] })] });
    if (path.includes("/tests?")) return Response.json({ items: [{ id: "failed-test", status: "failed", createdAt: 0 }] });
    if (options?.method === "POST") {
      const input = JSON.parse(String(options.body));
      requests.push(input); conversationId = input.conversationId;
      return Response.json({ id: "answer" });
    }
    if (path.includes("/turns?")) return Response.json({
      items: conversationId ? [{ id: "answer", conversationId, prompt: "为什么失败", summary: "输入日期格式不符合预期。", status: "succeeded", hasChanges: false, hasTestInput: false, appliedRevision: null }] : [],
      total: conversationId ? 1 : 0, activeCount: 0,
    });
    return Response.json({ items: [] });
  };
  try {
    const script = { id: "normalize", status: "draft", currentDraftVersionId: "draft-v1", draft: { revision: 0 } } as import("../src/web/features/ScriptPages.js").ScriptDetail;
    render(createElement(ScriptAgentPanel, { script, dirty: false, onApplied: () => assert.fail("conversation must not apply"), onTestInput: () => {} }));
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "添加引用" }) as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole("button", { name: "添加引用" }));
    await screen.findByRole("option", { name: /failed/ });
    fireEvent.change(screen.getByLabelText("引用测试结果"), { target: { value: "failed-test" } });
    fireEvent.change(screen.getByLabelText("描述脚本需求或修复要求"), { target: { value: "为什么失败" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    assert.ok(await screen.findByText("输入日期格式不符合预期。"));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.testId, "failed-test");
    assert.equal(screen.queryByRole("button", { name: "查看变更" }), null);
    assert.equal(screen.queryByText(/提案详情/), null);
    assert.equal(screen.queryByRole("button", { name: "生成变更预览" }), null);
  } finally { globalThis.fetch = originalFetch; localStorage.clear(); }
});

test("newly completed script tests become available as Agent repair context without reloading the page", async () => {
  const originalFetch = globalThis.fetch;
  let available = false;
  globalThis.fetch = async url => {
    if (String(url).includes("/tests?")) return Response.json({ items: available ? [{ id: "failed-test", status: "failed", createdAt: 0 }] : [] });
    return Response.json({ items: [], total: 0, activeCount: 0 });
  };
  try {
    const script = { id: "normalize", status: "draft", currentDraftVersionId: "draft-v1", draft: { revision: 0 } } as import("../src/web/features/ScriptPages.js").ScriptDetail;
    const props = { script, dirty: false, onApplied: () => {}, onTestInput: () => {} };
    const view = render(createElement(ScriptAgentPanel, { ...props, testRefresh: 0 }));
    assert.equal(screen.queryByLabelText("引用测试结果"), null);
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "添加引用" }) as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole("button", { name: "添加引用" }));
    await waitFor(() => assert.ok(screen.getByLabelText("引用测试结果")));
    assert.equal(screen.queryByRole("option", { name: /failed/ }), null);
    available = true;
    view.rerender(createElement(ScriptAgentPanel, { ...props, testRefresh: 1 }));
    assert.ok(await screen.findByRole("option", { name: /failed/ }));
    fireEvent.change(screen.getByLabelText("引用测试结果"), { target: { value: "failed-test" } });
    await waitFor(() => assert.equal(screen.queryByLabelText("引用测试结果"), null));
    assert.ok(screen.getByText(/^测试引用 ·/));
    fireEvent.click(screen.getByRole("button", { name: /^移除引用：测试引用/ }));
    assert.equal(screen.queryByText(/^测试引用 ·/), null);
  } finally { globalThis.fetch = originalFetch; }
});
test("script Agent loads older conversation messages without pagination controls", async () => {
  const originalFetch = globalThis.fetch;
  const offsets: string[] = [];
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes("/turns?")) {
      const params = new URL(path, "http://localhost").searchParams;
      const offset = params.get("offset")!;
      offsets.push(offset);
      return Response.json({ items: [{ id: `turn-${offset}`, conversationId: params.get("conversationId"), prompt: offset === "0" ? "最新需求" : "较早需求", status: "failed", baseRevision: 0, appliedRevision: null }], total: 2, activeCount: 0 });
    }
    if (path.endsWith("/turns/turn-0")) return Response.json({ id: "turn-0", status: "failed", baseRevision: 0, appliedRevision: null });
    return Response.json({ items: [] });
  };
  try {
    const script = { id: "normalize", status: "draft", currentDraftVersionId: "draft-v1", draft: { revision: 0 } } as import("../src/web/features/ScriptPages.js").ScriptDetail;
    render(createElement(ScriptAgentPanel, { script, dirty: false, onApplied: () => {}, onTestInput: () => {} }));
    await waitFor(() => assert.ok(offsets.includes("1")));
    assert.ok(await screen.findByText("较早需求", { selector: "p" }));
    assert.ok(screen.getByText("最新需求"));
    assert.equal(screen.queryByRole("button", { name: "上一页" }), null);
    assert.equal(screen.queryByRole("button", { name: "下一页" }), null);
    assert.equal(screen.queryByText("2 条记录"), null);
  } finally { globalThis.fetch = originalFetch; }
});
function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return { id: "third-provider", name: "Third Agent", enabled: true, config: { executable: "/usr/local/bin/third" }, models: [], defaultModel: "", revision: 1, updatedAt: 0, configSchema: true, capabilities: { modelCatalog: true, structuredOutput: "validated", tools: false, nativeResume: false, textStream: false }, readiness: { state: "ready" }, ...overrides };
}
test("Provider picker distinguishes no enabled provider, empty model catalog and saved unavailable choice", () => {
  const view = render(createElement(ProviderPicker, { providers: [], value: {}, onChange: () => {} }));
  assert.ok(screen.getByText(/尚未启用 Provider/));
  view.rerender(createElement(ProviderPicker, { providers: [provider()], value: { providerId: "third-provider" }, onChange: () => {} }));
  assert.ok(screen.getByText(/模型目录为空/));
  view.rerender(createElement(ProviderPicker, { providers: [provider({ enabled: false })], value: { providerId: "third-provider", modelId: "saved-model" }, onChange: () => {} }));
  assert.ok(screen.getByText(/已保存选择当前不可用/));
  assert.ok(screen.getByText(/saved-model/));
});
test("model picker preserves labels and page scroll styles while opening and selecting", async () => {
  const longName = "GPT-6.1-Terra · routing group with a very long model name";
  const providers = [provider({ models: [
    { id: "long-model", name: longName, source: "configured" },
    { id: "short-model", name: "Short model", source: "configured" },
  ] })];
  function Picker() {
    const [choice, setChoice] = useState<{ providerId?: string; modelId?: string }>({ providerId: "third-provider", modelId: "long-model" });
    return createElement(ProviderPicker, { providers, value: choice, onChange: setChoice });
  }
  render(createElement(Picker));
  const trigger = screen.getByRole("combobox", { name: "模型" });
  const bodyStyle = document.body.getAttribute("style"), rootStyle = document.documentElement.getAttribute("style");
  assert.equal(trigger.getAttribute("title"), longName);
  fireEvent.keyDown(trigger, { key: "Enter" });
  const menu = await screen.findByRole("listbox");
  assert.ok(menu.closest("[data-radix-popper-content-wrapper]"));
  assert.equal(menu.getAttribute("data-align"), "start");
  assert.equal(document.body.hasAttribute("data-scroll-locked"), false);
  assert.equal(document.body.getAttribute("style"), bodyStyle);
  assert.equal(document.documentElement.getAttribute("style"), rootStyle);
  assert.ok(trigger.textContent?.includes(longName));
  assert.equal(screen.getByRole("option", { name: longName }).getAttribute("title"), longName);
  fireEvent.click(screen.getByRole("option", { name: "Short model" }));
  await waitFor(() => assert.equal(screen.queryByRole("listbox"), null));
  assert.equal(trigger.getAttribute("title"), "Short model");
  assert.ok(trigger.textContent?.includes("Short model"));
  assert.equal(document.body.hasAttribute("data-scroll-locked"), false);
  assert.equal(document.body.getAttribute("style"), bodyStyle);
});
test("model picker supports keyboard selection and Escape without locking page scrolling", async () => {
  const providers = [provider({ models: [
    { id: "first", name: "First model", source: "configured" },
    { id: "disabled", name: "Disabled model", source: "configured", enabled: false },
    { id: "last", name: "Last model", source: "configured" },
  ] })];
  function Picker() {
    const [choice, setChoice] = useState<{ providerId?: string; modelId?: string }>({ providerId: "third-provider", modelId: "first" });
    return createElement(ProviderPicker, { providers, value: choice, onChange: setChoice });
  }
  render(createElement(Picker));
  const trigger = screen.getByRole("combobox", { name: "模型" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  await screen.findByRole("listbox");
  await waitFor(() => assert.equal(document.activeElement, screen.getByRole("option", { name: "First model" })));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  await waitFor(() => assert.equal(document.activeElement, screen.getByRole("option", { name: "Last model" })));
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  await waitFor(() => assert.equal(screen.queryByRole("listbox"), null));
  assert.ok(trigger.textContent?.includes("Last model"));
  fireEvent.keyDown(trigger, { key: "Enter" });
  await screen.findByRole("listbox");
  assert.equal(document.body.hasAttribute("data-scroll-locked"), false);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("listbox"), null));
  await waitFor(() => assert.equal(document.activeElement, trigger));
});
test("conversation Provider picker hides disabled CLIs and allows replacing a saved disabled choice", async () => {
  const providers = [
    provider({ id: "enabled-cli", name: "Enabled CLI", defaultModel: "active-model", models: [{ id: "active-model", name: "Active model", source: "configured" }] }),
    provider({ id: "disabled-cli", name: "Disabled CLI", enabled: false }),
    provider({ id: "unready-cli", name: "Unready CLI", readiness: { state: "unavailable", reason: "CLI 尚未安装" } }),
  ];
  let choice = { providerId: "disabled-cli", modelId: "saved-model" };
  const onChange = (value: { providerId?: string; modelId?: string }) => { choice = { providerId: value.providerId ?? "", modelId: value.modelId ?? "" }; };
  const view = render(createElement(ProviderPicker, { providers, value: choice, enabledOnly: true, onChange }));
  assert.ok(screen.getByRole("combobox", { name: "Provider" }).textContent?.includes("选择 Provider"));
  assert.equal((screen.getByRole("combobox", { name: "模型" }) as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByText("请重新选择已启用的 Provider。"));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Provider" }), { key: "Enter" });
  assert.ok(await screen.findByRole("option", { name: "Enabled CLI" }));
  assert.equal(screen.queryByRole("option", { name: /Disabled CLI/ }), null);
  assert.equal(screen.getByRole("option", { name: "Unready CLI · 未就绪" }).getAttribute("aria-disabled"), "true");
  fireEvent.click(screen.getByRole("option", { name: "Enabled CLI" }));
  assert.deepEqual(choice, { providerId: "enabled-cli", modelId: "active-model" });
  view.rerender(createElement(ProviderPicker, { providers, value: choice, enabledOnly: true, onChange }));
  assert.equal(screen.queryByText("请重新选择已启用的 Provider。"), null);
  assert.ok(screen.getByRole("combobox", { name: "模型" }).textContent?.includes("Active model"));
  view.rerender(createElement(ProviderPicker, { providers: providers.filter(item => !item.enabled), value: {}, enabledOnly: true, onChange }));
  assert.ok(screen.getByText(/尚未启用 Provider/));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Provider" }), { key: "Enter" });
  assert.equal(screen.queryAllByRole("option").length, 0);
});
test("settings previews all three default Agent prompts read-only", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => Response.json(String(url).endsWith("/settings/agent-prompts") ? { items: [
    { id: "workflow", name: "工作流", prompt: "workflow rules", schema: { type: "object" }, contextNote: "动态工作流上下文" },
    { id: "web-bridge", name: "Web Bridge 工具", prompt: "bridge rules", schema: { type: "object" }, contextNote: "应用占位示例" },
    { id: "script", name: "脚本", prompt: "script rules", schema: { type: "object" }, contextNote: "动态脚本上下文" },
  ] } : { items: [] });
  try {
    render(createElement(SettingsPage));
    fireEvent.click(screen.getByRole("button", { name: "Agent 提示词预览" }));
    const workflow = await screen.findByLabelText("工作流默认提示词") as HTMLTextAreaElement;
    assert.equal(workflow.value, "workflow rules");
    assert.equal(workflow.readOnly, true);
    fireEvent.click(screen.getByRole("button", { name: "Web Bridge 工具" }));
    assert.equal((screen.getByLabelText("Web Bridge 工具默认提示词") as HTMLTextAreaElement).value, "bridge rules");
    fireEvent.click(screen.getByRole("button", { name: "脚本" }));
    assert.equal((screen.getByLabelText("脚本默认提示词") as HTMLTextAreaElement).value, "script rules");
    assert.equal((screen.getByLabelText("脚本输出 Schema") as HTMLTextAreaElement).readOnly, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("settings restores all categories alongside repository configuration", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.endsWith("/repository")) return Response.json({ binding: null });
    if (path.endsWith("/status") && path.includes("config-git")) return Response.json({ ahead: 0, behind: 0, diverged: false, dirtyPaths: [] });
    if (path.endsWith("/secrets/status")) return Response.json({ configured: false, generation: 0, activeKeyId: null, readOnly: false, keys: [], encryptedDictionaries: 0, missingKeyIds: [] });
    return Response.json({ items: [] });
  };
  try {
    render(createElement(SettingsPage));
    for (const name of ["常规", "Provider", "Agent 模型配置", "Agent 提示词预览", "Git 仓库配置", "加密字典密钥"]) assert.ok(screen.getByRole("button", { name }));
    assert.ok(screen.getByRole("region", { name: "外观设置" }));
    assert.ok(screen.getByRole("region", { name: "通知设置" }));
    fireEvent.click(screen.getByRole("button", { name: "Git 仓库配置" }));
    await screen.findByLabelText("仓库地址");
    assert.equal(screen.queryByLabelText("变更描述"), null);
    fireEvent.click(screen.getByRole("button", { name: "加密字典密钥" }));
    assert.ok(await screen.findByText("尚未配置密钥环"));
    cleanup();
    dom.window.history.replaceState({}, "", "/settings?section=dictionary-keys");
    render(createElement(SettingsPage));
    assert.equal(screen.getByRole("button", { name: "加密字典密钥" }).getAttribute("aria-current"), "page");
    assert.ok(await screen.findByText("尚未配置密钥环"));
    cleanup();
    dom.window.history.replaceState({}, "", "/settings?section=config-git");
    render(createElement(SettingsPage));
    assert.equal(screen.getByRole("button", { name: "Git 仓库配置" }).getAttribute("aria-current"), "page");
    assert.ok(await screen.findByLabelText("仓库地址"));
  } finally { globalThis.fetch = originalFetch; dom.window.history.replaceState({}, "", "/"); }
});

test("settings connection form preserves separately managed model state", async () => {
  const originalFetch = globalThis.fetch, requests: { url: string; body: unknown }[] = [];
  let setting = provider({ enabled: false, models: [{ id: "disabled-model", name: "Disabled", source: "configured", enabled: false }] });
  globalThis.fetch = async (url, options) => {
    if (options?.method === "PATCH") {
      const input = JSON.parse(String(options.body));
      requests.push({ url: String(url), body: input });
      setting = { ...setting, ...input };
      return Response.json(setting);
    }
    return Response.json({ items: [setting] });
  };
  try {
    render(createElement(SettingsPage));
    fireEvent.click(screen.getByRole("button", { name: "Provider" }));
    const checkbox = await screen.findByRole("checkbox", { name: "启用 Third Agent" });
    fireEvent.click(checkbox);
    await waitFor(() => assert.equal(requests.length, 1));
    assert.deepEqual(requests[0]!.body, { enabled: true });
    await waitFor(() => assert.equal((checkbox as HTMLInputElement).disabled, false));
    fireEvent.click(screen.getByRole("button", { name: "配置 Third Agent" }));
    fireEvent.change(screen.getByLabelText("CLI 可执行文件"), { target: { value: "/usr/local/bin/updated" } });
    fireEvent.click(screen.getByRole("button", { name: /保存设置/ }));
    await waitFor(() => assert.equal(requests.length, 2));
    const body = requests[1]!.body as { enabled: boolean; config: { executable: string; transport: string } };
    assert.equal(body.enabled, true); assert.equal(body.config.executable, "/usr/local/bin/updated");
    assert.equal(body.config.transport, "native");
    assert.equal(Object.hasOwn(body, "models"), false);
    assert.equal(setting.models[0]!.enabled, false);
    assert.ok(await screen.findByText("设置已保存"));
  } finally { globalThis.fetch = originalFetch; }
});

test("model configuration settings create, revise, disable and inspect named configurations", async () => {
  const originalFetch = globalThis.fetch;
  let configs: AgentModelConfigView[] = [];
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  const availableProvider = provider({ defaultModel: "test-model", models: [{ id: "test-model", name: "Test", source: "configured" }] });
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path === "/api/providers") return Response.json({ items: [availableProvider] });
    if (path.endsWith("/references")) return Response.json({ items: [{ kind: "version", id: "version-one", workflowId: "example", name: "分析流程", version: 1, current: true }], workflowCount: 1, draftCount: 0 });
    if (options?.method === "POST" || options?.method === "PATCH") {
      const body = JSON.parse(String(options.body));
      writes.push({ method: options.method, body });
      const previous = configs[0];
      const config: AgentModelConfigView = { id: "analysis-config", name: body.name, description: body.description, providerId: body.providerId, modelId: body.modelId, enabled: body.enabled, revision: (previous?.revision ?? 0) + 1, createdAt: 1, updatedAt: 2, available: body.enabled, workflowCount: 1, draftCount: 0 };
      configs = [config]; return Response.json(config);
    }
    return Response.json({ items: configs });
  };
  try {
    render(createElement(SettingsPage));
    fireEvent.click(screen.getByRole("button", { name: "Agent 模型配置" }));
    await screen.findByText("还没有 Agent 模型配置");
    fireEvent.click(screen.getAllByRole("button", { name: "新增配置" })[0]!);
    fireEvent.change(screen.getByLabelText("配置名称"), { target: { value: "xxx 分析" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Provider" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Third Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "创建配置" }));
    await screen.findByRole("button", { name: "编辑模型配置 xxx 分析" });
    assert.equal(writes[0]!.body.providerId, "third-provider");
    assert.equal(writes[0]!.body.modelId, "test-model");
    assert.ok(writes[0]!.body.requestId);
    fireEvent.click(screen.getByRole("button", { name: "编辑模型配置 xxx 分析" }));
    assert.ok(screen.getByText(/此配置被 1 个工作流/));
    fireEvent.change(screen.getByLabelText("配置名称"), { target: { value: "内容分析" } });
    fireEvent.click(screen.getByRole("button", { name: "确认修改" }));
    await screen.findByRole("button", { name: "编辑模型配置 内容分析" });
    assert.equal(writes[1]!.method, "PATCH");
    assert.equal(writes[1]!.body.expectedRevision, 1);
    fireEvent.click(screen.getByRole("button", { name: "查看 内容分析 的引用" }));
    const reference = await screen.findByRole("link", { name: /分析流程/ });
    assert.equal(reference.getAttribute("href"), "/workflows/example?versionId=version-one");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑模型配置 内容分析" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "启用此配置" }));
    fireEvent.click(screen.getByRole("button", { name: "确认修改" }));
    await screen.findByText("已禁用");
    assert.equal(writes[2]!.body.expectedRevision, 2);
    assert.equal(writes[2]!.body.enabled, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("model configuration picker supports inheritance and preserves unavailable selections without replacement", async () => {
  const available: AgentModelConfigView = { id: "analysis", name: "xxx 分析", description: "", providerId: "codex-cli", modelId: "6.1-sol", enabled: true, revision: 3, createdAt: 1, updatedAt: 2, available: true, workflowCount: 1, draftCount: 0 };
  const disabled = { ...available, id: "disabled", name: "已停用配置", enabled: false, available: false, unavailableReason: "配置已禁用" };
  let choice: string | undefined = "analysis";
  const view = render(createElement(AgentModelConfigPicker, { configs: [available, disabled], value: undefined, inherit: true, defaultId: "analysis", onChange: value => { choice = value; } }));
  assert.ok(screen.getByRole("combobox", { name: "节点 Agent 模型配置" }).textContent?.includes("继承工作流默认配置"));
  assert.ok(screen.getByText(/xxx 分析 · codex-cli · 6.1-sol · 修订 3/));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "节点 Agent 模型配置" }), { key: "Enter" });
  assert.equal(screen.queryByRole("option", { name: /已停用配置/ }), null);
  fireEvent.click(await screen.findByRole("option", { name: "xxx 分析" }));
  assert.equal(choice, "analysis");
  view.rerender(createElement(AgentModelConfigPicker, { configs: [available, disabled], value: "disabled", inherit: true, defaultId: "analysis", onChange: value => { choice = value; } }));
  assert.ok(screen.getByRole("combobox").textContent?.includes("已停用配置"));
  assert.ok(screen.getByText("配置已禁用"));
  assert.equal(choice, "analysis");
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: "继承工作流默认配置" }));
  assert.equal(choice, undefined);
});

test("workflow editor saves configuration IDs while authoring still selects a Provider", async () => {
  const originalFetch = globalThis.fetch, files = exampleFiles("model-config-editor");
  let saved: Record<string, string> | undefined;
  const config: AgentModelConfigView = { id: "new-config", name: "内容分析", description: "", providerId: "test-provider", modelId: "test-model", enabled: true, available: true, revision: 1, createdAt: 1, updatedAt: 1, workflowCount: 0, draftCount: 0 };
  const originalConfig = { ...config, id: "test-agent-config", name: "默认分析" };
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path === "/api/providers") return Response.json({ items: [] });
    if (path === "/api/agent-model-configs") return Response.json({ items: [originalConfig, config] });
    if (options?.method === "PATCH") saved = JSON.parse(String(options.body)).files;
    return Response.json({ id: "model-config-draft", revision: saved ? 1 : 0, status: "draft", validation: { valid: true, diagnostics: [] }, files: saved ?? files, messages: [], turns: [], conversations: [], currentConversation: null });
  };
  try {
    render(createElement(DraftPage, { id: "model-config-draft" }));
    const picker = await screen.findByRole("combobox", { name: "工作流默认 Agent 模型配置" });
    assert.ok(screen.getByRole("combobox", { name: "Provider" }));
    fireEvent.keyDown(picker, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "内容分析" }));
    fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));
    await waitFor(() => assert.ok(saved));
    const definition = JSON.parse(saved!["workflow.json"]!);
    assert.deepEqual(definition.defaults.agent, { agentConfigId: "new-config" });
    const effective = JSON.parse(saved!["workflow.json"]!);
    assert.equal(Object.hasOwn(effective.nodes.find((node: { id: string }) => node.id === "b").config, "providerId"), false);
    assert.equal(Object.hasOwn(effective.nodes.find((node: { id: string }) => node.id === "b").config, "modelId"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("model verification is explicit, displays results, leaves disabled models unchanged and clears stale results", { timeout: 10000 }, async () => {
  const originalFetch = globalThis.fetch, requests: string[] = [];
  const setting = provider({ models: [{ id: "remote/model", name: "Remote", source: "configured", enabled: false }] });
  let failed = false;
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    assert.equal(options?.method, "POST");
    assert.equal(options?.body, undefined);
    return Response.json({
      providerId: setting.id, modelId: "remote/model", providerRevision: setting.revision,
      checkedAt: Date.now(), durationMs: 123, status: failed ? "failed" : "available",
      ...(failed ? { error: { code: "AUTH_FAILED", message: "Please log in" } } : {}),
    });
  };
  try {
    const view = render(createElement(ModelManager, { provider: setting, onUpdated: () => assert.fail("Verification must not update settings") }));
    fireEvent.click(screen.getByRole("button", { name: "管理 Third Agent 模型" }));
    assert.equal(requests.length, 0);
    fireEvent.click(screen.getByRole("button", { name: "验证模型 remote/model" }));
    assert.ok(await screen.findByText(/可用 · 0.12 秒/));
    assert.deepEqual(requests, ["/api/providers/third-provider/models/remote%2Fmodel/verify"]);
    assert.equal((screen.getByRole("checkbox", { name: "启用模型 remote/model" }) as HTMLInputElement).checked, false);
    failed = true;
    fireEvent.click(screen.getByRole("button", { name: "验证模型 remote/model" }));
    assert.ok(await screen.findByText("Please log in"));
    view.rerender(createElement(ModelManager, { provider: { ...setting, enabled: false, revision: 2 }, onUpdated: () => {} }));
    await waitFor(() => assert.equal(Boolean(screen.queryByText("Please log in")), false));
    assert.equal((screen.getByRole("button", { name: "验证模型 remote/model" }) as HTMLButtonElement).disabled, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("model verification can be cancelled and is aborted when the dialog closes or unmounts", { timeout: 10000 }, async () => {
  const originalFetch = globalThis.fetch, signals: AbortSignal[] = [];
  const setting = provider({ models: [{ id: "test", name: "Test", source: "configured" }] });
  globalThis.fetch = async (_url, options) => {
    const signal = options!.signal!;
    signals.push(signal);
    return new Promise((_, reject) => {
      if (signal.aborted) reject(new Error("aborted"));
      else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  try {
    const view = render(createElement(ModelManager, { provider: setting, onUpdated: () => {} }));
    fireEvent.click(screen.getByRole("button", { name: "管理 Third Agent 模型" }));
    fireEvent.click(screen.getByRole("button", { name: "验证模型 test" }));
    assert.ok(await screen.findByText("正在验证…"));
    fireEvent.click(screen.getByRole("button", { name: "取消验证模型 test" }));
    assert.ok(await screen.findByText(/已取消 ·/));
    assert.equal(signals[0]!.aborted, true);
    fireEvent.click(screen.getByRole("button", { name: "验证模型 test" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => assert.equal(signals[1]!.aborted, true));
    await waitFor(() => assert.equal(Boolean(screen.queryByRole("dialog")), false));
    fireEvent.click(screen.getByRole("button", { name: "管理 Third Agent 模型" }));
    fireEvent.click(screen.getByRole("button", { name: "验证模型 test" }));
    view.unmount();
    assert.equal(signals[2]!.aborted, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("model manager lists, disables, adds, searches and confirms deletion", { timeout: 10000 }, async () => {
  const originalFetch = globalThis.fetch;
  let setting = provider({
    models: [{ id: "first", name: "First model", source: "discovered", enabled: true }],
    defaultModel: "first",
  });
  const writes: { method: string; path: string }[] = [];
  const base = "/api/providers/third-provider/models";
  globalThis.fetch = async (url, options) => {
    const path = String(url), method = options?.method ?? "GET";
    if (method === "GET") return Response.json({ items: [setting] });
    writes.push({ method, path });
    if (method === "POST" && path === base) {
      const input = JSON.parse(String(options?.body));
      setting = { ...setting, models: [...setting.models, { ...input, source: "configured" }] };
    } else if (method === "PATCH" && path.startsWith(`${base}/`)) {
      const id = decodeURIComponent(path.slice(base.length + 1)), input = JSON.parse(String(options?.body));
      setting = { ...setting, models: setting.models.map(model => model.id === id ? { ...model, ...input } : model) };
      if (!input.enabled && setting.defaultModel === id) setting = { ...setting, defaultModel: "" };
    } else if (method === "DELETE") {
      assert.equal(options?.body, undefined);
      assert.equal(new Headers(options?.headers).has("Content-Type"), false);
      const id = decodeURIComponent(path.slice(base.length + 1));
      setting = { ...setting, models: setting.models.filter(model => model.id !== id) };
    } else throw new Error(`Unexpected model request: ${method} ${path}`);
    return Response.json(setting);
  };
  try {
    function Manager() {
      const [current, setCurrent] = useState(setting);
      return createElement(ModelManager, { provider: current, onUpdated: setCurrent });
    }
    render(createElement(Manager));
    fireEvent.click(await screen.findByRole("button", { name: "管理 Third Agent 模型" }));
    assert.ok(await screen.findByRole("dialog", { name: "Third Agent 模型管理" }));
    const first = screen.getByRole("checkbox", { name: "启用模型 first" });
    assert.equal((first as HTMLInputElement).checked, true);
    fireEvent.click(first);
    await waitFor(() => assert.equal((screen.getByRole("checkbox", { name: "启用模型 first" }) as HTMLInputElement).checked, false));
    assert.ok(await screen.findByText(/原默认模型已清空/));
    fireEvent.change(screen.getByLabelText("搜索模型"), { target: { value: "not-found" } });
    assert.ok(screen.getByText("没有匹配的模型。"));
    fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "custom/new" } });
    fireEvent.change(screen.getByLabelText("显示名称（可选）"), { target: { value: "Custom new" } });
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    assert.ok(await screen.findByRole("checkbox", { name: "启用模型 custom/new" }));
    fireEvent.click(screen.getByRole("button", { name: "删除模型 custom/new" }));
    assert.equal(writes.some(write => write.method === "DELETE"), false);
    fireEvent.click(screen.getByRole("button", { name: "确认删除模型 custom/new" }));
    await waitFor(() => assert.equal(Boolean(screen.queryByRole("checkbox", { name: "启用模型 custom/new" })), false));
    assert.deepEqual(writes.at(-1), { method: "DELETE", path: `${base}/custom%2Fnew` });
  } finally { globalThis.fetch = originalFetch; }
});

test("model picker offers enabled models and marks a disabled saved choice unavailable", async () => {
  const setting = provider({ models: [
    { id: "available", name: "Available model", source: "configured", enabled: true },
    { id: "disabled", name: "Disabled model", source: "discovered", enabled: false },
  ] });
  const view = render(createElement(ProviderPicker, { providers: [setting], value: { providerId: setting.id }, onChange: () => {} }));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "模型" }), { key: "Enter" });
  assert.ok(await screen.findByRole("option", { name: "Available model" }));
  assert.equal(Boolean(screen.queryByRole("option", { name: "Disabled model" })), false);
  fireEvent.click(screen.getByRole("option", { name: "Available model" }));
  view.rerender(createElement(ProviderPicker, { providers: [setting], value: { providerId: setting.id, modelId: "disabled" }, onChange: () => {} }));
  assert.ok(screen.getByText("已保存的模型未启用或已删除，请重新选择。"));
});
test("graph projection preserves domain IDs, terminal routes, layout and selected branches", () => {
  const graph = JSON.parse(exampleFiles()["workflow.json"]!);
  const records = [{ nodeId: "route", type: "switch", status: "succeeded", route: { edgeId: "skip" } }] as NodeRun[];
  const projected = projectGraph(graph, { a: { x: 40, y: 90 } }, records);
  assert.deepEqual(projected.nodes.find(n => n.id === "a")!.position, { x: 40, y: 90 });
  assert.equal(projected.edges.find(e => e.id === "skip")!.target, "__end");
  assert.equal(projected.edges.find(e => e.id === "skip")!.style!.strokeWidth, 2.5);
  assert.equal(projected.nodes.filter(n => n.id !== "__end").length, graph.nodes.length);
  assert.equal(graph.nodes[0].position, undefined);
  assert.equal(renderableWorkflow({ nodes: [null], edges: [] }), false);
});
test("event replay ignores duplicates and preserves interrupted or skipped terminal snapshots", () => {
  const event: StreamEvent = { streamType: "run", streamId: "r", sequence: 2, type: "node.succeeded", nodeId: "a", payload: {}, createdAt: 0 };
  assert.equal(mergeEvents([event], event).length, 1);
  const nodes = [{ nodeId: "a", status: "running" }, { nodeId: "c", status: "skipped" }] as NodeRun[];
  const updated = applyEventStatus(nodes, event);
  assert.equal(updated[0]!.status, "succeeded"); assert.equal(updated[1]!.status, "skipped");
  assert.equal(applyEventStatus(updated, { ...event, type: "run.interrupted" }), updated);
});
test("draft workspace switches views and preserves the shared Agent composer", async () => {
  const originalFetch = globalThis.fetch;
  const draft = {
    id: "responsive-draft", revision: 0, status: "draft", workflowId: null, publishedVersionId: null,
    files: exampleFiles("responsive-flow"), validation: { valid: true, diagnostics: [] },
    messages: [], turns: [], conversations: [], currentConversation: null,
  };
  globalThis.fetch = async url => Response.json(String(url) === "/api/drafts/responsive-draft" ? draft : { items: [] });
  try {
    render(createElement(DraftPage, { id: draft.id }));
    const composer = await screen.findByLabelText("描述工作流需求");
    fireEvent.change(composer, { target: { value: "切换视图后保留需求" } });
    const workspace = document.querySelector(".studio-grid")!;
    const buttons = [
      { label: "流程", view: "flow" },
      { label: "节点", view: "details" },
      { label: "对话", view: "chat" },
    ];
    assert.equal(workspace.getAttribute("data-mobile-tab"), "chat");
    for (const selected of buttons) {
      fireEvent.click(screen.getByRole("button", { name: selected.label }));
      assert.equal(workspace.getAttribute("data-mobile-tab"), selected.view);
      for (const button of buttons) assert.equal(screen.getByRole("button", { name: button.label }).getAttribute("aria-pressed"), String(button.view === selected.view));
      assert.equal(screen.getByLabelText("描述工作流需求"), composer);
      assert.equal((composer as HTMLTextAreaElement).value, "切换视图后保留需求");
    }
    fireEvent.change(screen.getByLabelText("选择节点"), { target: { value: "b" } });
    assert.equal(workspace.getAttribute("data-mobile-tab"), "details");
    assert.equal(screen.getByRole("button", { name: "节点" }).getAttribute("aria-pressed"), "true");
    assert.ok(await screen.findByLabelText("节点提示词"));
  } finally { globalThis.fetch = originalFetch; }
});
test("draft UI saves manual changes before conversation, supports cancel and restores persisted messages", async () => {
  const originalFetch = globalThis.fetch;
  const files = exampleFiles("ui-example");
  let state = {
    id: "draft-ui", workflowId: null, baseVersionId: null, revision: 0, artifactPath: "", status: "draft", publishedVersionId: null,
    validation: { valid: true, diagnostics: [] as string[] }, files, messages: [] as { id: string; role: string; content: { text: string } }[], turns: [] as { id: string; status: string }[],
  };
  const requests: string[] = [];
  localStorage.setItem("orchard-workbench-agent", JSON.stringify({ providerId: "third-provider", modelId: "test-model" }));
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path === "/api/providers") return Response.json({ items: [provider({ models: [{ id: "test-model", name: "Test", source: "configured" }] })] });
    if (options?.method === "PATCH") {
      const input = JSON.parse(String(options.body)); state = { ...state, files: input.files, revision: state.revision + 1 }; requests.push("save");
    } else if (options?.method === "POST" && path.endsWith("/turns")) {
      const input = JSON.parse(String(options.body)); state = { ...state, messages: [{ id: "m", role: "user", content: { text: input.prompt } }], turns: [{ id: "turn-ui", status: "running" }] }; requests.push("turn");
    } else if (options?.method === "POST" && path.endsWith("/cancel")) { state = { ...state, turns: [{ id: "turn-ui", status: "cancelled" }] }; requests.push("cancel"); }
    return Response.json(state);
  };
  try {
    const view = render(createElement(DraftPage, { id: state.id }));
    const name = await screen.findByLabelText("工作流名称");
    await waitFor(() => assert.equal((name as HTMLInputElement).value, "检查并执行"));
    fireEvent.change(screen.getByLabelText("描述工作流需求"), { target: { value: "change flow" } });
    fireEvent.change(name, { target: { value: "Edited name" } });
    assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, true);
    fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));
    await waitFor(() => assert.ok(requests.includes("save")));
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const cancel = await screen.findByRole("button", { name: "停止生成" }); fireEvent.click(cancel);
    await waitFor(() => assert.ok(requests.includes("cancel")));
    view.unmount();
    render(createElement(DraftPage, { id: state.id }));
    await screen.findByLabelText("工作流名称");
    assert.equal(screen.queryByText("change flow"), null);
    fireEvent.change(screen.getByLabelText("选择节点"), { target: { value: "b" } });
    assert.ok(await screen.findByLabelText("节点提示词"));
  } finally { globalThis.fetch = originalFetch; localStorage.clear(); }
});
test("workflow node source preview opens from the header and preserves file selection and unsaved edits", async () => {
  const originalFetch = globalThis.fetch, files = exampleFiles("source-preview");
  let saved: Record<string, string> | undefined;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "/api/providers" || String(url) === "/api/agent-model-configs" || String(url).startsWith("/api/scripts?")) return Response.json({ items: [] });
    if (options?.method === "PATCH") saved = JSON.parse(String(options.body)).files;
    return Response.json({ id: "source-draft", status: "draft", revision: saved ? 1 : 0, files: saved ?? files, messages: [], turns: [], conversations: [], currentConversation: null, validation: { valid: true, diagnostics: [] } });
  };
  try {
    render(createElement(DraftPage, { id: "source-draft" }));
    const picker = await screen.findByLabelText("选择节点");
    const preview = screen.getByRole("button", { name: "全屏预览源码" });
    assert.equal(preview.parentElement, picker.parentElement);
    const sidebar = picker.closest("aside")!;
    assert.equal(sidebar.querySelector(".source-view"), null);
    assert.equal(sidebar.querySelector(".source-toolbar"), null);
    fireEvent.change(picker, { target: { value: "a" } });
    assert.equal(screen.queryByRole("textbox", { name: /^代码：/ }), null);
    assert.equal(sidebar.querySelector(".source-view"), null);
    await userEvent.setup({ document: dom.window.document }).click(preview);
    assert.ok(await screen.findByRole("dialog", { name: "源码全屏预览" }));
    const editor = await screen.findByRole("textbox", { name: "代码：scripts/a.ts" });
    const modified = files["scripts/a.ts"]! + "\n";
    fireEvent.change(editor, { target: { value: modified } });
    fireEvent.click(screen.getByRole("button", { name: "workflow.json" }));
    assert.ok(await screen.findByRole("textbox", { name: "代码：workflow.json" }));
    fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
    await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "源码全屏预览" }), null));
    assert.equal(document.activeElement, preview);
    assert.equal(sidebar.querySelector(".source-view"), null);
    fireEvent.click(preview);
    assert.ok(await screen.findByRole("textbox", { name: "代码：workflow.json" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
    fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));
    await waitFor(() => assert.equal(saved?.["scripts/a.ts"], modified));
    fireEvent.change(picker, { target: { value: "c" } });
    fireEvent.click(preview);
    assert.ok(await screen.findByRole("textbox", { name: "代码：scripts/c.sh" }));
  } finally { globalThis.fetch = originalFetch; }
});

test("locked workflow source preview remains available and read-only", async () => {
  const originalFetch = globalThis.fetch, files = exampleFiles("readonly-source");
  globalThis.fetch = async url => String(url) === "/api/providers" || String(url) === "/api/agent-model-configs"
    ? Response.json({ items: [] })
    : Response.json({ id: "readonly-source", status: "published", revision: 0, files, messages: [], turns: [], conversations: [], currentConversation: null, validation: { valid: true, diagnostics: [] } });
  try {
    render(createElement(DraftPage, { id: "readonly-source" }));
    const preview = await screen.findByRole("button", { name: "全屏预览源码" });
    assert.equal((preview as HTMLButtonElement).disabled, false);
    fireEvent.click(preview);
    const editor = await screen.findByRole("textbox", { name: "代码：workflow.json" });
    assert.equal((editor as HTMLTextAreaElement).readOnly, true);
    assert.ok(screen.getByText("只读 · 当前源码不可编辑"));
  } finally { globalThis.fetch = originalFetch; }
});

test("existing inline source views retain full-screen file switching and read-only mode", async () => {
  function SourceView() {
    const [path, setPath] = useState("workflow.json");
    return createElement(SourceTabs, { files: exampleFiles("source-view"), path, onPath: setPath });
  }
  render(createElement(SourceView));
  assert.equal((await screen.findByRole("textbox", { name: "代码：workflow.json" }) as HTMLTextAreaElement).readOnly, true);
  fireEvent.click(screen.getByRole("button", { name: "全屏预览源码" }));
  assert.ok(await screen.findByRole("dialog", { name: "源码全屏预览" }));
  fireEvent.click(screen.getByRole("button", { name: "scripts/c.sh" }));
  assert.ok(await screen.findByRole("textbox", { name: "代码：scripts/c.sh" }));
  fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.ok(screen.getByRole("textbox", { name: "代码：scripts/c.sh" }));
});

test("navigation supports keyboard access and settings defaults to general", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ items: [] });
  try {
    dom.window.history.replaceState({}, "", "/");
    const view = render(createElement(App));
    assert.equal(screen.getByRole("navigation", { name: "面包屑导航" }).textContent, "工作流定义");
    assert.equal(screen.queryByText("创建和编排流程，管理草稿与已发布版本。"), null);
    assert.equal(screen.getByRole("link", { name: "运行记录" }).getAttribute("href"), "/runs");
    const user = userEvent.setup({ document: dom.window.document });
    await user.tab();
    assert.equal((document.activeElement as HTMLAnchorElement).getAttribute("href"), "/");
    await user.tab();
    assert.equal(document.activeElement?.getAttribute("aria-label"), "折叠侧栏");
    await user.tab();
    assert.equal(document.activeElement?.getAttribute("aria-label"), "工作流");
    await user.tab();
    assert.equal(document.activeElement?.getAttribute("aria-current"), "page");
    dom.window.history.replaceState({}, "", "/settings");
    view.rerender(createElement(App));
    assert.equal(screen.getByRole("navigation", { name: "面包屑导航" }).textContent, "设置常规");
    assert.equal(screen.getByRole("button", { name: "常规" }).getAttribute("aria-current"), "page");
    assert.ok(screen.getByRole("region", { name: "外观设置" }));
    fireEvent.click(screen.getByRole("button", { name: "Provider" }));
    assert.equal(screen.getByRole("navigation", { name: "面包屑导航" }).textContent, "设置Provider");
    fireEvent.click(screen.getByRole("button", { name: "配置同步" }));
    assert.ok(await screen.findByRole("dialog", { name: "配置同步" }));
  } finally { globalThis.fetch = originalFetch; dom.window.history.replaceState({}, "", "/"); }
});
test("sidebar collapse persists and workflow children remain accessible", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ items: [] });
  localStorage.removeItem("orchard.sidebar.collapsed");
  try {
    dom.window.history.replaceState({}, "", "/runs");
    const view = render(createElement(App));
    assert.equal(screen.getByRole("link", { name: "运行记录" }).getAttribute("aria-current"), "page");
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    assert.equal(localStorage.getItem("orchard.sidebar.collapsed"), "true");
    assert.equal(screen.queryByRole("link", { name: "运行记录" }), null);
    fireEvent.click(screen.getByRole("button", { name: "工作流" }));
    assert.equal(screen.getByRole("link", { name: "工作流定义" }).getAttribute("href"), "/");
    fireEvent.keyDown(document, { key: "Escape" });
    assert.equal(screen.queryByRole("link", { name: "工作流定义" }), null);
    view.unmount();
    render(createElement(App));
    assert.ok(screen.getByRole("button", { name: "展开侧栏" }));
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    assert.equal(screen.getByRole("link", { name: "运行记录" }).getAttribute("aria-current"), "page");
  } finally { globalThis.fetch = originalFetch; localStorage.removeItem("orchard.sidebar.collapsed"); dom.window.history.replaceState({}, "", "/"); }
});
test("mobile menu closes with Escape and restores focus", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ items: [] });
  try {
    dom.window.history.replaceState({}, "", "/");
    render(createElement(App));
    const trigger = screen.getByRole("button", { name: "打开菜单" });
    fireEvent.click(trigger);
    assert.ok(await screen.findByRole("dialog", { name: "orchard" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
    await waitFor(() => assert.equal(document.activeElement, trigger));
  } finally { globalThis.fetch = originalFetch; dom.window.history.replaceState({}, "", "/"); }
});
test("web bridge has its own page and is removed from settings categories", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith("/extension") ? Response.json({ directory: "/tmp/extension" }) : Response.json({ items: [] });
  try {
    dom.window.history.replaceState({}, "", "/web-bridge");
    const view = render(createElement(App));
    assert.equal(screen.getByRole("navigation", { name: "面包屑导航" }).textContent, "网页桥接");
    assert.equal(screen.getByRole("link", { name: "网页桥接" }).getAttribute("aria-current"), "page");
    assert.ok(await screen.findByRole("heading", { name: "创建第一个网页应用" }));
    dom.window.history.replaceState({}, "", "/settings");
    view.rerender(createElement(App));
    assert.equal(screen.queryByRole("button", { name: /Web Bridge|网页桥接/ }), null);
    assert.equal(screen.queryByRole("region", { name: "网页桥接" }), null);
  } finally { globalThis.fetch = originalFetch; dom.window.history.replaceState({}, "", "/"); }
});
test("run filters are reflected in requests, URLs and detail return links", async () => {
  const originalFetch = globalThis.fetch, requests: string[] = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    if (String(url).includes("/runs?")) return Response.json({ items: [{ id: "run-123", workflowId: "flow-1", workflowName: "订单处理", draftId: null, versionNumber: 3, status: "succeeded", createdAt: 1 }] });
    return Response.json({ items: [{ id: "flow-1", name: "订单处理" }] });
  };
  try {
    dom.window.history.replaceState({}, "", "/runs?workflowId=flow-1");
    render(createElement(App));
    const record = await screen.findByRole("link", { name: /订单处理.*正式运行/ });
    assert.ok(record.getAttribute("href")?.includes("returnTo=%2Fruns%3FworkflowId%3Dflow-1"));
    fireEvent.change(screen.getByLabelText("筛选运行类型"), { target: { value: "formal" } });
    fireEvent.change(screen.getByLabelText("筛选运行状态"), { target: { value: "succeeded" } });
    await waitFor(() => assert.ok(requests.some(url => url.includes("workflowId=flow-1&type=formal&status=succeeded"))));
    assert.equal(dom.window.location.search, "?workflowId=flow-1&type=formal&status=succeeded");
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    assert.equal(dom.window.location.search, "");
  } finally { globalThis.fetch = originalFetch; dom.window.history.replaceState({}, "", "/"); }
});
test("Provider toggle rolls back when an immediate save fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => options?.method === "PATCH"
    ? Response.json({ message: "配置写入失败" }, { status: 500 })
    : Response.json({ items: [provider({ enabled: false })] });
  try {
    render(createElement(SettingsPage));
    fireEvent.click(screen.getByRole("button", { name: "Provider" }));
    const checkbox = await screen.findByRole("checkbox", { name: "启用 Third Agent" });
    fireEvent.click(checkbox);
    assert.ok(await screen.findByText("配置写入失败"));
    assert.equal((checkbox as HTMLInputElement).checked, false);
  } finally { globalThis.fetch = originalFetch; }
});
test("Provider model selection immediately saves only the default model", async () => {
  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];
  let setting = provider({
    models: [{ id: "first", name: "First model", source: "configured" }, { id: "second", name: "Second model", source: "configured" }],
    defaultModel: "first",
  });
  globalThis.fetch = async (_url, options) => {
    if (options?.method === "PATCH") {
      const input = JSON.parse(String(options.body));
      requests.push(input); setting = { ...setting, ...input };
      return Response.json(setting);
    }
    return Response.json({ items: [setting] });
  };
  try {
    render(createElement(SettingsPage));
    fireEvent.click(screen.getByRole("button", { name: "Provider" }));
    const select = await screen.findByRole("combobox", { name: "Third Agent 默认模型" });
    fireEvent.keyDown(select, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Second model" }));
    await waitFor(() => assert.deepEqual(requests, [{ defaultModel: "second" }]));
    assert.equal(screen.queryByLabelText("CLI 可执行文件"), null);
  } finally { globalThis.fetch = originalFetch; }
});
test("theme selection persists across remounts and system changes update the resolved theme", () => {
  const originalMatchMedia = dom.window.matchMedia;
  const listeners = new Set<() => void>();
  const media = {
    matches: false,
    addEventListener: (_type: string, callback: () => void) => listeners.add(callback),
    removeEventListener: (_type: string, callback: () => void) => listeners.delete(callback),
  };
  Object.defineProperty(dom.window, "matchMedia", { value: () => media, configurable: true });
  localStorage.removeItem(themeStorageKey);
  try {
    const view = render(createElement(ThemeProvider, { children: createElement(ThemePicker) }));
    fireEvent.change(screen.getByLabelText("外观"), { target: { value: "dark" } });
    assert.equal(document.documentElement.classList.contains("dark"), true);
    assert.equal(localStorage.getItem(themeStorageKey), "dark");
    view.unmount();
    render(createElement(ThemeProvider, { children: createElement(ThemePicker) }));
    assert.equal((screen.getByLabelText("外观") as HTMLSelectElement).value, "dark");
    fireEvent.change(screen.getByLabelText("外观"), { target: { value: "light" } });
    assert.equal(document.documentElement.classList.contains("dark"), false);
    fireEvent.change(screen.getByLabelText("外观"), { target: { value: "system" } });
    act(() => { media.matches = true; listeners.forEach(callback => callback()); });
    assert.equal(document.documentElement.dataset.theme, "dark");
    assert.equal((screen.getByLabelText("外观") as HTMLSelectElement).value, "system");
    act(() => { media.matches = false; listeners.forEach(callback => callback()); });
    assert.equal(document.documentElement.dataset.theme, "light");
  } finally {
    cleanup();
    localStorage.removeItem(themeStorageKey);
    document.documentElement.classList.remove("dark");
    Object.defineProperty(dom.window, "matchMedia", { value: originalMatchMedia, configurable: true });
  }
});
test("run UI uses its version graph and lets users inspect skipped node reasons", async () => {
  const originalFetch = globalThis.fetch, definition = JSON.parse(exampleFiles("ui-run")["workflow.json"]!);
  const snapshot = {
    id: "run-ui", workflowVersionId: "v1", status: "succeeded", activeNodeId: null, createdAt: 1,
    input: { action: "skip" }, output: { action: "skip" }, lastSequence: 20, attempts: [],
    agentBindings: [{ nodeId: "b", configId: "analysis", configRevision: 4, name: "历史分析配置", providerId: "test-provider", modelId: "frozen-model", providerRevision: 2 }],
    execution: { definition, layout: {}, artifactPath: "" },
    version: { id: "v1", workflowId: "ui-run", number: 1, definition, layout: {}, artifactPath: "", contentHash: "", createdAt: 1 },
    nodes: definition.nodes.map((node: { id: string; type: string }) => ({ id: `n-${node.id}`, runId: "run-ui", nodeId: node.id, type: node.type, status: node.id === "c" ? "skipped" : "succeeded", skipReason: node.id === "c" ? "branch_not_selected" : undefined, output: node.id === "b" ? { action: "skip" } : undefined, startedAt: 1, endedAt: 2 })),
  };
  globalThis.fetch = async () => Response.json(snapshot);
  try {
    render(createElement(RunPage, { id: "run-ui" }));
    await waitFor(() => assert.equal(screen.getByRole("tab", { name: "最终结果" }).getAttribute("aria-selected"), "true"));
    assert.ok(screen.getByRole("region", { name: "工作流最终结果" }));
    await userEvent.setup({ document: dom.window.document }).click(screen.getByRole("tab", { name: "执行详情" }));
    const picker = await screen.findByLabelText("选择节点");
    fireEvent.change(picker, { target: { value: "c" } });
    assert.ok(await screen.findByText("条件未选择此分支"));
    assert.ok(screen.getByText("v1"));
    fireEvent.change(picker, { target: { value: "b" } });
    await userEvent.setup({ document: dom.window.document }).click(screen.getByRole("tab", { name: "执行信息" }));
    assert.ok(await screen.findByText("历史分析配置 · 修订 4"));
    assert.ok(screen.getByText("test-provider · frozen-model"));
    fireEvent.change(picker, { target: { value: "__end" } });
    assert.ok(await screen.findByRole("region", { name: "工作流最终结果" }));
  } finally { globalThis.fetch = originalFetch; }
});

test("delete confirmation supports cancellation, displays busy rejection and retries without a request body", async () => {
  const originalFetch = globalThis.fetch, requests: RequestInit[] = [];
  let fail = true, deleted = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "/api/workflows/delete-me");
    requests.push(options!);
    return fail ? Response.json({ message: "工作流有排队或执行中的运行" }, { status: 409 }) : Response.json({ id: "delete-me", deleted: true });
  };
  try {
    render(createElement(DeleteWorkflowButton, { id: "delete-me", name: "待删除流程", onDeleted: () => { deleted++; } }));
    fireEvent.click(screen.getByRole("button", { name: "删除工作流 待删除流程" }));
    assert.ok(screen.getByRole("dialog"));
    assert.ok(screen.getByText(/全部历史版本、关联草稿/));
    assert.equal(requests.length, 0);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    assert.equal(screen.queryByRole("dialog"), null);
    assert.equal(requests.length, 0);
    fireEvent.click(screen.getByRole("button", { name: "删除工作流 待删除流程" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    assert.ok(await screen.findByRole("alert"));
    assert.equal(deleted, 0);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => assert.equal(deleted, 1));
    assert.equal(screen.queryByRole("dialog"), null);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.method, "DELETE");
      assert.equal(request.body, undefined);
      assert.equal(new Headers(request.headers).has("Content-Type"), false);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("workflow list deletion refreshes workflow and draft lists without placing a button inside a link", async () => {
  const originalFetch = globalThis.fetch;
  let removed = false;
  globalThis.fetch = async (url, options) => {
    if (options?.method === "DELETE") { removed = true; return Response.json({ deleted: true }); }
    if (String(url) === "/api/workflows") return Response.json({ items: removed ? [] : [{ id: "listed-workflow", name: "列表流程", createdAt: 1, updatedAt: 1 }] });
    return Response.json({ items: removed ? [] : [{ id: "listed-draft", name: "列表草稿", status: "draft", updatedAt: 1 }] });
  };
  try {
    render(createElement(WorkflowsPage));
    const remove = await screen.findByRole("button", { name: "删除工作流 列表流程" });
    assert.equal(remove.closest("a"), null);
    assert.ok(await screen.findByRole("button", { name: "删除草稿 列表草稿" }));
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    assert.ok(await screen.findByText("还没有已发布的工作流"));
    await waitFor(() => assert.equal(screen.queryByRole("button", { name: "删除草稿 列表草稿" }), null));
  } finally { globalThis.fetch = originalFetch; }
});

test("compact graph layout centers branches and puts its small end marker below saved positions", () => {
  const workflow = JSON.parse(exampleFiles("compact")["workflow.json"]!);
  workflow.nodes = workflow.nodes.slice(0, 3);
  workflow.edges = [{ id: "left", from: "a", to: "b" }, { id: "right", from: "a", to: "route" }];
  workflow.entryNodeId = "a";
  const projected = projectGraph(workflow);
  assert.deepEqual(projected.nodes.find(node => node.id === "a")!.position, { x: 0, y: 0 });
  assert.deepEqual(projected.nodes.find(node => node.id === "b")!.position, { x: -112, y: 128 });
  assert.deepEqual(projected.nodes.find(node => node.id === "route")!.position, { x: 112, y: 128 });
  const custom = projectGraph(workflow, { b: { x: 500, y: 600 } });
  assert.deepEqual(custom.nodes.find(node => node.id === "b")!.position, { x: 500, y: 600 });
  assert.deepEqual(custom.nodes.find(node => node.id === "__end")!.position, { x: 542, y: 728 });
});

test("source file list distinguishes nested file paths and updates the selected file accessibly", () => {
  const paths = ["workflow.json", "layout.json", "scripts/main.ts", "scripts/nested/main.ts", "scripts/check.sh"];
  const selected: string[] = [];
  const view = render(createElement(SourceFileList, { paths, selected: "workflow.json", onSelect: path => selected.push(path) }));
  assert.ok(screen.getByRole("navigation", { name: "源码文件列表" }));
  assert.equal(screen.getByRole("button", { name: "workflow.json" }).getAttribute("aria-current"), "page");
  fireEvent.click(screen.getByRole("button", { name: "scripts/nested/main.ts" }));
  assert.deepEqual(selected, ["scripts/nested/main.ts"]);
  view.rerender(createElement(SourceFileList, { paths, selected: selected[0]!, onSelect: path => selected.push(path) }));
  assert.equal(screen.getByRole("button", { name: "scripts/nested/main.ts" }).getAttribute("aria-current"), "page");
  assert.equal(screen.getByRole("button", { name: "scripts/main.ts" }).getAttribute("aria-current"), null);
  assert.equal(screen.getByRole("button", { name: "workflow.json" }).getAttribute("aria-current"), null);
  assert.equal(screen.getByRole("button", { name: "scripts/nested/main.ts" }).getAttribute("title"), "scripts/nested/main.ts");
});

test("workflow output configuration selects a node field and rejects references unavailable on every path", () => {
  const workflow: Workflow = JSON.parse(exampleFiles("output-config")["workflow.json"]!);
  const applied: { result: Binding; schema: Workflow["outputSchema"] }[] = [];
  render(createElement(WorkflowOutputEditor, { workflow, onApply: (result, schema) => applied.push({ result, schema }) }));
  fireEvent.change(screen.getByLabelText("字段路径（JSON Pointer）"), { target: { value: "/reason" } });
  fireEvent.change(screen.getByLabelText("最终输出 Schema"), { target: { value: '{"type":"string"}' } });
  fireEvent.click(screen.getByRole("button", { name: "应用输出配置" }));
  assert.deepEqual(applied, [{ result: { source: "node", nodeId: "b", pointer: "/reason" }, schema: { type: "string" } }]);
  fireEvent.change(screen.getByLabelText("输出节点"), { target: { value: "c" } });
  fireEvent.click(screen.getByRole("button", { name: "应用输出配置" }));
  assert.match(screen.getByRole("alert").textContent!, /并非所有路径必经/);
  assert.equal(applied.length, 1);
  fireEvent.change(screen.getByLabelText("输出节点"), { target: { value: "b" } });
  fireEvent.change(screen.getByLabelText("字段路径（JSON Pointer）"), { target: { value: "summary" } });
  fireEvent.click(screen.getByRole("button", { name: "应用输出配置" }));
  assert.match(screen.getByRole("alert").textContent!, /JSON Pointer/);
});

test("workflow output composition combines fields and rejects duplicate names and invalid schemas", () => {
  const workflow: Workflow = JSON.parse(exampleFiles("output-fields")["workflow.json"]!);
  const applied: Binding[] = [];
  render(createElement(WorkflowOutputEditor, { workflow, onApply: result => applied.push(result) }));
  fireEvent.change(screen.getByLabelText("输出方式"), { target: { value: "object" } });
  fireEvent.click(screen.getByRole("button", { name: "添加输出字段" }));
  fireEvent.click(screen.getByRole("button", { name: "添加输出字段" }));
  fireEvent.change(screen.getAllByLabelText("字段名")[0]!, { target: { value: "summary" } });
  fireEvent.change(screen.getAllByLabelText("字段名")[1]!, { target: { value: "summary" } });
  fireEvent.click(screen.getByRole("button", { name: "应用输出配置" }));
  assert.match(screen.getByRole("alert").textContent!, /不能为空或重复/);
  fireEvent.change(screen.getAllByLabelText("字段名")[1]!, { target: { value: "action" } });
  fireEvent.change(screen.getAllByLabelText("数据来源")[1]!, { target: { value: "workflow" } });
  fireEvent.change(screen.getByLabelText("来源节点"), { target: { value: "b" } });
  fireEvent.change(screen.getAllByLabelText("字段路径")[0]!, { target: { value: "/reason" } });
  fireEvent.change(screen.getAllByLabelText("字段路径")[1]!, { target: { value: "/action" } });
  fireEvent.change(screen.getByLabelText("最终输出 Schema"), { target: { value: "[]" } });
  fireEvent.click(screen.getByRole("button", { name: "应用输出配置" }));
  assert.ok(screen.getByRole("alert"));
  assert.equal(applied.length, 0);
  fireEvent.change(screen.getByLabelText("最终输出 Schema"), { target: { value: '{"type":"object"}' } });
  fireEvent.click(screen.getByRole("button", { name: "应用输出配置" }));
  assert.deepEqual(applied, [{ source: "object", properties: { summary: { source: "node", nodeId: "b", pointer: "/reason" }, action: { source: "workflow", pointer: "/action" } } }]);
});

test("advanced output bindings remain intact and published output configuration is read-only", () => {
  const workflow: Workflow = JSON.parse(exampleFiles("advanced-output")["workflow.json"]!);
  workflow.result = { source: "array", items: [{ source: "literal", value: false }, { source: "node", nodeId: "b" }] };
  workflow.outputSchema = true;
  const applied: Binding[] = [];
  const view = render(createElement(WorkflowOutputEditor, { workflow, onApply: result => applied.push(result) }));
  assert.equal((screen.getByLabelText("输出方式") as HTMLSelectElement).value, "advanced");
  fireEvent.click(screen.getByRole("button", { name: "应用输出配置" }));
  assert.deepEqual(applied, [workflow.result]);
  fireEvent.change(screen.getByLabelText("最终输出绑定 JSON"), { target: { value: "{" } });
  fireEvent.click(screen.getByRole("button", { name: "应用输出配置" }));
  assert.ok(screen.getByRole("alert"));
  assert.equal(applied.length, 1);
  view.rerender(createElement(WorkflowOutputEditor, { workflow, disabled: true }));
  assert.equal((screen.getByLabelText("输出方式") as HTMLSelectElement).disabled, true);
  assert.equal(screen.queryByRole("button", { name: "应用输出配置" }), null);
});

test("draft output configuration applies to workflow.json and saves through the existing revision API", async () => {
  const originalFetch = globalThis.fetch;
  let state = { id: "output-draft", revision: 0, status: "draft", workflowId: null, publishedVersionId: null, files: exampleFiles("output-draft-flow"), validation: { valid: true, diagnostics: [] }, messages: [], turns: [] };
  const saved: { files: Record<string, string>; expectedRevision: number }[] = [];
  globalThis.fetch = async (url, options) => {
    if (String(url) === "/api/providers") return Response.json({ items: [] });
    if (options?.method === "PATCH") {
      const body = JSON.parse(String(options.body)); saved.push(body);
      state = { ...state, files: body.files, revision: 1 };
    }
    return Response.json(state);
  };
  try {
    render(createElement(DraftPage, { id: state.id }));
    await userEvent.setup({ document: dom.window.document }).click(await screen.findByRole("tab", { name: "最终输出" }));
    fireEvent.change(screen.getByLabelText("字段路径（JSON Pointer）"), { target: { value: "/reason" } });
    fireEvent.change(screen.getByLabelText("最终输出 Schema"), { target: { value: '{"type":"string"}' } });
    fireEvent.click(screen.getByRole("button", { name: "应用输出配置" }));
    assert.equal((screen.getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled, false);
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => assert.equal(saved.length, 1));
    const definition = JSON.parse(saved[0]!.files["workflow.json"]!);
    assert.deepEqual(definition.result, { source: "node", nodeId: "b", pointer: "/reason" });
    assert.deepEqual(definition.outputSchema, { type: "string" });
    assert.equal(saved[0]!.expectedRevision, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("final results render plain text safely and distinguish JSON, false, zero and null", () => {
  const text = "<script>alert('test')</script>\n这是一段完整的最终结果。";
  const view = render(createElement(FinalResult, { runId: "text", status: "succeeded", value: text }));
  assert.ok(screen.getByRole("region", { name: "工作流最终结果" }));
  assert.equal(document.querySelector(".final-result-content")!.textContent, text);
  assert.equal(document.querySelector(".final-result-content script"), null);
  fireEvent.change(screen.getByLabelText("结果显示格式"), { target: { value: "json" } });
  assert.equal(document.querySelector(".final-result-content")!.textContent, JSON.stringify(text, null, 2));
  for (const value of [false, 0, null, { summary: "结果", items: [1, 2] }]) {
    view.rerender(createElement(FinalResult, { runId: "json", status: "succeeded", value }));
    assert.equal(document.querySelector(".final-result-content")!.textContent, JSON.stringify(value, null, 2));
  }
});

test("final result artifact content loads explicitly, reports errors and becomes available for export", async () => {
  const originalFetch = globalThis.fetch;
  let fail = true, calls = 0;
  globalThis.fetch = async url => {
    calls++; assert.equal(String(url), "/api/artifacts/result-artifact");
    return fail ? Response.json({ message: "产物读取失败" }, { status: 500 }) : Response.json({ summary: "完整结果" });
  };
  try {
    render(createElement(FinalResult, { runId: "artifact-run", status: "succeeded", value: { artifact: { id: "result-artifact", sha256: "hash", byteSize: 50000 } } }));
    assert.equal(calls, 0);
    assert.equal((screen.getByRole("button", { name: "复制" }) as HTMLButtonElement).disabled, true);
    fireEvent.click(screen.getByRole("button", { name: "加载完整结果" }));
    assert.ok(await screen.findByText("产物读取失败"));
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "加载完整结果" }));
    await waitFor(() => assert.match(document.querySelector(".final-result-content")!.textContent!, /完整结果/));
    assert.equal((screen.getByRole("button", { name: "复制" }) as HTMLButtonElement).disabled, false);
    assert.equal(screen.queryByRole("alert"), null);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("final result fullscreen exits cleanly and unfinished runs never display a successful result", async () => {
  const view = render(createElement(FinalResult, { runId: "fullscreen-result", status: "succeeded", value: "最终正文" }));
  fireEvent.click(screen.getByRole("button", { name: "全屏查看最终结果" }));
  assert.ok(screen.getByRole("dialog", { name: "工作流最终结果" }));
  fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
  assert.equal(screen.queryByRole("dialog"), null);
  view.rerender(createElement(FinalResult, { runId: "pending-result", status: "running", value: undefined }));
  assert.ok(screen.getByText(/工作流尚未完成/));
  assert.equal((screen.getByRole("button", { name: "下载" }) as HTMLButtonElement).disabled, true);
  view.rerender(createElement(FinalResult, { runId: "failed-result", status: "failed", value: undefined }));
  assert.ok(screen.getByText(/此次运行未成功完成/));
});

test("final result copies and downloads the displayed text or JSON without altering data", async () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL, click = dom.window.HTMLAnchorElement.prototype.click;
  const copied: string[] = [], blobs: Blob[] = [], downloads: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  URL.createObjectURL = object => { blobs.push(object as Blob); return "blob:final-result"; };
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  try {
    render(createElement(FinalResult, { runId: "export-run", status: "succeeded", value: "第一行\n第二行" }));
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    assert.ok(await screen.findByRole("button", { name: "已复制" }));
    assert.deepEqual(copied, ["第一行\n第二行"]);
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    assert.equal(downloads[0], "workflow-result-export-run.txt");
    assert.equal(await blobs[0]!.text(), "第一行\n第二行");
    fireEvent.change(screen.getByLabelText("结果显示格式"), { target: { value: "json" } });
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    assert.equal(downloads[1], "workflow-result-export-run.json");
    assert.equal(await blobs[1]!.text(), JSON.stringify("第一行\n第二行"));
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard");
    URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL; dom.window.HTMLAnchorElement.prototype.click = click;
  }
});

test("conversation panel lists history groups and wires resume, archive, rename and message filtering", async () => {
  const originalFetch = globalThis.fetch;
  const files = exampleFiles("conversation-draft");
  const conversations: ConversationView[] = [
    { id: "c-hist", draftId: "conversation-draft", mode: "multi", contextMode: "native", status: "idle", providerId: "third-provider", providerRevision: 1, modelId: "test-model", transport: "native", cliVersion: null, syncedRevision: null, rebuildFromId: null, createdAt: 1, updatedAt: 1, lastUsedAt: null, connectionState: "absent", title: "历史对话标题", archivedAt: null, lastUserMessage: "历史摘要", lastTurnStatus: "succeeded", activeTurnId: null },
    { id: "c-cur", draftId: "conversation-draft", mode: "multi", contextMode: "native", status: "current", providerId: "third-provider", providerRevision: 1, modelId: "test-model", transport: "native", cliVersion: null, syncedRevision: null, rebuildFromId: null, createdAt: 2, updatedAt: 2, lastUsedAt: null, connectionState: "absent", title: "当前对话标题", archivedAt: null, lastUserMessage: "当前摘要", lastTurnStatus: null, activeTurnId: null },
    { id: "c-arch", draftId: "conversation-draft", mode: "multi", contextMode: "native", status: "archived", providerId: "third-provider", providerRevision: 1, modelId: "test-model", transport: "native", cliVersion: null, syncedRevision: null, rebuildFromId: null, createdAt: 3, updatedAt: 3, lastUsedAt: null, connectionState: "absent", title: "归档对话标题", archivedAt: 3, lastUserMessage: null, lastTurnStatus: null, activeTurnId: null },
  ];
  const messages = [
    { id: "m1", draftId: "conversation-draft", turnId: null, sequence: 1, role: "user", content: { text: "当前消息内容" }, createdAt: 1, conversationId: "c-cur" },
    { id: "m2", draftId: "conversation-draft", turnId: null, sequence: 2, role: "assistant", content: { text: "历史回复内容" }, createdAt: 2, conversationId: "c-hist" },
  ];
  let state = { id: "conversation-draft", workflowId: null, baseVersionId: null, revision: 0, artifactPath: "", status: "draft", publishedVersionId: null, validation: { valid: true, diagnostics: [] }, files, turns: [] as { id: string; status: string }[], conversations, currentConversation: "c-cur" as string | null, messages };
  const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
  localStorage.setItem("orchard-workbench-agent", JSON.stringify({ providerId: "third-provider", modelId: "test-model" }));
  globalThis.fetch = async (url, options) => {
    const path = String(url), method = options?.method ?? "GET";
    if (path === "/api/providers") return Response.json({ items: [provider({ models: [{ id: "test-model", name: "Test", source: "configured" }] })] });
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      calls.push({ method: "POST", url: path, body });
      const cid = path.match("/conversations/([^/]+)/(resume|rebuild|archive|restore|rename)")?.[1] ?? null;
      if (path.endsWith("/resume")) { state = { ...state, currentConversation: cid!, conversations: state.conversations.map(c => ({ ...c, status: c.id === cid ? "current" : c.id === state.currentConversation ? "idle" : c.status })) }; }
      if (path.endsWith("/archive")) { state = { ...state, currentConversation: state.currentConversation === cid ? null : state.currentConversation, conversations: state.conversations.map(c => ({ ...c, status: c.id === cid ? "archived" : c.status, archivedAt: c.id === cid ? 9 : c.archivedAt })) }; }
      if (path.endsWith("/restore")) { state = { ...state, currentConversation: cid!, conversations: state.conversations.map(c => ({ ...c, status: c.id === cid ? "current" : c.status === "current" ? "idle" : c.status })) }; }
      if (path.endsWith("/rename")) { state = { ...state, conversations: state.conversations.map(c => ({ ...c, title: c.id === cid ? String(body.title) : c.title })) }; }
    }
    return Response.json(state);
  };
  try {
    render(createElement(DraftPage, { id: state.id }));
    await screen.findByRole("button", { name: "历史对话" });
    assert.ok(screen.getByRole("heading", { name: "新对话" }));
    assert.equal(screen.queryByText("与 Agent 创作"), null);
    assert.equal(screen.queryByText("当前消息内容"), null);
    assert.equal(screen.queryByText("历史对话标题"), null);
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    assert.ok(screen.getByRole("dialog", { name: "历史对话" }).closest(".chat-panel"));
    assert.ok(await screen.findByText("历史对话标题"));
    assert.ok(screen.getByText("当前对话标题"));
    assert.equal(screen.getByRole("button", { name: "继续对话" }).getAttribute("data-variant"), "ghost");
    assert.equal(screen.getByRole("button", { name: "继续" }).getAttribute("data-variant"), "ghost");
    fireEvent.click(screen.getByRole("button", { name: "继续对话" }));
    assert.ok(screen.getByRole("heading", { name: "当前对话标题" }));
    assert.ok(screen.getByText("当前消息内容"));
    assert.equal(screen.queryByText("历史回复内容"), null);
    // 查看历史对话：点击标题切换消息视图，再点返回当前。
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    fireEvent.click(screen.getByRole("button", { name: "历史对话标题" }));
    assert.ok(await screen.findByText("历史回复内容"));
    assert.ok(screen.getByRole("heading", { name: "历史对话标题" }));
    assert.equal(screen.queryByText("当前消息内容"), null);
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    fireEvent.click(screen.getByRole("button", { name: "历史对话标题" }));
    assert.ok(await screen.findByText("当前消息内容"));
    assert.ok(screen.getByRole("heading", { name: "当前对话标题" }));
    // 继续：POST resume 后视图切到新当前对话（c-hist），原当前 c-cur 转为历史。
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => assert.ok(calls.some(call => call.url.endsWith("/conversations/c-hist/resume"))));
    await screen.findByText("历史回复内容");
    // 改名当前对话：内联输入 + rename 请求。
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    fireEvent.click(screen.getByRole("button", { name: "重命名对话 历史对话标题" }));
    fireEvent.change(screen.getByLabelText("对话标题"), { target: { value: "改名后的标题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存标题" }));
    await waitFor(() => assert.ok(calls.some(call => call.url.endsWith("/conversations/c-hist/rename") && call.body.title === "改名后的标题")));
    await screen.findByRole("heading", { name: "改名后的标题" });
    // 归档当前：需要确认，确认后无 current、发送禁用。
    fireEvent.click(await screen.findByRole("button", { name: "归档对话 改名后的标题" }));
    await screen.findByRole("dialog", { name: "确认归档此对话？" });
    assert.equal(calls.some(call => call.url.endsWith("/conversations/c-hist/archive")), false);
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => assert.ok(calls.some(call => call.url.endsWith("/conversations/c-hist/archive"))));
    await waitFor(() => assert.ok(screen.getByText(/没有进行中的对话/)));
    assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, true);
    // 已归档分组默认折叠；展开后可恢复。
    fireEvent.click(screen.getByText((content, element) => element?.tagName === "SUMMARY" && content.startsWith("已归档")));
    fireEvent.click(screen.getAllByRole("button", { name: "恢复" })[0]!);
    await waitFor(() => assert.ok(calls.some(call => call.url.endsWith("/conversations/c-hist/restore"))));
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    assert.ok(screen.getByRole("heading", { name: "新对话" }));
  } finally { globalThis.fetch = originalFetch; localStorage.clear(); }
});

test("needs rebuild banner blocks sending and rebuild opens a fresh current conversation", async () => {
  const originalFetch = globalThis.fetch;
  const files = exampleFiles("rebuild-draft");
  const broken: ConversationView = { id: "c-broken", draftId: "rebuild-draft", mode: "multi", contextMode: "native", status: "needs_rebuild", providerId: "third-provider", providerRevision: 1, modelId: "test-model", transport: "native", cliVersion: null, syncedRevision: null, rebuildFromId: null, createdAt: 1, updatedAt: 1, lastUsedAt: null, connectionState: "broken", title: "中断对话标题", archivedAt: null, lastUserMessage: null, lastTurnStatus: "interrupted", activeTurnId: null };
  let state = { id: "rebuild-draft", workflowId: null, baseVersionId: null, revision: 0, artifactPath: "", status: "draft", publishedVersionId: null, validation: { valid: true, diagnostics: [] }, files, turns: [] as { id: string; status: string }[], conversations: [broken], currentConversation: null as string | null, messages: [] as unknown[] };
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  localStorage.setItem("orchard-workbench-agent", JSON.stringify({ providerId: "third-provider", modelId: "test-model" }));
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path === "/api/providers") return Response.json({ items: [provider({ models: [{ id: "test-model", name: "Test", source: "configured" }] })] });
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      calls.push({ url: path, body });
      if (path.endsWith("/rebuild")) {
        const fresh: ConversationView = { ...broken, id: "c-fresh", status: "current", rebuildFromId: "c-broken", title: null, connectionState: "absent" };
        state = { ...state, conversations: [broken, fresh], currentConversation: "c-fresh" };
      }
    }
    return Response.json(state);
  };
  try {
    render(createElement(DraftPage, { id: state.id }));
    assert.ok(await screen.findByText(/对话「中断对话标题」的后端上下文已中断/));
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    assert.ok(screen.getByText("需要重建"));
    assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, true);
    fireEvent.change(screen.getByLabelText("描述工作流需求"), { target: { value: "继续需求" } });
    assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, false);
    fireEvent.click(screen.getAllByRole("button", { name: "重建上下文" })[0]!);
    await waitFor(() => assert.ok(calls.some(call => call.url.endsWith("/conversations/c-broken/rebuild"))));
    await new Promise(resolve => setTimeout(resolve, 100));
    await waitFor(() => assert.equal(screen.queryByText(/对话「中断对话标题」/), null));
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, false));
  } finally { globalThis.fetch = originalFetch; localStorage.clear(); }
});
