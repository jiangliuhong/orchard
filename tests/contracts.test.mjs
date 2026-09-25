import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRunTransition } from "../dist/core/contracts.js";
import { validateJson, createWorkflowContext } from "../dist/workflow-sdk/index.js";

test("terminal states reject late success and restart", () => {
  assertRunTransition("queued", "running");
  assertRunTransition("running", "cancel_requested");
  assertRunTransition("cancel_requested", "cancelled");
  for (const status of ["succeeded", "failed", "cancelled", "interrupted", "needs_review"]) {
    assert.throws(() => assertRunTransition(status, "running"), /Invalid run status/);
  }
  assert.throws(() => assertRunTransition("cancel_requested", "succeeded"), /Invalid run status/);
});

test("object validation rejects null, arrays and inherited required properties", () => {
  const schema = { type: "object", required: ["name"] };
  assert.notEqual(validateJson(null, schema).length, 0);
  assert.notEqual(validateJson([], schema).length, 0);
  assert.notEqual(validateJson(Object.create({ name: "inherited" }), schema).length, 0);
  assert.deepEqual(validateJson({ name: "own" }, schema), []);
});

test("cancelled context never dispatches another step", async () => {
  const controller = new AbortController();
  let called = false;
  const context = createWorkflowContext("fixture-run", controller.signal, async () => { called = true; });
  controller.abort();
  await assert.rejects(context.step.execute("next", { type: "fixture.echo", config: {}, input: null }));
  assert.equal(called, false);
});
