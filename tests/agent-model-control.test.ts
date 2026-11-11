import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AgentModelControl, type ModelControlHost, type ModelSwitchResult } from "../src/agent/model-control.js";
import { executionFixture } from "./agent-execution-fixtures.js";

function fixture(t: TestContext) {
  const f = executionFixture(t); f.bind();
  let switches = 0, inspections = 0, available = true, result: ModelSwitchResult = { status: "confirmed", modelId: "model-b" };
  const host: ModelControlHost = {
    async authorize() {},
    async validateModel() { assert.ok(available, "disabled model"); },
    async switchModel() { switches++; return result; },
    async inspect() { inspections++; return result; },
  };
  const input = { requestId: "switch", expectedRevision: f.store.conversation(f.actor, f.conversation.id).revision, modelId: "model-b" };
  return { ...f, host, control: new AgentModelControl(f.store, f.locks, host), input, counts: () => ({ switches, inspections }), result(value: ModelSwitchResult) { result = value; }, disable() { available = false; } };
}

test("model control confirms model without replacing native identity; completed requests are idempotent", async t => {
  const f = fixture(t), signal = new AbortController().signal;
  const before = f.store.backend(f.actor, f.conversation.id);
  const operation = await f.control.switch(f.actor, f.conversation.id, f.input, signal);
  assert.equal(operation.status, "succeeded");
  assert.equal(f.store.conversation(f.actor, f.conversation.id).current_model_id, "model-b");
  assert.deepEqual(f.store.backend(f.actor, f.conversation.id), before);
  f.disable();
  assert.equal((await f.control.switch(f.actor, f.conversation.id, f.input, signal)).id, operation.id);
  assert.equal(f.counts().switches, 1);
  await assert.rejects(f.control.switch(f.actor, f.conversation.id, { ...f.input, modelId: "other" }, signal), { code: "REQUEST_CONFLICT" });
});

test("explicit confirmed rollback retains the old model and ends the failed operation", async t => {
  const f = fixture(t); f.result({ status: "unchanged", modelId: "model", code: "MODEL_REJECTED" });
  const operation = await f.control.switch(f.actor, f.conversation.id, f.input, new AbortController().signal);
  assert.equal(operation.status, "failed"); assert.equal(operation.phase, "done");
  assert.equal(f.store.conversation(f.actor, f.conversation.id).current_model_id, "model");
});

test("uncertain model switch blocks submissions and is inspected after restart without resending", async t => {
  const f = fixture(t), signal = new AbortController().signal;
  f.result({ status: "unknown" });
  const unknown = await f.control.switch(f.actor, f.conversation.id, f.input, signal);
  assert.equal(unknown.status, "unknown");
  assert.equal(f.store.conversation(f.actor, f.conversation.id).current_model_id, "model");
  assert.throws(() => f.store.submit(f.actor, f.conversation.id, { requestId: "turn", requestHash: "a".repeat(64) }), { code: "OPERATION_ACTIVE" });
  f.result({ status: "confirmed", modelId: "model-b" });
  const restarted = new AgentModelControl(f.store, f.locks, f.host);
  assert.equal((await restarted.switch(f.actor, f.conversation.id, f.input, signal)).status, "succeeded");
  assert.deepEqual(f.counts(), { switches: 1, inspections: 1 });
});

test("mismatched confirmation never updates platform model or claims rollback", async t => {
  const f = fixture(t); f.result({ status: "confirmed", modelId: "wrong" });
  const result = await f.control.switch(f.actor, f.conversation.id, f.input, new AbortController().signal);
  assert.equal(result.status, "unknown");
  assert.equal(f.store.conversation(f.actor, f.conversation.id).current_model_id, "model");
});

test("disabled model fails before registering a control operation", async t => {
  const f = fixture(t); f.disable();
  await assert.rejects(f.control.switch(f.actor, f.conversation.id, f.input, new AbortController().signal), /disabled model/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_operations").get()!.n, 0);
});
