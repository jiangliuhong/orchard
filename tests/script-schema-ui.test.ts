import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import type { ScriptInputSources } from "../src/domain/script-test-input.js";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "getComputedStyle", "navigator"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { render, screen, fireEvent, cleanup, waitFor, within } = await import("@testing-library/react");
const { SchemaEditor } = await import("../src/web/features/SchemaEditor.js");
const { ScriptTestParameters } = await import("../src/web/features/ScriptTestParameters.js");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
function Editor({ initial = "true", readOnly = false }: { initial?: string; readOnly?: boolean }) {
  const [value, setValue] = useState(initial), [invalid, setInvalid] = useState(false), [dirty, setDirty] = useState(false);
  return createElement("div", {}, createElement(SchemaEditor, { label: "输入参数", value, disabled: readOnly, onChange: v => { setValue(v); setDirty(true); }, onDirty: () => setDirty(true), onInvalidChange: setInvalid }), createElement("output", { "data-testid": "schema" }, value), createElement("span", { "data-testid": "invalid" }, String(invalid)), createElement("span", { "data-testid": "dirty" }, String(dirty)));
}
test("field editor changes a root explicitly, adds and renames required fields, and switches modes losslessly", async () => {
  render(createElement(Editor));
  fireEvent.change(screen.getByLabelText("根 类型"), { target: { value: "object" } });
  assert.equal(screen.getByTestId("schema").textContent, "true");
  fireEvent.click(screen.getByRole("button", { name: "确认变更" }));
  fireEvent.click(screen.getByRole("button", { name: "添加字段" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "必填" }));
  const field = screen.getByRole("textbox", { name: "字段名 field1" });
  fireEvent.change(field, { target: { value: "中文/字段~" } }); fireEvent.blur(field);
  const schema = JSON.parse(screen.getByTestId("schema").textContent!);
  assert.deepEqual(schema.required, ["中文/字段~"]); assert.ok(schema.properties["中文/字段~"]);
  assert.equal(Object.hasOwn(schema, "additionalProperties"), false);
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  assert.deepEqual(JSON.parse((screen.getByLabelText("Schema JSON") as HTMLTextAreaElement).value), schema);
  fireEvent.click(screen.getByRole("button", { name: "字段编辑" }));
  assert.equal(screen.getByTestId("invalid").textContent, "false");
});
test("renaming and deleting fields keeps unique identities when names are reused", t => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args.map(String).join(" ")));
  render(createElement(Editor, { initial: '{"type":"object"}' }));
  fireEvent.click(screen.getByRole("button", { name: "添加字段" }));
  const original = screen.getByLabelText("字段名 field1");
  fireEvent.change(original, { target: { value: "foo" } }); fireEvent.blur(original);
  assert.equal(screen.getByLabelText("字段名 foo"), original);
  fireEvent.change(within(original.closest("details")!).getByLabelText("显示名称"), { target: { value: "Original" } });
  fireEvent.click(screen.getByRole("button", { name: "添加字段" }));
  const added = screen.getByLabelText("字段名 field1");
  assert.notEqual(added, original);
  fireEvent.change(within(added.closest("details")!).getByLabelText("显示名称"), { target: { value: "New" } });
  fireEvent.click(screen.getByRole("button", { name: "删除字段 foo" }));
  fireEvent.click(screen.getByRole("button", { name: "确认变更" }));
  assert.equal(screen.getByLabelText("字段名 field1"), added);
  assert.equal((added as HTMLInputElement).value, "field1");
  assert.equal((within(added.closest("details")!).getByLabelText("显示名称") as HTMLInputElement).value, "New");
  fireEvent.click(screen.getByRole("button", { name: "删除字段 field1" }));
  fireEvent.click(screen.getByRole("button", { name: "确认变更" }));
  fireEvent.click(screen.getByRole("button", { name: "添加字段" }));
  assert.notEqual(screen.getByLabelText("字段名 field1"), added);
  assert.equal((within(screen.getByLabelText("字段名 field1").closest("details")!).getByLabelText("显示名称") as HTMLInputElement).value, "");
  assert.deepEqual(JSON.parse(screen.getByTestId("schema").textContent!).properties, { field1: { type: "string" } });
  assert.equal(errors.some(error => error.includes("same key")), false);
});

test("complex Schema stays in JSON, duplicate keys block save, and display switches do not mark dirty", async () => {
  render(createElement(Editor, { initial: '{"type":"object","additionalProperties":{"type":"string"}}' }));
  assert.ok(screen.getByLabelText("Schema JSON"));
  assert.equal((screen.getByRole("button", { name: "字段编辑" }) as HTMLButtonElement).disabled, true);
  assert.equal(screen.getByTestId("dirty").textContent, "false");
  fireEvent.change(screen.getByLabelText("Schema JSON"), { target: { value: '{"type":"string","type":"number"}' } });
  await waitFor(() => assert.equal(screen.getByTestId("invalid").textContent, "true"));
  assert.match(screen.getByRole("alert").textContent!, /重复/);
});
test("read-only Schema remains inspectable but cannot be changed", () => {
  render(createElement(Editor, { initial: '{"type":"object","properties":{"a":{"type":"string"}}}', readOnly: true }));
  assert.equal(screen.getByRole("button", { name: "添加字段" }).matches(":disabled"), true);
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  assert.equal((screen.getByLabelText("Schema JSON") as HTMLTextAreaElement).disabled, true);
  assert.equal(screen.getByTestId("dirty").textContent, "false");
});
test("invalid parameter edits require explicit confirmation before switching to JSON", () => {
  function Parameters() {
    const [value, setValue] = useState("{}");
    return createElement(ScriptTestParameters, { schema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] }, value, sources: {}, disabled: false, onChange: setValue, onSources: () => {}, onInvalidChange: () => {}, resetKey: 0, missing: {} });
  }
  render(createElement(Parameters));
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "1.5" } });
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  assert.ok(screen.getByRole("dialog"));
  fireEvent.click(screen.getByRole("button", { name: "继续编辑表单" }));
  assert.equal((screen.getByRole("spinbutton") as HTMLInputElement).value, "1.5");
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  fireEvent.click(screen.getByRole("button", { name: "放弃表单编辑并切换" }));
  assert.equal((screen.getByLabelText("测试输入 JSON") as HTMLTextAreaElement).value, "{}");
});

test("parameter form remains available for union and untyped fields and is exclusive with JSON", () => {
  function Parameters() {
    const [value, setValue] = useState('{"query":"kept","optional":null,"extra":7}');
    return createElement(ScriptTestParameters, { schema: { type: "object", properties: { query: { type: "string" }, optional: { type: ["string", "null"] }, custom: { description: "Any JSON value" } } }, value, sources: {}, disabled: false, onChange: setValue, onSources: () => {}, onInvalidChange: () => {}, resetKey: 0, missing: {} });
  }
  render(createElement(Parameters));
  assert.equal((screen.getByRole("button", { name: "参数表单" }) as HTMLButtonElement).disabled, false);
  assert.ok(screen.getByRole("textbox", { name: "query:" }));
  assert.ok(screen.getByRole("textbox", { name: "optional:" }));
  assert.equal(screen.queryByLabelText("测试输入 JSON"), null);
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  assert.equal(screen.queryByRole("textbox", { name: "query:" }), null);
  assert.equal(screen.queryByRole("button", { name: "引入字典 query" }), null);
  const json = screen.getByLabelText("测试输入 JSON") as HTMLTextAreaElement;
  assert.deepEqual(JSON.parse(json.value), { query: "kept", optional: null, extra: 7 });
  fireEvent.click(screen.getByRole("button", { name: "参数表单" }));
  assert.equal(screen.queryByLabelText("测试输入 JSON"), null);
  assert.equal((screen.getByRole("textbox", { name: "query:" }) as HTMLInputElement).value, "kept");
});

test("invalid JSON does not disable the form tab or silently overwrite the buffer", () => {
  function Parameters() {
    const [value, setValue] = useState("{");
    return createElement(ScriptTestParameters, { schema: { type: "object", properties: { query: { type: "string" } } }, value, sources: {}, disabled: false, onChange: setValue, onSources: () => {}, onInvalidChange: () => {}, resetKey: 0, missing: {} });
  }
  render(createElement(Parameters));
  const tab = screen.getByRole("button", { name: "参数表单" }) as HTMLButtonElement;
  assert.equal(tab.disabled, false); fireEvent.click(tab);
  assert.match(screen.getByRole("alert").textContent!, /合法 JSON 对象/);
  assert.equal((screen.getByLabelText("测试输入 JSON") as HTMLTextAreaElement).value, "{");
});

test("dictionary-bound fields count toward object limits while manual field checks remain active", () => {
  function Parameters() {
    const [value, setValue] = useState("{}"), [invalid, setInvalid] = useState(false);
    const [sources, setSources] = useState<ScriptInputSources>({ "/token": { source: "dictionary", dictionaryId: "52b517d4-e6db-43a9-9db8-3d184cddda8e", key: "token" } });
    return createElement("div", {}, createElement(ScriptTestParameters, { schema: { type: "object", properties: { token: { type: "string" }, count: { type: "integer", minimum: 1 } }, required: ["token", "count"], minProperties: 2, maxProperties: 2, additionalProperties: true }, value, sources, disabled: false, onChange: setValue, onSources: setSources, onInvalidChange: setInvalid, resetKey: 0, missing: {} }), createElement("output", { "data-testid": "parameters-invalid" }, String(invalid)));
  }
  render(createElement(Parameters));
  assert.equal(screen.getByTestId("parameters-invalid").textContent, "true");
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "1.5" } });
  assert.equal(screen.getByTestId("parameters-invalid").textContent, "true");
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "3" } });
  assert.equal(screen.getByTestId("parameters-invalid").textContent, "false");
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  fireEvent.change(screen.getByLabelText("测试输入 JSON"), { target: { value: '{"count":3,"extra":true}' } });
  fireEvent.click(screen.getByRole("button", { name: "参数表单" }));
  assert.equal(screen.getByTestId("parameters-invalid").textContent, "true");
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  fireEvent.change(screen.getByLabelText("测试输入 JSON"), { target: { value: '{"count":3}' } });
  fireEvent.click(screen.getByRole("button", { name: "参数表单" }));
  assert.equal(screen.getByTestId("parameters-invalid").textContent, "false");
  fireEvent.click(screen.getByRole("button", { name: "清空字典 token" }));
  assert.equal(screen.getByTestId("parameters-invalid").textContent, "true");
});

test("a bound-only object satisfies minimum cardinality and cannot exceed maximum cardinality", () => {
  for (const maxProperties of [1, 0]) {
    let invalid: boolean | undefined;
    render(createElement(ScriptTestParameters, { schema: { type: "object", properties: { token: { type: "string" } }, required: ["token"], minProperties: maxProperties, maxProperties, additionalProperties: false }, value: "{}", sources: { "/token": { source: "dictionary", dictionaryId: "52b517d4-e6db-43a9-9db8-3d184cddda8e", key: "token" } }, disabled: false, onChange: () => {}, onSources: () => {}, onInvalidChange: next => { invalid = next; }, resetKey: 0, missing: {} }));
    assert.equal(invalid, maxProperties === 0);
    cleanup();
  }
});

test("test parameter dictionary picker matches bridge selection, renders references, and supports unlink", async () => {
  const id = "52b517d4-e6db-43a9-9db8-3d184cddda8e";
  globalThis.fetch = async url => String(url).includes(`/dictionaries/${id}`) ? Response.json({ id, enabled: true, readiness: "ready", keys: { token: { type: "string" }, count: { type: "number" } } }) : Response.json({ items: [{ id, name: "Credentials", kind: "encrypted", enabled: true, readiness: "ready" }], nextCursor: null });
  function Parameters() {
    const [value, setValue] = useState("{}"), [sources, setSources] = useState({});
    return createElement(ScriptTestParameters, { schema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] }, value, sources, disabled: false, onChange: setValue, onSources: setSources, onInvalidChange: () => {}, resetKey: 0, missing: {} });
  }
  render(createElement(Parameters));
  fireEvent.click(screen.getByRole("button", { name: "引入字典 token" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(await within(dialog).findByRole("button", { name: "Credentials" }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "token" }));
  assert.ok(screen.getByRole("button", { name: `{{dictionary:${id}:token}}` }));
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(screen.queryByText("参数字典引用"), null);
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  assert.ok(screen.getByLabelText("测试输入 JSON"));
  assert.equal(screen.queryByRole("button", { name: "清空字典 token" }), null);
  fireEvent.click(screen.getByRole("button", { name: "参数表单" }));
  assert.ok(screen.getByRole("button", { name: `{{dictionary:${id}:token}}` }));
  fireEvent.click(screen.getByRole("button", { name: "清空字典 token" }));
  assert.ok(screen.getByRole("button", { name: "引入字典 token" }));
});
