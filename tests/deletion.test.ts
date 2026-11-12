import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createApp } from "../src/server/app.js";
import { setupLegacy as setup, until } from "./helpers.js";

test("workflow deletion removes all versions, original and later drafts, runs, conversations and receipts while copies survive", async context => {
  const { store, providers, provider } = setup(context);
  const { app, authoring, runner } = createApp(store, providers);
  context.after(() => app.close());
  await app.ready();
  const original = await authoring.create(undefined, "create-original");
  const testRun = await runner.createDraft(original.id, 0, { sample: true }, "test-original");
  await until(() => store.run(testRun.id).status === "succeeded");
  provider.handler = async request => ({ output: { summary: "reviewed", changes: [] }, providerId: provider.id, modelId: request.modelId });
  const turn = await authoring.start(original.id, { providerId: provider.id, modelId: "test-model", prompt: "review", expectedRevision: 0, requestId: "review" });
  await authoring.wait(turn.id);
  const first = await authoring.publish(original.id, 0, "publish-original");
  const edit = await authoring.editVersion(first.workflowId, undefined, "edit", "edit");
  const second = await authoring.publish(edit.id, 0, "publish-second");
  const openDraft = await authoring.editVersion(first.workflowId, undefined, "edit", "continue");
  const normalRun = runner.create(first.id, { normal: true }, "run-original");
  await until(() => store.run(normalRun.id).status === "succeeded");
  const copy = await authoring.editVersion(first.workflowId, first.id, "copy", "copy");
  const copied = await authoring.publish(copy.id, 0, "publish-copy");
  const unpostedCopy = await authoring.editVersion(first.workflowId, second.id, "copy", "copy-draft");
  const copyFiles = authoring.snapshot(unpostedCopy.id).files;
  const other = await authoring.create(undefined, "unrelated-draft");
  assert.equal(first.artifactPath, second.artifactPath);

  const response = await app.inject({ method: "DELETE", url: `/api/workflows/${first.workflowId}` });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { id: first.workflowId, deleted: true });
  assert.equal(store.one("SELECT id FROM workflows WHERE id=?", first.workflowId), undefined);
  assert.equal(store.all("SELECT id FROM workflow_versions WHERE workflow_id=?", first.workflowId).length, 0);
  for (const id of [original.id, edit.id, openDraft.id]) {
    assert.equal((await app.inject({ url: `/api/drafts/${id}` })).statusCode, 404);
    assert.equal(store.messages(id).length, 0);
    assert.equal(store.turns(id).length, 0);
    assert.equal(store.one("SELECT scope FROM command_receipts WHERE json_extract(result_json,'$.id')=?", id), undefined);
  }
  for (const run of [testRun, normalRun]) {
    assert.equal((await app.inject({ url: `/api/runs/${run.id}` })).statusCode, 404);
    assert.equal((await app.inject({ url: `/api/runs/${run.id}/events` })).statusCode, 404);
    assert.equal(store.nodes(run.id).length, 0);
    assert.equal(store.stream("run", run.id).length, 0);
    assert.equal(store.attempts(run.id).length, 0);
  }
  assert.equal(store.stream("authoring_turn", turn.id).length, 0);
  assert.equal(store.one("SELECT scope FROM command_receipts WHERE scope=?", `version-draft:${first.workflowId}`), undefined);
  assert.equal(store.one("SELECT scope FROM command_receipts WHERE json_extract(result_json,'$.id')=?", first.id), undefined);
  assert.equal((await app.inject({ url: `/api/workflows/${first.workflowId}` })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/workflows/${first.workflowId}/versions/${first.id}` })).statusCode, 404);
  assert.equal(store.version(copied.id).workflowId, copied.workflowId);
  assert.deepEqual(authoring.snapshot(unpostedCopy.id).files, copyFiles);
  assert.equal(store.draft(other.id).id, other.id);
  assert.ok(existsSync(store.files.path(first.artifactPath)));
  assert.deepEqual(store.all("PRAGMA foreign_key_check"), []);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/workflows/${first.workflowId}` })).statusCode, 200);
  const runCopy = runner.create(copied.id, { intact: true }, randomUUID());
  await until(() => store.run(runCopy.id).status === "succeeded");
  assert.deepEqual(store.run(runCopy.id).output, { intact: true });
});

test("workflow deletion rejects queued, running, cancelling and publishing work without partial deletion", async context => {
  const { store, providers } = setup(context), { app, authoring, runner } = createApp(store, providers);
  context.after(() => app.close());
  await app.ready();
  await runner.close();
  const draft = await authoring.create(undefined, randomUUID());
  const version = await authoring.publish(draft.id, 0, randomUUID());
  const edit = await authoring.editVersion(version.workflowId, undefined, "edit", randomUUID());
  for (const status of ["queued", "running", "cancel_requested"]) {
    const id = randomUUID();
    store.exec("INSERT INTO runs(id,workflow_version_id,status,input_ref,created_at) VALUES(?,?,?,?,?)", id, version.id, status, store.reference({}), Date.now());
    const response = await app.inject({ method: "DELETE", url: `/api/workflows/${version.workflowId}` });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, "WORKFLOW_BUSY");
    assert.equal(store.version(version.id).id, version.id);
    assert.equal(store.draft(edit.id).id, edit.id);
    assert.equal(store.run(id).status, status);
    store.exec("UPDATE runs SET status='cancelled' WHERE id=?", id);
  }
  store.exec("UPDATE drafts SET status='publishing' WHERE id=?", edit.id);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/workflows/${version.workflowId}` })).statusCode, 409);
  store.exec("UPDATE drafts SET status='draft' WHERE id=?", edit.id);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/workflows/${version.workflowId}` })).statusCode, 200);
  assert.deepEqual(store.all("PRAGMA foreign_key_check"), []);
});

test("draft deletion clears only its tests and rejects active and still-finishing cancelled authoring jobs", async context => {
  const { store, providers, provider } = setup(context), { app, authoring, runner } = createApp(store, providers);
  let release: (() => void) | undefined;
  context.after(async () => { release?.(); await app.close(); });
  await app.ready();
  const source = await authoring.create(undefined, randomUUID()), version = await authoring.publish(source.id, 0, randomUUID());
  const draft = await authoring.editVersion(version.workflowId, undefined, "edit", randomUUID());
  const run = await runner.createDraft(draft.id, 0, {}, randomUUID());
  await until(() => store.run(run.id).status === "succeeded");
  provider.handler = async request => {
    await new Promise<void>(resolve => { release = resolve; });
    return { output: { summary: "late", changes: [] }, providerId: provider.id, modelId: request.modelId };
  };
  const turn = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: "change", expectedRevision: 0, requestId: randomUUID() });
  await until(() => release);
  const remove = (kind: string, id: string) => app.inject({ method: "DELETE", url: `/api/${kind}/${id}` });
  assert.equal((await remove("drafts", draft.id)).statusCode, 409);
  assert.equal((await remove("workflows", version.workflowId)).statusCode, 409);
  authoring.cancel(draft.id, turn.id);
  assert.equal((await remove("drafts", draft.id)).statusCode, 409);
  release!(); await authoring.wait(turn.id);
  assert.equal((await remove("drafts", draft.id)).statusCode, 200);
  assert.equal(store.one("SELECT id FROM runs WHERE id=?", run.id), undefined);
  assert.equal(store.version(version.id).id, version.id);
  assert.equal((await remove("drafts", draft.id)).statusCode, 200);
  assert.equal((await remove("drafts", source.id)).statusCode, 409);
  assert.deepEqual(store.all("PRAGMA foreign_key_check"), []);
});

test("a database failure during deletion rolls back removed child rows", async context => {
  const { store, providers } = setup(context), { app, authoring, runner } = createApp(store, providers);
  context.after(() => app.close());
  await app.ready();
  const draft = await authoring.create(undefined, randomUUID()), version = await authoring.publish(draft.id, 0, randomUUID());
  const run = runner.create(version.id, {}, randomUUID());
  await until(() => store.run(run.id).status === "succeeded");
  const events = store.stream("run", run.id), nodes = store.nodes(run.id), attempts = store.attempts(run.id);
  store.db.exec("CREATE TEMP TRIGGER reject_deletion BEFORE DELETE ON workflows BEGIN SELECT RAISE(ABORT,'delete failed'); END");
  const response = await app.inject({ method: "DELETE", url: `/api/workflows/${version.workflowId}` });
  assert.equal(response.statusCode, 500);
  assert.equal(store.version(version.id).id, version.id);
  assert.equal(store.draft(draft.id).id, draft.id);
  assert.deepEqual(store.stream("run", run.id), events);
  assert.deepEqual(store.nodes(run.id), nodes);
  assert.deepEqual(store.attempts(run.id), attempts);
  assert.deepEqual(store.all("PRAGMA foreign_key_check"), []);
});
