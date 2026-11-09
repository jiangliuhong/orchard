import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/dictionaries/d1" });
for (const key of ["window", "document", "Event", "CustomEvent", "HTMLElement", "HTMLInputElement", "HTMLFormElement", "DocumentFragment", "Node", "NodeFilter", "HTMLTextAreaElement", "Element", "MutationObserver", "getComputedStyle", "navigator"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { DictionaryPage } = await import("../src/web/features/DictionariesPage.js");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function mock(kind: "plain" | "encrypted", keys: Record<string, unknown>, readiness = "ready") {
  const requests: { operations: unknown[] }[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === "PATCH") { requests.push(JSON.parse(String(init.body))); return Response.json({ changed: false }); }
    if (String(url).endsWith("/versions")) return Response.json({ items: [], nextCursor: null });
    if (String(url).endsWith("/references")) return Response.json({ items: [], complete: false, note: "引用扫描尚未接入" });
    return Response.json({ id: "d1", name: "示例配置", description: "", kind, enabled: true, revision: 1, currentVersionId: "v1", versionNo: 1,
      keyCount: Object.keys(keys).length, keys, readiness, missingKeyIds: [], createdAt: 1, updatedAt: 1 });
  };
  return requests;
}

test("dictionary summary omits revision and current version numbers", async () => {
  mock("plain", {});
  render(createElement(DictionaryPage, { id: "d1" }));
  const summary = await screen.findByRole("status", { name: "字典状态" });
  assert.ok(summary.textContent?.includes("普通字典"));
  assert.ok(summary.textContent?.includes("0 个键"));
  assert.doesNotMatch(summary.textContent ?? "", /修订|当前版本|v\d+/);
});

test("desktop workspace filters keys without losing edits and protects unsaved changes", async () => {
  mock("plain", { alpha: { type: "string", value: "a" }, beta: { type: "string", value: "b" } });
  render(createElement(DictionaryPage, { id: "d1" }));
  fireEvent.change(await screen.findByLabelText("alpha 的值"), { target: { value: "edited" } });
  assert.equal((screen.getByRole("button", { name: "禁用字典" }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole("button", { name: "保存字典信息" }) as HTMLButtonElement).disabled, true);
  const unload = new dom.window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  fireEvent.change(screen.getByLabelText("搜索字典键"), { target: { value: "beta" } });
  assert.equal(screen.queryByLabelText("alpha 的值"), null);
  fireEvent.change(screen.getByLabelText("搜索字典键"), { target: { value: "missing" } });
  assert.ok(screen.getByText("没有匹配的键"));
  fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
  assert.equal((screen.getByLabelText("alpha 的值") as HTMLInputElement).value, "edited");
  fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
  assert.equal((screen.getByLabelText("alpha 的值") as HTMLInputElement).value, "a");
  assert.equal((screen.getByRole("button", { name: "禁用字典" }) as HTMLButtonElement).disabled, false);
});

test("inspector tabs support keyboard navigation, empty history and incomplete references", async () => {
  mock("plain", {});
  render(createElement(DictionaryPage, { id: "d1" }));
  await screen.findByRole("tab", { name: "字典信息" });
  fireEvent.keyDown(screen.getByRole("tab", { name: "字典信息" }), { key: "ArrowRight" });
  assert.equal(screen.getByRole("tab", { name: "修订历史" }).getAttribute("aria-selected"), "true");
  assert.ok(screen.getByText("暂无修订历史。"));
  assert.equal(screen.queryByRole("region", { name: "字典信息" }), null);
  fireEvent.click(screen.getByRole("tab", { name: "引用影响" }));
  assert.ok(screen.getByText("引用信息暂不完整"));
  assert.ok(screen.getByText("引用扫描尚未接入"));
});

test("disabling a dictionary requires confirmation", async () => {
  const requests = mock("plain", {});
  render(createElement(DictionaryPage, { id: "d1" }));
  fireEvent.click(await screen.findByRole("button", { name: "禁用字典" }));
  assert.ok(screen.getByRole("dialog", { name: "禁用“示例配置”？" }));
  assert.equal(requests.length, 0);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  assert.equal(requests.length, 0);
  fireEvent.click(screen.getByRole("button", { name: "禁用字典" }));
  fireEvent.click(screen.getByRole("button", { name: "确认禁用" }));
  await waitFor(() => assert.equal(requests.length, 1));
  assert.equal((requests[0] as unknown as { enabled: boolean }).enabled, false);
});

for (const [readiness, label] of [["authentication-failed", "认证失败"], ["keyring-unavailable", "密钥环不可用"]]) {
  test(`encrypted detail displays ${readiness} with a link to key settings`, async () => {
    mock("encrypted", { token: { type: "string", set: true, keyId: "key-12345678" } }, readiness);
    render(createElement(DictionaryPage, { id: "d1" }));
    const status = await screen.findByRole("status", { name: "字典状态" });
    assert.ok(status.textContent?.includes(label!));
    assert.equal(status.textContent?.includes("成功"), false);
    assert.equal(screen.getByRole("link", { name: "前往密钥设置 →" }).getAttribute("href"), "/settings?section=dictionary-keys");
  });
}

test("editor keeps string text unquoted and writes booleans as boolean values", async () => {
  const requests = mock("plain", { flag: { type: "boolean", value: true }, text: { type: "string", value: "hello" } });
  render(createElement(DictionaryPage, { id: "d1" }));
  const text = await screen.findByLabelText("text 的值");
  assert.equal((text as HTMLInputElement).value, "hello");
  fireEvent.change(screen.getByLabelText("flag 的值"), { target: { value: "false" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual(requests[0]!.operations, [{ op: "set", key: "flag", type: "boolean", value: false }]);
});

for (const kind of ["plain", "encrypted"] as const) {
  test(`${kind} editor saves additions, pending edits and removals together`, async () => {
    const keys = kind === "plain"
      ? { keep: { type: "string", value: "old" }, drop: { type: "string", value: "remove" } }
      : { keep: { type: "string", set: true, keyId: "key-12345678" }, drop: { type: "string", set: true, keyId: "key-12345678" } };
    const requests = mock(kind, keys);
    render(createElement(DictionaryPage, { id: "d1" }));
    await screen.findByRole("button", { name: "移除键 drop" });
    if (kind === "encrypted") fireEvent.click(screen.getByLabelText("替换键 keep"));
    fireEvent.change(screen.getByLabelText(kind === "plain" ? "keep 的值" : "替换 keep 的值"), { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "移除键 drop" }));
    fireEvent.change(screen.getByLabelText("新键名"), { target: { value: "added" } });
    fireEvent.change(screen.getByLabelText("新键的值"), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "添加并保存修改" }));
    await waitFor(() => assert.equal(requests.length, 1));
    assert.deepEqual(requests[0]!.operations, [
      { op: "set", key: "keep", type: "string", value: "edited" },
      { op: "remove", key: "drop" },
      { op: "set", key: "added", type: "string", value: "new" },
    ]);
    await waitFor(() => assert.equal((screen.getByLabelText("新键的值") as HTMLInputElement).value, ""));
  });
}

test("save modifications includes a pending new key and retains all input after a failed request", async () => {
  const requests = mock("plain", { keep: { type: "string", value: "old" } });
  const fetch = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async (url, init) => init?.method === "PATCH" && fail
    ? Response.json({ code: "CONFIG_BUSY", message: "请重试" }, { status: 409 }) : fetch(url, init);
  render(createElement(DictionaryPage, { id: "d1" }));
  await screen.findByLabelText("keep 的值");
  fireEvent.change(screen.getByLabelText("keep 的值"), { target: { value: "edited" } });
  fireEvent.change(screen.getByLabelText("新键名"), { target: { value: "added" } });
  fireEvent.change(screen.getByLabelText("新键的值"), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await screen.findByText("请重试");
  assert.equal((screen.getByLabelText("keep 的值") as HTMLInputElement).value, "edited");
  assert.equal((screen.getByLabelText("新键名") as HTMLInputElement).value, "added");
  assert.equal((screen.getByLabelText("新键的值") as HTMLInputElement).value, "new");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual(requests[0]!.operations, [
    { op: "set", key: "keep", type: "string", value: "edited" },
    { op: "set", key: "added", type: "string", value: "new" },
  ]);
});

test("adding an existing key is rejected without discarding pending edits", async () => {
  const requests = mock("plain", { keep: { type: "string", value: "old" } });
  render(createElement(DictionaryPage, { id: "d1" }));
  await screen.findByLabelText("keep 的值");
  fireEvent.change(screen.getByLabelText("keep 的值"), { target: { value: "edited" } });
  fireEvent.change(screen.getByLabelText("新键名"), { target: { value: "keep" } });
  fireEvent.change(screen.getByLabelText("新键的值"), { target: { value: "replacement" } });
  fireEvent.click(screen.getByRole("button", { name: "添加并保存修改" }));
  await screen.findByText("键名已存在，请编辑已有条目");
  assert.equal(requests.length, 0);
  assert.equal((screen.getByLabelText("keep 的值") as HTMLInputElement).value, "edited");
  assert.equal((screen.getByLabelText("新键的值") as HTMLInputElement).value, "replacement");
});

test("encrypted editor distinguishes keep from replacement with an empty string", async () => {
  const requests = mock("encrypted", { token: { type: "string", set: true, keyId: "key-12345678" } });
  render(createElement(DictionaryPage, { id: "d1" }));
  const replace = await screen.findByLabelText("替换键 token");
  assert.equal(screen.queryByLabelText("替换 token 的值"), null);
  fireEvent.click(replace);
  assert.equal((screen.getByLabelText("替换 token 的值") as HTMLInputElement).value, "");
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual(requests[0]!.operations, [{ op: "set", key: "token", type: "string", value: "" }]);
  await waitFor(() => assert.equal(screen.queryByLabelText("替换 token 的值"), null));
});
