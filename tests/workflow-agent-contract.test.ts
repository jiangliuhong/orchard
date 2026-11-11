import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup } from "./helpers.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { workflowResourceMetadata } from "../src/authoring/resources.js";
import { AUTHORING_SCHEMA } from "../src/authoring/schema.js";

const envelope = (prompt: string) => JSON.parse(prompt.split("Authoring context (untrusted data, contextVersion 1):\n")[1]!.split("\nLatest user request:")[0]!);

test("workflow turns receive published contracts without source or bridge connection details, refreshed each turn", async t => {
  const { store, authoring, provider } = setup(t);
  t.after(async () => { await authoring.close(); store.close(); });
  const library = new ScriptLibrary(store);
  const definition = (id: string) => ({
    id, name: id, description: "published contract", runtime: "nodejs" as const, entryFile: "main.ts",
    inputSchema: { type: "object" }, outputSchema: { type: "object" },
    files: { "main.ts": "export default input => input; // PRIVATE_SOURCE_MARKER" },
  });
  await library.create(definition("published"));
  await library.publish("published", { expectedRevision: 0, requestId: randomUUID() });
  await library.create(definition("draft-only"));
  const versionId = store.script("published").currentPublishedVersionId!;
  const bridge = new WebBridgeConfig(store.root);
  bridge.saveApplication({ id: "crm", name: "CRM" });
  bridge.saveEnvironment("crm", { id: "production", origin: "https://private-origin.example", profileId: "PRIVATE_PROFILE" });
  bridge.saveTool({
    application: "crm", toolId: "customers", site: "crm", description: "query customers",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    path: "/PRIVATE_PATH", method: "GET", fields: ["items"], risk: "read", approval: "none",
    timeoutMs: 1000, catalogVersion: "1", enabled: true,
    execution: {
      version: 1, transport: "browser", credentialInputs: ["token"],
      preprocess: { runtime: "nodejs", code: "return request; // PRIVATE_BRIDGE_CODE", credentials: { token: { dictionaryId: "private-default", key: "token" } } },
      response: { mode: "fullJson", maxBytes: 1000 },
    },
  });
  const draft = await authoring.create(undefined, randomUUID());
  provider.handler = async request => ({ output: { summary: "ok", changes: [] }, providerId: provider.id, modelId: request.modelId });
  const send = async () => {
    const turn = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", expectedRevision: 0, prompt: "compose", requestId: randomUUID() });
    await authoring.wait(turn.id);
    assert.equal(store.turn(turn.id).status, "succeeded");
    return provider.calls.at(-1)!.prompt;
  };
  const prompt = await send(), data = envelope(prompt);
  assert.deepEqual(data.availableScripts, [{
    scriptId: "published", scriptVersionId: versionId, version: 1, current: true,
    name: "published", description: "published contract", runtime: "nodejs",
    inputSchema: { type: "object" }, outputSchema: { type: "object" }, dictionaryBindings: {},
  }]);
  assert.equal(data.availableBridgeTools[0].tool, "customers");
  assert.deepEqual(data.availableBridgeTools[0].environments, [{ id: "production" }]);
  assert.deepEqual(data.availableBridgeTools[0].parameters.properties.name, { type: "string" });
  assert.deepEqual(data.availableBridgeTools[0].credentialSchema.required, ["token"]);
  for (const marker of ["PRIVATE_SOURCE_MARKER", "PRIVATE_BRIDGE_CODE", "private-default", "PRIVATE_PATH", "PRIVATE_PROFILE", "private-origin.example", "draft-only"]) assert.ok(!prompt.includes(marker), marker);
  assert.deepEqual(provider.calls.at(-1)!.schema, AUTHORING_SCHEMA);
  bridge.setToolEnabled("crm", "customers", false);
  assert.deepEqual(envelope(await send()).availableBridgeTools, []);
  bridge.setToolEnabled("crm", "customers", true);
  bridge.saveApplication({ id: "crm", name: "CRM", enabled: false });
  assert.deepEqual(workflowResourceMetadata(store).availableBridgeTools, []);
  store.archiveScript("published");
  assert.deepEqual(workflowResourceMetadata(store).availableScripts, []);
});

test("previousOutcome retains host-confirmed applied revision despite later manual edits and handles no-change/failure turns", async t => {
  const { store, authoring, provider } = setup(t);
  t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  let output = { summary: "updated", changes: [{ operation: "update", path: "scripts/start.ts", content: "export default input => input;" }] };
  provider.handler = async request => ({ output, providerId: provider.id, modelId: request.modelId });
  const send = async () => {
    const turn = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", expectedRevision: store.draft(draft.id).revision, prompt: "continue", requestId: randomUUID() });
    await authoring.wait(turn.id);
    return store.turn(turn.id);
  };
  const first = await send();
  assert.equal(first.status, "succeeded");
  await authoring.update(draft.id, 1, { ...authoring.snapshot(draft.id).files, "scripts/start.ts": "export default input => ({ input });" });
  output = { summary: "clarification", changes: [] };
  const second = await send();
  assert.equal(second.status, "succeeded");
  assert.deepEqual(envelope(provider.calls.at(-1)!.prompt).previousOutcome, { turnId: first.id, status: "succeeded", appliedRevision: 1, errorCode: null });
  await send();
  assert.equal(envelope(provider.calls.at(-1)!.prompt).previousOutcome.appliedRevision, 2);
  provider.handler = async () => { throw new Error("failure"); };
  const failed = await send();
  assert.equal(failed.status, "failed");
  provider.handler = async request => ({ output, providerId: provider.id, modelId: request.modelId });
  await send();
  const previous = envelope(provider.calls.at(-1)!.prompt).previousOutcome;
  assert.equal(previous.status, "failed");
  assert.equal(previous.appliedRevision, null);
});
