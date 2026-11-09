import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { JSDOM } from "jsdom";
import type { CredentialBindings } from "../src/web-bridge/credential-inputs.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/web-bridge" });
for (const key of ["window", "document", "Event", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Node", "navigator"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
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

test("credential panel switches sources independently and discards manual values when changing source", () => {
  render(createElement(CredentialsHarness));
  fireEvent.change(screen.getByLabelText("ak 字典 ID"), { target: { value: "dictionary-id" } });
  fireEvent.change(screen.getByLabelText("ak 字典键"), { target: { value: "access" } });
  fireEvent.change(screen.getByLabelText("sk 来源"), { target: { value: "inline" } });
  const input = screen.getByLabelText("sk 手动值") as HTMLInputElement;
  assert.equal(input.type, "password"); assert.equal(input.autocomplete, "off");
  fireEvent.change(input, { target: { value: "secret" } });
  assert.equal((screen.getByLabelText("ak 字典 ID") as HTMLInputElement).value, "dictionary-id");
  fireEvent.change(screen.getByLabelText("sk 来源"), { target: { value: "dictionary" } });
  assert.equal(screen.queryByLabelText("sk 手动值"), null);
  fireEvent.change(screen.getByLabelText("sk 来源"), { target: { value: "inline" } });
  assert.equal((screen.getByLabelText("sk 手动值") as HTMLInputElement).value, "");
});
