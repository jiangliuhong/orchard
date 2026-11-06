import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { JSDOM } from "jsdom";
import type { Binding, ConversationView, ProviderView, NodeRun, StreamEvent, Workflow } from "../src/domain/types.js";
import { projectGraph, applyEventStatus, renderableWorkflow } from "../src/web/features/graph.js";
import { mergeEvents } from "../src/web/lib/api.js";
import { exampleFiles } from "./helpers.js";

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
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
const { render, screen, fireEvent, cleanup, waitFor, act } = await import("@testing-library/react");
const { ProviderPicker } = await import("../src/web/features/ProviderPicker.js");
const { SettingsPage } = await import("../src/web/features/SettingsPage.js");
const { ModelManager } = await import("../src/web/features/ModelManager.js");
const { DraftPage } = await import("../src/web/features/DraftPage.js");
const { RunPage } = await import("../src/web/features/RunPages.js");
const { DeleteWorkflowButton } = await import("../src/web/features/DeleteWorkflowButton.js");
const { WorkflowsPage } = await import("../src/web/features/WorkflowPages.js");
const { SourceFileList } = await import("../src/web/features/SourceTabs.js");
const { WorkflowOutputEditor } = await import("../src/web/features/WorkflowOutputEditor.js");
const { FinalResult } = await import("../src/web/features/FinalResult.js");
const { default: App } = await import("../src/web/App.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { ThemePicker, ThemeProvider, themeStorageKey } = await import("../src/web/lib/theme.js");
afterEach(() => cleanup());
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
    const checkbox = await screen.findByRole("checkbox", { name: "启用 Third Agent" });
    fireEvent.click(checkbox);
    await waitFor(() => assert.equal(requests.length, 1));
    assert.deepEqual(requests[0]!.body, { enabled: true });
    await waitFor(() => assert.equal((checkbox as HTMLInputElement).disabled, false));
    fireEvent.click(screen.getByRole("button", { name: "配置 Third Agent" }));
    fireEvent.change(screen.getByLabelText("CLI 可执行文件"), { target: { value: "/usr/local/bin/updated" } });
    fireEvent.click(screen.getByRole("button", { name: /保存设置/ }));
    await waitFor(() => assert.equal(requests.length, 2));
    const body = requests[1]!.body as { enabled: boolean; config: { executable: string } };
    assert.equal(body.enabled, true); assert.equal(body.config.executable, "/usr/local/bin/updated");
    assert.equal(Object.hasOwn(body, "models"), false);
    assert.equal(setting.models[0]!.enabled, false);
    assert.ok(await screen.findByText("设置已保存"));
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
    render(createElement(SettingsPage));
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
    const cancel = await screen.findByRole("button", { name: "取消生成" }); fireEvent.click(cancel);
    await waitFor(() => assert.ok(requests.includes("cancel")));
    view.unmount();
    render(createElement(DraftPage, { id: state.id }));
    assert.ok(await screen.findByText("change flow"));
    fireEvent.change(screen.getByLabelText("选择节点"), { target: { value: "b" } });
    assert.ok(await screen.findByLabelText("节点提示词"));
  } finally { globalThis.fetch = originalFetch; localStorage.clear(); }
});
test("navigation supports keyboard access and routes to Provider settings", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ items: [] });
  try {
    dom.window.history.replaceState({}, "", "/");
    const view = render(createElement(App));
    assert.ok(screen.getByRole("heading", { name: "工作流" }));
    assert.equal(screen.getByRole("link", { name: "运行记录" }).getAttribute("href"), "/runs");
    const user = userEvent.setup({ document: dom.window.document });
    await user.tab();
    assert.equal((document.activeElement as HTMLAnchorElement).getAttribute("href"), "/");
    await user.tab();
    assert.equal(document.activeElement?.getAttribute("aria-current"), "page");
    dom.window.history.replaceState({}, "", "/settings");
    view.rerender(createElement(App));
    assert.ok(await screen.findByRole("heading", { name: "设置" }));
  } finally { globalThis.fetch = originalFetch; dom.window.history.replaceState({}, "", "/"); }
});
test("Provider toggle rolls back when an immediate save fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => options?.method === "PATCH"
    ? Response.json({ message: "配置写入失败" }, { status: 500 })
    : Response.json({ items: [provider({ enabled: false })] });
  try {
    render(createElement(SettingsPage));
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
    { id: "c-hist", draftId: "conversation-draft", mode: "multi", contextMode: "reconstructed", status: "idle", providerId: "third-provider", providerRevision: 1, modelId: "test-model", transport: "legacy", cliVersion: null, syncedRevision: null, rebuildFromId: null, createdAt: 1, updatedAt: 1, lastUsedAt: null, connectionState: "absent", title: "历史对话标题", archivedAt: null, lastUserMessage: "历史摘要", lastTurnStatus: "succeeded", activeTurnId: null },
    { id: "c-cur", draftId: "conversation-draft", mode: "multi", contextMode: "reconstructed", status: "current", providerId: "third-provider", providerRevision: 1, modelId: "test-model", transport: "legacy", cliVersion: null, syncedRevision: null, rebuildFromId: null, createdAt: 2, updatedAt: 2, lastUsedAt: null, connectionState: "absent", title: "当前对话标题", archivedAt: null, lastUserMessage: "当前摘要", lastTurnStatus: null, activeTurnId: null },
    { id: "c-arch", draftId: "conversation-draft", mode: "multi", contextMode: "reconstructed", status: "archived", providerId: "third-provider", providerRevision: 1, modelId: "test-model", transport: "legacy", cliVersion: null, syncedRevision: null, rebuildFromId: null, createdAt: 3, updatedAt: 3, lastUsedAt: null, connectionState: "absent", title: "归档对话标题", archivedAt: 3, lastUserMessage: null, lastTurnStatus: null, activeTurnId: null },
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
    // 分组与条目：当前默认展示，历史分组可见；消息默认按当前对话过滤。
    assert.ok(await screen.findByText("历史对话标题"));
    assert.ok(screen.getByText("当前对话标题"));
    assert.ok(screen.getByText("当前消息内容"));
    assert.equal(screen.queryByText("历史回复内容"), null);
    // 查看历史对话：点击标题切换消息视图，再点返回当前。
    fireEvent.click(screen.getByRole("button", { name: "历史对话标题" }));
    assert.ok(await screen.findByText("历史回复内容"));
    assert.equal(screen.queryByText("当前消息内容"), null);
    fireEvent.click(screen.getByRole("button", { name: "历史对话标题" }));
    assert.ok(await screen.findByText("当前消息内容"));
    // 继续：POST resume 后视图切到新当前对话（c-hist），原当前 c-cur 转为历史。
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => assert.ok(calls.some(call => call.url.endsWith("/conversations/c-hist/resume"))));
    await screen.findByText("历史回复内容");
    // 改名当前对话：内联输入 + rename 请求。
    fireEvent.click(screen.getByRole("button", { name: "重命名对话 历史对话标题" }));
    fireEvent.change(screen.getByLabelText("对话标题"), { target: { value: "改名后的标题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存标题" }));
    await waitFor(() => assert.ok(calls.some(call => call.url.endsWith("/conversations/c-hist/rename") && call.body.title === "改名后的标题")));
    // 归档当前：需要确认，确认后无 current、发送禁用。
    fireEvent.click(await screen.findByRole("button", { name: "归档对话 改名后的标题" }));
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => assert.ok(calls.some(call => call.url.endsWith("/conversations/c-hist/archive"))));
    await waitFor(() => assert.ok(screen.getByText(/没有进行中的对话/)));
    assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, true);
    // 已归档分组默认折叠；展开后可恢复。
    fireEvent.click(screen.getByText((content, element) => element?.tagName === "SUMMARY" && content.startsWith("已归档")));
    fireEvent.click(screen.getAllByRole("button", { name: "恢复" })[0]!);
    await waitFor(() => assert.ok(calls.some(call => call.url.endsWith("/conversations/c-hist/restore"))));
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
    assert.ok(screen.getByText("需要重建"));
    assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, true);
    fireEvent.change(screen.getByLabelText("描述工作流需求"), { target: { value: "继续需求" } });
    assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, true);
    fireEvent.click(screen.getAllByRole("button", { name: "重建上下文" })[0]!);
    await waitFor(() => assert.ok(calls.some(call => call.url.endsWith("/conversations/c-broken/rebuild"))));
    await new Promise(resolve => setTimeout(resolve, 100));
    await waitFor(() => assert.equal(screen.queryByText(/对话「中断对话标题」/), null));
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, false));
  } finally { globalThis.fetch = originalFetch; localStorage.clear(); }
});
