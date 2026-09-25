import assert from "node:assert/strict";
import { test } from "node:test";
import { Type, validateJson } from "../dist/workflow-sdk/index.js";

test("TypeBox schemas enforce nested bounds, patterns, unions and optional fields", () => {
  const schema = Type.Object({
    name: Type.String({ minLength: 2, pattern: "^[a-z]+$" }),
    count: Type.Integer({ minimum: 1, maximum: 5 }),
    mode: Type.Union([Type.Literal("read"), Type.Literal("write")]),
    tags: Type.Optional(Type.Array(Type.String(), { minItems: 1, uniqueItems: true })),
  }, { additionalProperties: false });
  assert.deepEqual(validateJson({ name: "ok", count: 2, mode: "read" }, schema), []);
  for (const patch of [{ name: "A" }, { count: 0 }, { count: 6 }, { count: 1.5 }, { mode: "other" }, { tags: [] }, { tags: ["x", "x"] }, { extra: true }]) {
    assert.ok(validateJson({ name: "ok", count: 2, mode: "read", ...patch }, schema).length);
  }
});

test("validation does not coerce, insert defaults or remove extra fields", () => {
  const value = { count: "3", extra: true };
  const before = structuredClone(value);
  const schema = Type.Object({ count: Type.Number(), label: Type.Optional(Type.String({ default: "default" })) }, { additionalProperties: false });
  assert.ok(validateJson(value, schema).length);
  assert.deepEqual(value, before);
});

test("boolean schemas, local refs, and unsupported keywords fail explicitly", () => {
  assert.deepEqual(validateJson(null, true), []);
  assert.ok(validateJson(null, false).length);
  assert.deepEqual(validateJson("ok", { definitions: { text: { type: "string" } }, $ref: "#/definitions/text" }), []);
  assert.throws(() => validateJson("anything", { type: "string", minLenght: 3 }), /unknown keyword/);
  assert.throws(() => validateJson("anything", { $async: true, type: "string" }), /Async schemas/);
});

test("unconstrained schemas still reject non-JSON and cyclic values", () => {
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date(), new Map(), { missing: undefined }, cycle, Array(1)]) {
    assert.ok(validateJson(value, {}).length);
  }
  const shared = { value: 1 };
  assert.deepEqual(validateJson({ a: shared, b: shared }, {}), []);
});
