import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeRegistry, createWorkflowContext, defineWorkflow, validateJson } from "../dist/workflow-sdk/index.js";

test("workflow SDK defines a validated workflow and rejects duplicate steps", async () => {
  const workflow = defineWorkflow({
    id: "hello-world",
    name: "Hello",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false },
    outputSchema: { type: "string" },
    async run() { return "ok"; },
  });
  assert.equal(workflow.id, "hello-world");
  assert.deepEqual(validateJson({}, workflow.inputSchema), ["$.name is required"]);

  const context = createWorkflowContext("run-1", new AbortController().signal, async () => "done");
  await context.step.execute("first-step", { type: "test.node", config: {}, input: null });
  await assert.rejects(() => context.step.execute("first-step", { type: "test.node", config: {}, input: null }), /Duplicate step id/);
});

test("node registry supports extension without scheduler changes", () => {
  const registry = new NodeRegistry();
  registry.register({ type: "fixture.echo", version: "1", configSchema: {}, inputSchema: {}, outputSchema: {}, async execute(_ctx, _config, input) { return input; } });
  assert.equal(registry.get("fixture.echo").version, "1");
  assert.throws(() => registry.register({ type: "fixture.echo", version: "2", configSchema: {}, inputSchema: {}, outputSchema: {}, async execute() {} }), /already registered/);
});
