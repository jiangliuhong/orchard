import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { JSDOM } from "jsdom";
import type { ScriptDetail } from "../src/web/features/ScriptPages.js";
import type { ScriptVersion } from "../src/domain/types.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "getComputedStyle", "navigator"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { render, screen, fireEvent, cleanup, waitFor, within } = await import("@testing-library/react");
const { ScriptRunInspector } = await import("../src/web/features/ScriptRunInspector.js");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const script = { id: "test-script", status: "draft" } as ScriptDetail;
const version = { id: "draft", scriptId: script.id, entryFile: "main.ts", timeoutMs: 300000, outputSchema: true, sourceRef: "source", contentHash: "hash", validation: { valid: true, diagnostics: [] }, createdAt: 0, updatedAt: 0, publishedAt: null, number: 1, revision: 2, status: "draft", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } as ScriptVersion;
const oldResult = { id: "old", status: "succeeded", scriptId: script.id, draftRevision: 1, scriptVersionId: null, input: { query: "old-value" }, reusableInput: { query: "old-value" }, inputSources: {}, legacyInput: false, output: { lines: Array.from({ length: 100 }, (_, index) => `output-line-${index}`) }, stdout: "stdout-content", stderr: "stderr-content", exitCode: 0, durationMs: 25, createdAt: 1000 };
function mockApi(options: { submit?: (body: Record<string, unknown>) => Promise<Response>; result?: () => object } = {}) {
  const submissions: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/tests") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)); submissions.push(body);
      return options.submit ? options.submit(body) : Response.json({ ...oldResult, id: "new", status: "queued" });
    }
    if (path.includes("/tests?")) return Response.json({ items: [oldResult], total: 1, activeCount: 0 });
    if (path.endsWith("/tests/old")) return Response.json(oldResult);
    if (path.endsWith("/tests/new")) return Response.json(options.result?.() ?? { ...oldResult, id: "new" });
    if (path.endsWith("/references")) return Response.json({ items: [] });
    throw new Error(`Unexpected API ${path}`);
  };
  return submissions;
}
function workspace(extra: Partial<Parameters<typeof ScriptRunInspector>[0]> = {}) {
  return createElement(ScriptRunInspector, { script, version, disabled: false, externalRefresh: 0, onTestsChanged: () => {}, ...extra });
}
test("parameters and results occupy separate tabs; switching preserves input, output is primary and diagnostics are collapsed", async () => {
  mockApi(); render(workspace());
  const field = screen.getByRole("textbox", { name: /query/ });
  fireEvent.change(field, { target: { value: "keep-this-input" } });
  assert.equal(screen.queryByRole("combobox", { name: "测试历史" }), null);
  fireEvent.click(screen.getByRole("tab", { name: "运行结果" }));
  assert.equal(screen.queryByRole("textbox", { name: /query/ }), null);
  await screen.findByText("业务输出");
  assert.match(screen.getByRole("region", { name: "测试结果" }).textContent!, /output-line-99/);
  for (const name of ["输入与参数复用", "stdout", "stderr"]) assert.equal(screen.getByText(name, { selector: "summary" }).parentElement!.hasAttribute("open"), false);
  fireEvent.click(screen.getByRole("tab", { name: "运行参数" }));
  assert.equal((screen.getByRole("textbox", { name: /query/ }) as HTMLInputElement).value, "keep-this-input");
  assert.equal(screen.queryByRole("region", { name: "测试结果" }), null);
});
test("accepted submission switches to results, shows progress and continues polling across tab changes", async () => {
  let accept!: (response: Response) => void, finished = false;
  const submissions = mockApi({ submit: () => new Promise(resolve => { accept = resolve; }), result: () => ({ ...oldResult, id: "new", status: finished ? "succeeded" : "running", output: finished ? { done: true } : undefined }) });
  render(workspace());
  fireEvent.change(screen.getByRole("textbox", { name: /query/ }), { target: { value: "run-value" } });
  await waitFor(() => assert.equal((screen.getByRole("button", { name: "运行测试" }) as HTMLButtonElement).disabled, false));
  fireEvent.click(screen.getByRole("button", { name: "运行测试" }));
  assert.equal(screen.getByRole("tab", { name: "运行参数" }).getAttribute("aria-selected"), "true");
  accept(Response.json({ ...oldResult, id: "new", status: "queued" }));
  await waitFor(() => assert.equal(screen.getByRole("tab", { name: "运行结果" }).getAttribute("aria-selected"), "true"));
  await screen.findByText("脚本执行中…");
  assert.deepEqual(submissions[0]!.input, { query: "run-value" });
  assert.ok(screen.getByRole("button", { name: "取消测试" }));
  fireEvent.click(screen.getByRole("tab", { name: "运行参数" })); finished = true;
  await waitFor(() => assert.match(document.querySelector('.script-results-tab')!.textContent!, /"done": true/), { timeout: 2000 });
  assert.equal((screen.getByRole("textbox", { name: /query/ }) as HTMLInputElement).value, "run-value");
});
test("history reuse returns to parameters without executing; keyboard tab navigation covers all three tabs", async () => {
  const submissions = mockApi(); render(workspace());
  const parameters = screen.getByRole("tab", { name: "运行参数" });
  fireEvent.keyDown(parameters, { key: "ArrowRight" });
  const results = screen.getByRole("tab", { name: "运行结果" }); assert.equal(document.activeElement, results);
  await screen.findByText("业务输出");
  fireEvent.click(screen.getByText("输入与参数复用", { selector: "summary" }));
  fireEvent.click(screen.getByRole("button", { name: "载入参数并前往测试" }));
  await waitFor(() => assert.equal(parameters.getAttribute("aria-selected"), "true"));
  assert.equal((screen.getByRole("textbox", { name: /query/ }) as HTMLInputElement).value, "old-value");
  assert.equal(submissions.length, 0);
  fireEvent.keyDown(parameters, { key: "End" });
  assert.equal(document.activeElement, screen.getByRole("tab", { name: "引用" }));
  fireEvent.keyDown(screen.getByRole("tab", { name: "引用" }), { key: "Home" });
  assert.equal(document.activeElement, parameters);
});
test("rejected submission stays in parameters and keeps entered values", async () => {
  mockApi({ submit: async () => Response.json({ message: "草稿修订冲突" }, { status: 409 }) }); render(workspace());
  fireEvent.change(screen.getByRole("textbox", { name: /query/ }), { target: { value: "preserved" } });
  await waitFor(() => assert.equal((screen.getByRole("button", { name: "运行测试" }) as HTMLButtonElement).disabled, false));
  fireEvent.click(screen.getByRole("button", { name: "运行测试" }));
  await within(screen.getByRole("tabpanel", { name: "运行参数" })).findByText("草稿修订冲突");
  assert.equal(screen.getByRole("tab", { name: "运行参数" }).getAttribute("aria-selected"), "true");
  assert.equal((screen.getByRole("textbox", { name: /query/ }) as HTMLInputElement).value, "preserved");
});
