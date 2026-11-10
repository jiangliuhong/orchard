import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "getComputedStyle", "navigator"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { DeleteScriptButton } = await import("../src/web/features/DeleteScriptButton.js");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("script deletion requires confirmation, cancellation does not send a request, pending deletion disables controls", async () => {
  let requests = 0, deleted = 0, finish!: () => void;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(String(url), "/api/scripts/test-script");
    assert.equal(options?.method, "DELETE");
    await new Promise<void>(resolve => { finish = resolve; });
    return Response.json({ deleted: true });
  };
  render(createElement(DeleteScriptButton, { id: "test-script", name: "测试脚本", onDeleted: () => { deleted++; } }));
  fireEvent.click(screen.getByRole("button", { name: "删除脚本 测试脚本" }));
  assert.ok(screen.getByRole("dialog"));
  assert.equal(requests, 0);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  assert.equal(requests, 0);
  fireEvent.click(screen.getByRole("button", { name: "删除脚本 测试脚本" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  assert.equal((screen.getByRole("button", { name: "正在删除…" }) as HTMLButtonElement).disabled, true);
  finish();
  await waitFor(() => assert.equal(deleted, 1));
  assert.equal(requests, 1);
});

test("script deletion displays server blockers and allows retry", async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ code: "SCRIPT_REFERENCED", message: "脚本仍被工作流引用" }, { status: 409 }); };
  render(createElement(DeleteScriptButton, { id: "test-script", name: "测试脚本", compact: true, onDeleted: () => assert.fail("must not delete") }));
  fireEvent.click(screen.getByRole("button", { name: "删除脚本 测试脚本" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await screen.findByText("脚本仍被工作流引用");
  assert.equal((screen.getByRole("button", { name: "确认删除" }) as HTMLButtonElement).disabled, false);
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => assert.equal(requests, 2));
});
