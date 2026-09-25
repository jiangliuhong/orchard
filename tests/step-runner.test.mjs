import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeRegistry } from "../dist/workflow-sdk/index.js";
import { StepRunner } from "../dist/runtime/step-runner.js";

test("step runner validates node input and output at the execution boundary", async () => {
  const nodes = new NodeRegistry().register({
    type: "fixture.upper",
    version: "1",
    configSchema: { type: "object", additionalProperties: false },
    inputSchema: { type: "string" },
    outputSchema: { type: "string" },
    async execute(_context, _config, input) { return input.toUpperCase(); },
  });
  const runner = new StepRunner(nodes);
  assert.equal(await runner.execute({ runId: "r", stepId: "s", attemptId: "a" }, { type: "fixture.upper", config: {}, input: "hello" }), "HELLO");
  await assert.rejects(() => runner.execute({ runId: "r", stepId: "s2", attemptId: "a2" }, { type: "fixture.upper", config: {}, input: 3 }), /input validation failed/);
});

test("step runner rejects invalid output and late output after cancellation", async () => {
  const controller = new AbortController();
  const nodes = new NodeRegistry()
    .register({ type: "fixture.invalid", version: "1", configSchema: {}, inputSchema: {}, outputSchema: { type: "string" }, async execute() { return 3; } })
    .register({ type: "fixture.late", version: "1", configSchema: {}, inputSchema: {}, outputSchema: {}, async execute() { controller.abort(); return "late"; } });
  const runner = new StepRunner(nodes);
  const options = { runId: "r", stepId: "s", attemptId: "a", signal: controller.signal };
  await assert.rejects(runner.execute(options, { type: "fixture.invalid", config: {}, input: null }), /output validation failed/);
  await assert.rejects(runner.execute(options, { type: "fixture.late", config: {}, input: null }), { name: "AbortError" });
});

test("step runner observes cancellation before invoking a node", async () => {
  const controller = new AbortController();
  controller.abort();
  const nodes = new NodeRegistry().register({ type: "fixture.never", version: "1", configSchema: {}, inputSchema: {}, outputSchema: {}, async execute() { throw new Error("must not run"); } });
  await assert.rejects(() => new StepRunner(nodes).execute({ runId: "r", stepId: "s", attemptId: "a", signal: controller.signal }, { type: "fixture.never", config: {}, input: {} }));
});
