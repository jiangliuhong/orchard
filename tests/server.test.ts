import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { setup, exampleFiles, until } from "./helpers.js";

test("HTTP creation, editing, publishing, two branches, old version history and request conflicts", async t => {
  const { store, providers } = setup(t), { app } = createApp(store, providers); t.after(() => app.close());
  const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url: `/api${url}`, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }), headers: { host: "127.0.0.1:7441", "content-type": "application/json" } });
    assert.ok(response.statusCode < 300, response.body); return response.json();
  };
  const draft = await call("POST", "/drafts", { requestId: randomUUID() });
  const state = await call("GET", `/drafts/${draft.id}`), workflowId = JSON.parse(state.files["workflow.json"]).id;
  await call("PATCH", `/drafts/${draft.id}`, { expectedRevision: 0, files: exampleFiles(workflowId) });
  const key = randomUUID(), version = await call("POST", `/drafts/${draft.id}/publish`, { expectedRevision: 1, requestId: key });
  assert.equal((await call("POST", `/drafts/${draft.id}/publish`, { expectedRevision: 1, requestId: key })).id, version.id);
  for (const action of ["execute", "skip"]) {
    const requestId = randomUUID(), payload = { input: { action }, requestId, versionId: version.id };
    const run = await call("POST", `/workflows/${workflowId}/runs`, payload);
    assert.equal((await call("POST", `/workflows/${workflowId}/runs`, payload)).id, run.id);
    const done = await until(async () => { const r = await call("GET", `/runs/${run.id}`); return ["succeeded", "failed"].includes(r.status) && r; });
    assert.equal(done.status, "succeeded", JSON.stringify(done.error));
    assert.equal(done.nodes.find((n: { nodeId: string }) => n.nodeId === "c").status, action === "execute" ? "succeeded" : "skipped");
    const events = await call("GET", `/runs/${run.id}/events?after=0`);
    assert.equal(events.items.at(-1).type, "run.succeeded");
    assert.equal((await call("GET", `/runs/${run.id}/events?after=${events.lastSequence}`)).items.length, 0);
    const conflict = await app.inject({ method: "POST", url: `/api/workflows/${workflowId}/runs`, payload: { ...payload, input: {} } });
    assert.equal(conflict.statusCode, 409);
  }
  const next = await call("POST", "/drafts", { workflowId, requestId: randomUUID() });
  const newer = await call("POST", `/drafts/${next.id}/publish`, { expectedRevision: 0, requestId: randomUUID() });
  assert.equal(newer.number, 2);
  const old = await call("GET", `/workflows/${workflowId}/versions/${version.id}`);
  assert.equal(old.number, 1);
  assert.equal(old.definition.nodes[1].config.modelId, "test-model");
});
test("HTTP enforces local origins, body schemas, object ownership and event cursors", async t => {
  const { store, providers } = setup(t), { app } = createApp(store, providers); t.after(() => app.close());
  assert.equal((await app.inject({ url: "/api/health", headers: { host: "attacker.example" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/drafts", headers: { host: "127.0.0.1:7441", origin: "https://evil.test" }, payload: { requestId: "x" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/drafts", payload: { requestId: "x", extra: true } })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/runs/missing" })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/artifacts/..%2f..%2foutside" })).statusCode, 404);
});

test("HTTP draft tests run without publishing and expose immutable execution snapshots", async t => {
  const { store, providers } = setup(t), { app, authoring } = createApp(store, providers);
  t.after(() => app.close());
  const draft = await authoring.create(undefined, randomUUID());
  const url = `/api/drafts/${draft.id}/runs`, payload = { expectedRevision: 0, input: { hello: "draft" }, requestId: randomUUID() };
  const response = await app.inject({ method: "POST", url, payload });
  assert.equal(response.statusCode, 202, response.body);
  const run = response.json();
  assert.equal(run.workflowVersionId, null);
  assert.equal(run.draftId, draft.id);
  assert.equal((await app.inject({ method: "POST", url, payload })).json().id, run.id);
  assert.equal((await app.inject({ method: "POST", url, payload: { ...payload, input: {} } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url, payload: { input: {}, requestId: randomUUID() } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url, payload: { ...payload, expectedRevision: 1, requestId: randomUUID() } })).statusCode, 409);
  await until(() => store.run(run.id).status === "succeeded");
  const snapshot = (await app.inject({ url: `/api/runs/${run.id}` })).json();
  assert.equal(snapshot.version, null);
  assert.equal(snapshot.draftRevision, 0);
  assert.equal(snapshot.execution.definition.entryNodeId, "start");
  assert.deepEqual(snapshot.output, payload.input);
  assert.equal(snapshot.nodes[0].status, "succeeded");
  assert.ok(snapshot.attempts.length);
  assert.equal((await app.inject({ url: "/api/health" })).json().schemaVersion, 6);
  assert.equal((await app.inject({ url: "/api/workflows" })).json().items.length, 0);
  assert.equal(store.all("SELECT id FROM workflow_versions").length, 0);
  const events = (await app.inject({ url: `/api/runs/${run.id}/events` })).json().items;
  assert.equal(events[0].payload.draftId, draft.id);
  assert.equal(events.at(-1).type, "run.succeeded");
});
