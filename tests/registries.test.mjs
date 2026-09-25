import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolRegistry, TriggerRegistry } from "../dist/workflow-sdk/index.js";

const tool = { type: "fixture.echo", version: "1", sideEffects: "read_only", inputSchema: {}, outputSchema: {}, async execute(_context, input) { return input; } };
const trigger = { type: "fixture.echo", configSchema: {}, async start() { return { async stop() {} }; } };

test("tool and trigger registries are independent and reject duplicates/unknown ids", async () => {
  const tools = new ToolRegistry().register(tool);
  const triggers = new TriggerRegistry().register(trigger);
  assert.equal(await tools.get(tool.type).execute({}, "ok"), "ok");
  await (await triggers.get(trigger.type).start({}, {})).stop();
  for (const [registry, adapter] of [[tools, tool], [triggers, trigger]]) {
    assert.equal(registry.list().length, 1);
    assert.throws(() => registry.register(adapter), /already registered/);
    assert.throws(() => registry.get("fixture.missing"), /not registered/);
    assert.throws(() => registry.register({ ...adapter, type: "invalid" }), /Invalid/);
  }
});

test("tool registration requires explicit version and side effect classification", () => {
  assert.throws(() => new ToolRegistry().register({ ...tool, version: " " }), /version/);
  assert.throws(() => new ToolRegistry().register({ ...tool, sideEffects: undefined }), /side effect/);
});
