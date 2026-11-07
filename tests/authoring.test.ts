import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, exampleFiles, publishExample, until } from "./helpers.js";

test("authoring applies files, persists conversation and publishes explicitly with idempotency", async t => {
  const { store, provider, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, "create");
  assert.equal((await authoring.create(undefined, "create")).id, draft.id);
  const original = authoring.snapshot(draft.id).files, id = JSON.parse(original["workflow.json"]!).id;
  const files = exampleFiles(id);
  provider.handler = async request => ({
    output: { summary: "流程已创建", changes: [...Object.keys(original).filter(path => !Object.hasOwn(files, path)).map(path => ({ operation: "delete", path })), ...Object.entries(files).map(([path, content]) => ({ operation: Object.hasOwn(original, path) ? "update" : "create", path, content }))] },
    providerId: provider.id, modelId: request.modelId,
  });
  const input = { providerId: provider.id, modelId: "test-model", prompt: "create flow", expectedRevision: 0, requestId: "turn" };
  const turn = await authoring.start(draft.id, input); await authoring.wait(turn.id);
  assert.equal(store.turn(turn.id).status, "succeeded", JSON.stringify(store.turn(turn.id).error));
  assert.equal((await authoring.start(draft.id, input)).id, turn.id);
  const snapshot = authoring.snapshot(draft.id); assert.equal(snapshot.revision, 1); assert.equal(snapshot.messages.length, 2);
  assert.equal(store.workflows().length, 0);
  const version = await authoring.publish(draft.id, 1, "publish");
  assert.equal((await authoring.publish(draft.id, 1, "publish")).id, version.id);
  assert.equal(store.runs().length, 0);
  assert.equal(version.definition.defaults?.agent?.agentConfigId, "test-agent-config");
  assert.equal(Object.hasOwn(version.definition.nodes.find(n => n.id === "b")!.config, "modelId"), false);
  assert.throws(() => store.exec("UPDATE workflow_versions SET definition_json='{}' WHERE id=?", version.id), /immutable/);
});
test("invalid graph remains a repairable draft while invalid paths never commit", async t => {
  const { store, provider, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID()), source = authoring.snapshot(draft.id).files;
  const graph = JSON.parse(source["workflow.json"]!); graph.entryNodeId = "missing";
  provider.handler = async r => ({ output: { summary: "candidate", changes: [{ operation: "update", path: "workflow.json", content: JSON.stringify(graph) }] }, providerId: provider.id, modelId: r.modelId });
  const turn = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: "change", expectedRevision: 0, requestId: randomUUID() }); await authoring.wait(turn.id);
  assert.equal(store.draft(draft.id).validation.valid, false);
  await assert.rejects(authoring.publish(draft.id, 1, randomUUID()), /校验/);
  provider.handler = async r => ({ output: { summary: "escape", changes: [{ operation: "create", path: "../escape.ts", content: "" }] }, providerId: provider.id, modelId: r.modelId });
  const next = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: "change", expectedRevision: 1, requestId: randomUUID() }); await authoring.wait(next.id);
  assert.equal(store.turn(next.id).status, "failed"); assert.equal(store.draft(draft.id).revision, 1);
});
test("cancelled late changes do not modify draft and baseline conflicts preserve old versions", async t => {
  const { store, provider, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const version = await publishExample(authoring);
  const first = await authoring.create(version.workflowId, randomUUID()), second = await authoring.create(version.workflowId, randomUUID());
  await authoring.publish(first.id, 0, randomUUID());
  await assert.rejects(authoring.publish(second.id, 0, randomUUID()), /已有新版本/);
  assert.equal(store.draft(second.id).status, "draft");
  assert.equal(store.version(version.id).number, 1);
  let release!: () => void;
  provider.handler = async r => { await new Promise<void>(resolve => { release = resolve; }); return { output: { summary: "late", changes: [] }, providerId: provider.id, modelId: r.modelId }; };
  const turn = await authoring.start(second.id, { providerId: provider.id, modelId: "test-model", prompt: "late", expectedRevision: 0, requestId: randomUUID() });
  await until(() => typeof release === "function");
  authoring.cancel(second.id, turn.id); release(); await authoring.wait(turn.id);
  assert.equal(store.turn(turn.id).status, "cancelled"); assert.equal(store.draft(second.id).revision, 0);
});

test("editing reuses a draft, copies have independent identities, and restoration preserves history", async t => {
  const { store, authoring } = setup(t);
  t.after(async () => { await authoring.close(); store.close(); });
  const first = await publishExample(authoring);
  const edit = await authoring.editVersion(first.workflowId, undefined, "edit", "edit");
  assert.equal((await authoring.editVersion(first.workflowId, undefined, "edit", "edit-again")).id, edit.id);
  const files = authoring.snapshot(edit.id).files;
  const definition = JSON.parse(files["workflow.json"]!);
  definition.name = "更新后的流程";
  await authoring.update(edit.id, 0, { ...files, "workflow.json": JSON.stringify(definition) });
  const second = await authoring.publish(edit.id, 1, "publish-second");
  assert.equal(second.workflowId, first.workflowId);
  assert.equal(second.number, 2);
  assert.equal(store.workflows().length, 1);

  const copy = await authoring.editVersion(first.workflowId, first.id, "copy", "copy");
  assert.equal((await authoring.editVersion(first.workflowId, first.id, "copy", "copy")).id, copy.id);
  assert.equal(copy.workflowId, null);
  const copied = await authoring.publish(copy.id, 0, "publish-copy");
  assert.notEqual(copied.workflowId, first.workflowId);
  assert.equal(copied.number, 1);
  assert.deepEqual(copied.definition.nodes, first.definition.nodes);
  await assert.rejects(authoring.editVersion(first.workflowId, copied.id, "restore", "wrong-owner"), /不属于/);

  const restored = await authoring.editVersion(first.workflowId, first.id, "restore", "restore");
  assert.equal(restored.baseVersionId, second.id);
  assert.equal(JSON.parse(authoring.snapshot(restored.id).files["workflow.json"]!).name, first.definition.name);
  await assert.rejects(authoring.editVersion(first.workflowId, first.id, "restore", "restore-again"), /已有未发布/);
  const third = await authoring.publish(restored.id, 0, "publish-restored");
  assert.equal(third.number, 3);
  assert.equal(third.workflowId, first.workflowId);
  assert.equal(store.workflows().find(w => w.id === first.workflowId)!.currentVersionId, third.id);
  assert.deepEqual(store.version(first.id), first);
  assert.deepEqual(store.version(second.id), second);
});
