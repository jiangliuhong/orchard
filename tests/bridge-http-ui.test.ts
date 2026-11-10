import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { JSDOM } from "jsdom";
import type { CredentialBindings } from "../src/web-bridge/credential-inputs.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/web-bridge", pretendToBeVisual: true });
for (const key of ["window", "document", "Event", "CustomEvent", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "DocumentFragment", "Node", "NodeFilter", "Element", "MutationObserver", "getComputedStyle", "navigator"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { render, screen, fireEvent, cleanup } = await import("@testing-library/react");
const { BridgeToolForm } = await import("../src/web/features/BridgeToolForm.js");
const { BridgeCredentialInputs } = await import("../src/web/features/BridgeCredentialInputs.js");
afterEach(cleanup);
const initial = JSON.stringify({ toolId: "credit", path: "/{productNo}/request", method: "POST", parameters: { type: "object" }, fields: [], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1" });
function Harness() {
  const [value, setValue] = useState(initial), [invalid, setInvalid] = useState(false);
  return createElement("div", {}, createElement(BridgeToolForm, { value, existing: true, disabled: false, onChange: setValue, onInvalidChange: setInvalid }), createElement("output", { "aria-label": "definition" }, value), createElement("button", { disabled: invalid }, "保存"));
}

test("execution JSON edits preserve mappings, block invalid JSON across fields and allow legacy reset", () => {
  render(createElement(Harness));
  const editor = screen.getByLabelText("执行配置（JSON，可选）");
  const value = { version: 1, transport: "localHttp", response: { mode: "fullJson", maxBytes: 262144 } };
  fireEvent.change(editor, { target: { value: JSON.stringify(value) } });
  assert.deepEqual(JSON.parse(screen.getByLabelText("definition").textContent!).execution, value);
  fireEvent.change(editor, { target: { value: "{" } });
  assert.equal((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled, true);
  fireEvent.change(screen.getByLabelText("返回字段（JSON 数组）"), { target: { value: '["items"]' } });
  assert.equal((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled, true);
  fireEvent.change(editor, { target: { value: "" } });
  assert.equal((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled, false);
  const result = JSON.parse(screen.getByLabelText("definition").textContent!);
  assert.equal(result.execution, undefined); assert.deepEqual(result.fields, ["items"]);
  assert.match(screen.getByText(/localHttp 不复用浏览器 Cookie/).textContent!, /勿填写真实 AK\/SK/);
});

test("JSON sections start collapsed, expand by keyboard-native summary and method options cover Fetch", () => {
  render(createElement(Harness));
  const sections = document.querySelectorAll(".bridge-json-section");
  assert.equal(sections.length, 3);
  for (const section of sections) assert.equal(section.hasAttribute("open"), false);
  fireEvent.click(sections[0].querySelector("summary")!);
  assert.equal(sections[0].hasAttribute("open"), true);
  assert.equal(screen.queryByLabelText("站点标识"), null);
  assert.equal(screen.queryByText(/留空使用旧桥接/), null);
  const select = screen.getByLabelText("请求方法") as HTMLSelectElement;
  assert.deepEqual(Array.from(select.options, option => option.value), ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
  fireEvent.change(select, { target: { value: "PATCH" } });
  assert.equal(JSON.parse(screen.getByLabelText("definition").textContent!).method, "PATCH");
});

function CredentialsHarness() {
  const [value, setValue] = useState<CredentialBindings>({});
  return createElement(BridgeCredentialInputs, {
    execution: { version: 1, transport: "browser", credentialInputs: ["ak", "sk"], preprocess: { runtime: "nodejs", code: "return request" }, response: { mode: "fullJson", maxBytes: 1000 } },
    value, disabled: false, onChange: setValue,
  });
}

test("clearing a definition reference overrides the default and busy fields stay disabled", () => {
  let latest: CredentialBindings = {};
  const execution = { version: 1 as const, transport: "browser" as const, preprocess: { runtime: "nodejs" as const, code: "return request", credentials: { ak: { dictionaryId: "default-dict", key: "access" } } }, response: { mode: "fullJson" as const, maxBytes: 1000 } };
  const view = render(createElement(BridgeCredentialInputs, { execution, value: {}, disabled: false, onChange: value => { latest = value; } }));
  assert.equal((screen.getByLabelText("ak:") as HTMLInputElement).value, "{{dictionary:default-dict:access}}");
  fireEvent.click(screen.getByRole("button", { name: "清空字典 ak" }));
  assert.deepEqual(latest, { ak: { source: "inline", value: "" } });
  view.rerender(createElement(BridgeCredentialInputs, { execution, value: latest, disabled: true, onChange: () => {} }));
  assert.equal((screen.getByLabelText("ak:") as HTMLInputElement).readOnly, false);
  assert.equal((screen.getByLabelText("ak:") as HTMLInputElement).value, "");
  assert.equal((screen.getByRole("button", { name: "引入字典 ak" }) as HTMLButtonElement).disabled, true);
});

for (const kind of ["plain", "encrypted"]) test(`${kind} credential picker inserts a read-only reference and clearing restores manual input independently`, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(new URL(String(url), "http://localhost").searchParams.has("kind"), false);
    return Response.json(String(url).includes("/dictionaries?") ? {
      items: [{ id: "d1", name: "凭据字典", kind, enabled: true, readiness: "ready" }], nextCursor: null,
    } : { kind, enabled: true, readiness: "ready", keys: { access: kind === "plain" ? { type: "string", value: "plain-access" } : { type: "string", set: true }, count: { type: "number", value: 1 } } });
  };
  try {
  render(createElement(CredentialsHarness));
  const input = screen.getByLabelText("sk:") as HTMLInputElement;
  assert.equal(input.type, "password"); assert.equal(input.autocomplete, "off");
  fireEvent.change(input, { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "引入字典 ak" }));
  fireEvent.click(await screen.findByRole("button", { name: "凭据字典" }));
  await screen.findByRole("button", { name: "access" });
  assert.equal((screen.getByRole("button", { name: /count.*仅支持字符串/ }) as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByText("plain-access"), null);
  fireEvent.click(screen.getByRole("button", { name: "access" }));
  assert.equal(screen.queryByRole("dialog"), null);
  const access = screen.getByLabelText("ak:") as HTMLInputElement;
  assert.equal(access.value, "{{dictionary:d1:access}}");
  assert.equal(access.readOnly, true);
  assert.equal(input.value, "secret");
  fireEvent.click(screen.getByRole("button", { name: "清空字典 ak" }));
  assert.equal(access.readOnly, false);
  assert.equal(access.value, "");
  fireEvent.change(access, { target: { value: "manual-access" } });
  assert.equal(access.value, "manual-access");
  } finally { globalThis.fetch = originalFetch; }
});

test("dictionary and Key searches are independent, span pages, reset on switching and remember the last dictionary", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const parsed = new URL(String(url), "http://localhost");
    if (parsed.pathname === "/api/dictionaries") return Response.json(parsed.searchParams.has("cursor")
      ? { items: [{ id: "d2", name: "生产配置", enabled: true, readiness: "ready" }, { id: "off", name: "停用配置", enabled: false, readiness: "ready" }], nextCursor: null }
      : { items: [{ id: "d1", name: "本地配置", enabled: true, readiness: "ready" }], nextCursor: "page2" });
    return Response.json({ enabled: true, readiness: "ready", keys: parsed.pathname.endsWith("d1")
      ? { ACCESS: { type: "string", value: "never-display" }, SECRET: { type: "string", value: "never-display" } }
      : { TOKEN: { type: "string", value: "never-display" } } });
  };
  try {
    render(createElement(CredentialsHarness));
    fireEvent.click(screen.getByRole("button", { name: "引入字典 ak" }));
    await screen.findByRole("button", { name: "生产配置" });
    assert.equal((screen.getByRole("button", { name: /停用配置/ }) as HTMLButtonElement).disabled, true);
    assert.equal((screen.getByLabelText("Key") as HTMLInputElement).disabled, true);
    fireEvent.change(screen.getByLabelText("字典"), { target: { value: "本地" } });
    assert.equal(screen.queryByRole("button", { name: "生产配置" }), null);
    fireEvent.click(screen.getByRole("button", { name: "本地配置" }));
    await screen.findByRole("button", { name: "ACCESS" });
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "secret" } });
    assert.equal(screen.queryByRole("button", { name: "ACCESS" }), null);
    assert.ok(screen.getByRole("button", { name: "SECRET" }));
    assert.ok(screen.getByRole("button", { name: "本地配置" }));
    fireEvent.change(screen.getByLabelText("字典"), { target: { value: "" } });
    assert.ok(screen.getByRole("button", { name: "SECRET" }));
    fireEvent.click(screen.getByRole("button", { name: "生产配置" }));
    assert.equal((screen.getByLabelText("Key") as HTMLInputElement).value, "");
    fireEvent.click(await screen.findByRole("button", { name: "TOKEN" }));
    assert.equal(screen.queryByRole("dialog"), null);
    fireEvent.click(screen.getByRole("button", { name: "引入字典 sk" }));
    await screen.findByRole("button", { name: "TOKEN" });
    assert.equal((await screen.findByRole("button", { name: "生产配置" })).getAttribute("aria-pressed"), "true");
    assert.equal(screen.queryByText("never-display"), null);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(screen.getByLabelText("ak:"), { key: "Enter" });
    await screen.findByRole("button", { name: "TOKEN" });
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "none" } });
    assert.ok(screen.getByText("没有匹配的 Key。"));
    fireEvent.change(screen.getByLabelText("字典"), { target: { value: "none" } });
    assert.ok(screen.getByText("没有匹配的字典。"));
  } finally { globalThis.fetch = originalFetch; }
});

test("dictionary loading failures can be retried and unavailable keys cannot be selected", async () => {
  const originalFetch = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async url => {
    if (fail) return Response.json({ message: "字典加载失败" }, { status: 500 });
    return Response.json(String(url).includes("/dictionaries?")
      ? { items: [{ id: "d1", name: "字典一", enabled: true, readiness: "ready" }], nextCursor: null }
      : { enabled: false, readiness: "ready", keys: { TOKEN: { type: "string", value: "hidden" } } });
  };
  try {
    render(createElement(CredentialsHarness));
    fireEvent.click(screen.getByRole("button", { name: "引入字典 ak" }));
    await screen.findByText("字典加载失败");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    fireEvent.click(await screen.findByRole("button", { name: "字典一" }));
    await screen.findByText("字典已禁用或不可用，请检查字典设置。");
    assert.equal(screen.queryByRole("button", { name: "TOKEN" }), null);
  } finally { globalThis.fetch = originalFetch; }
});
