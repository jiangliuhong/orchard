import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { JSDOM } from "jsdom";
import type { ProviderView, NodeRun, StreamEvent } from "../src/domain/types.js";
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
    version: { id: "v1", workflowId: "ui-run", number: 1, definition, layout: {}, artifactPath: "", contentHash: "", createdAt: 1 },
    nodes: definition.nodes.map((node: { id: string; type: string }) => ({ id: `n-${node.id}`, runId: "run-ui", nodeId: node.id, type: node.type, status: node.id === "c" ? "skipped" : "succeeded", skipReason: node.id === "c" ? "branch_not_selected" : undefined, output: node.id === "b" ? { action: "skip" } : undefined, startedAt: 1, endedAt: 2 })),
  };
  globalThis.fetch = async () => Response.json(snapshot);
  try {
    render(createElement(RunPage, { id: "run-ui" }));
    const picker = await screen.findByLabelText("选择节点");
    fireEvent.change(picker, { target: { value: "c" } });
    assert.ok(await screen.findByText("条件未选择此分支"));
    assert.ok(screen.getByText("v1"));
  } finally { globalThis.fetch = originalFetch; }
});
