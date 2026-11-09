import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { JSDOM } from "jsdom";
import type { JsonSchema } from "../src/domain/types.js";
import { assertSchema } from "../src/domain/validation.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/web-bridge" });
for (const key of ["window", "document", "Event", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Node", "navigator"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { BridgeParameterInputs } = await import("../src/web/features/BridgeParameterInputs.js");
afterEach(cleanup);

function Harness({ schema }: { schema: JsonSchema }) {
  const [value, setValue] = useState("{}"), [invalid, setInvalid] = useState(false);
  return createElement("div", {}, createElement(BridgeParameterInputs, { schema, value, disabled: false, onChange: setValue, onInvalidChange: setInvalid }),
    createElement("output", { "aria-label": "args" }, value), createElement("button", { disabled: invalid }, "执行"));
}

test("string input is single-line by default and only explicit x-ui enables textarea", async () => {
  render(createElement(Harness, { schema: { type: "object", required: ["id"], properties: {
    id: { type: "string", title: "编号", minLength: 1 },
    content: { type: "string", "x-ui": { widget: "textarea", rows: 7, placeholder: "正文" } },
  } } }));
  const input = screen.getByLabelText("编号 *:");
  const multiline = screen.getByLabelText("content:") as HTMLTextAreaElement;
  assert.equal(input.tagName, "INPUT");
  assert.equal(multiline.tagName, "TEXTAREA");
  assert.equal(multiline.rows, 7);
  assert.equal(screen.queryByLabelText("JSON 参数"), null);
  assert.equal((screen.getByRole("button", { name: "执行" }) as HTMLButtonElement).disabled, true);
  fireEvent.change(input, { target: { value: "p1" } });
  fireEvent.change(multiline, { target: { value: "line1\nline2" } });
  await waitFor(() => assert.deepEqual(JSON.parse(screen.getByLabelText("args").textContent!), { id: "p1", content: "line1\nline2" }));
  fireEvent.change(multiline, { target: { value: "" } });
  await waitFor(() => assert.deepEqual(JSON.parse(screen.getByLabelText("args").textContent!), { id: "p1" }));
});

test("typed controls preserve numbers, booleans and JSON while invalid edits block execution", async () => {
  render(createElement(Harness, { schema: { type: "object", properties: {
    count: { type: "integer", minimum: 1 }, active: { type: "boolean" }, mode: { type: "number", enum: [1, 2] },
    data: { type: "object", properties: { value: { type: "number" } } },
  }, additionalProperties: false } }));
  fireEvent.change(screen.getByLabelText("count:"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("active:"), { target: { value: "false" } });
  fireEvent.change(screen.getByLabelText("mode:"), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("data:"), { target: { value: '{"value":4}' } });
  await waitFor(() => assert.deepEqual(JSON.parse(screen.getByLabelText("args").textContent!), { count: 3, active: false, mode: 2, data: { value: 4 } }));
  fireEvent.change(screen.getByLabelText("data:"), { target: { value: "{" } });
  assert.equal((screen.getByRole("button", { name: "执行" }) as HTMLButtonElement).disabled, true);
  fireEvent.change(screen.getByLabelText("data:"), { target: { value: "{}" } });
  assert.equal((screen.getByRole("button", { name: "执行" }) as HTMLButtonElement).disabled, false);
  fireEvent.change(screen.getByLabelText("count:"), { target: { value: "1.5" } });
  assert.equal((screen.getByRole("button", { name: "执行" }) as HTMLButtonElement).disabled, true);
});

test("unsupported root schemas fail explicitly without restoring the legacy JSON editor", () => {
  render(createElement(Harness, { schema: { type: "object", oneOf: [{ properties: {} }] } }));
  assert.match(screen.getByRole("alert").textContent!, /暂不支持/);
  assert.equal(document.querySelector("textarea"), null);
  assert.equal((screen.getByRole("button", { name: "执行" }) as HTMLButtonElement).disabled, true);
});

test("strict schema validation accepts x-ui annotations and rejects invalid widget settings", () => {
  assert.doesNotThrow(() => assertSchema("hello", { type: "string", "x-ui": { widget: "textarea", rows: 7 } }));
  for (const schema of [
    { type: "string", "x-ui": { widget: "unknown" } },
    { type: "string", "x-ui": { widget: "textarea", rows: 1 } },
    { type: "string", "x-ui": { widget: "input", rows: 7 } },
    { type: "number", "x-ui": { widget: "textarea" } },
  ]) assert.throws(() => assertSchema(undefined, schema));
});
