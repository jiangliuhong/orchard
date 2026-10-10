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

  const context = createWorkflowContext("run-1", new AbortController().signal, async (stepId) => stepId);
  assert.equal(await context.step.execute("first-step", { type: "test.node", config: {}, input: null }), "first-step");
  assert.equal(await context.step.execute("first-step", { type: "test.node", config: {}, input: null }), "first-step:1");
  assert.equal(await context.step.execute("first-step", { type: "test.node", config: {}, input: null }), "first-step:2");
});

test("workflow policies and triggers are validated", () => {
  const workflow = defineWorkflow({
    id: "scheduled-workflow",
    name: "Scheduled",
    inputSchema: {},
    outputSchema: {},
    triggers: [{ type: "cron", config: { expression: "0 * * * *" } }],
    policy: { timeoutMs: 1000, retry: { maxAttempts: 3, backoff: "exponential" } },
    async run() { return {}; },
  });
  assert.equal(workflow.policy.retry.maxAttempts, 3);
  assert.throws(() => defineWorkflow({ id: "invalid", name: "Invalid", inputSchema: {}, outputSchema: {}, triggers: [{ type: "unknown", config: {} }], async run() { return {}; } }), /Unsupported workflow trigger/);
  assert.throws(() => defineWorkflow({ id: "invalid", name: "Invalid", inputSchema: {}, outputSchema: {}, policy: { retry: { maxAttempts: 0 } }, async run() { return {}; } }), /maxAttempts/);
});

test("node registry supports extension without scheduler changes", () => {
  const registry = new NodeRegistry();
  registry.register({ type: "fixture.echo", version: "1", configSchema: {}, inputSchema: {}, outputSchema: {}, async execute(_ctx, _config, input) { return input; } });
  assert.equal(registry.get("fixture.echo").version, "1");
  assert.throws(() => registry.register({ type: "fixture.echo", version: "2", configSchema: {}, inputSchema: {}, outputSchema: {}, async execute() {} }), /already registered/);
});
