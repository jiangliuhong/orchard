import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setup as setupProviders, TestProvider, until } from "./helpers.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { TestStore as Store } from "./helpers.js";
import { createApp } from "../src/server/app.js";
const setup = (context: TestContext) => setupProviders(context, { models: false });

test("legacy models remain enabled and disabling the default clears it without selecting a replacement", context => {
  const { store, providers, provider } = setup(context);
  context.after(() => store.close());
  providers.update(provider.id, { models: [{ id: "test-model", name: "Legacy", source: "configured" }] });
  assert.equal(providers.modelList(provider.id)[0]!.enabled, true);
  const disabled = providers.updateModel(provider.id, "test-model", { enabled: false });
  assert.equal(disabled.defaultModel, "");
  assert.equal(disabled.models[0]!.enabled, false);
  assert.throws(() => providers.resolve({ providerId: provider.id, modelId: "test-model" }), { code: "MODEL_DISABLED" });
  assert.throws(() => providers.update(provider.id, { defaultModel: "test-model" }), { code: "MODEL_DISABLED" });
  providers.updateModel(provider.id, "test-model", { enabled: true });
  assert.equal(providers.setting(provider.id).defaultModel, "");
  assert.equal(providers.resolve({ providerId: provider.id, modelId: "test-model" }).modelId, "test-model");
});

test("refresh preserves disabled models and deleted discoveries until explicitly added again", async context => {
  const { store, providers, provider } = setup(context);
  context.after(() => store.close());
  provider.models = async () => ({ models: [
    { id: "remote/model", name: "Remote", source: "discovered" },
    { id: "remote/other", name: "Other", source: "discovered" },
  ] });
  await providers.models(provider.id);
  providers.updateModel(provider.id, "remote/model", { enabled: false });
  providers.deleteModel(provider.id, "remote/other");
  await providers.models(provider.id);
  const visible = providers.modelList(provider.id);
  assert.equal(visible.find(model => model.id === "remote/model")!.enabled, false);
  assert.equal(visible.some(model => model.id === "remote/other"), false);
  assert.throws(() => providers.resolve({ providerId: provider.id, modelId: "remote/other" }), { code: "MODEL_DELETED" });
  providers.addModel(provider.id, { id: "remote/other", name: "Restored", enabled: true });
  await providers.models(provider.id);
  assert.equal(providers.modelList(provider.id).find(model => model.id === "remote/other")!.name, "Restored");
  assert.throws(() => providers.addModel(provider.id, { id: "remote/other" }), { code: "MODEL_CONFLICT" });
  assert.throws(() => providers.addModel(provider.id, { id: "--flag" }), { code: "INVALID_MODEL" });
});

test("model state persists in the existing JSON column across restart", context => {
  const { root, store, providers, provider } = setup(context);
  providers.addModel(provider.id, { id: "disabled", enabled: false });
  providers.addModel(provider.id, { id: "deleted" });
  providers.deleteModel(provider.id, "deleted");
  providers.update(provider.id, { config: { executable: process.execPath } });
  providers.update(provider.id, { models: [{ id: "deleted", name: "Stale client", source: "configured", enabled: true }] });
  assert.equal(providers.modelList(provider.id).some(model => model.id === "deleted"), false);
  assert.equal(providers.modelList(provider.id).find(model => model.id === "disabled")!.enabled, false);
  store.close();
  const reopened = new Store(root);
  context.after(() => reopened.close());
  const registry = new ProviderRegistry(reopened).register(new TestProvider(), process.execPath);
  assert.equal(registry.modelList(provider.id).find(model => model.id === "disabled")!.enabled, false);
  assert.equal(registry.modelList(provider.id).some(model => model.id === "deleted"), false);
  assert.equal(registry.setting(provider.id).models.find(model => model.id === "deleted")!.deleted, true);
  assert.equal(reopened.all("SELECT name FROM sqlite_master WHERE type='table'").length, 19);
});

test("model changes fence a pending catalog refresh and do not interrupt an active call", async context => {
  const { root, store, providers, provider } = setup(context);
  context.after(() => store.close());
  providers.addModel(provider.id, { id: "test-model" });
  let resolveCatalog!: (value: Awaited<ReturnType<TestProvider["models"]>>) => void;
  provider.models = () => new Promise(resolve => { resolveCatalog = resolve; });
  const refreshing = providers.models(provider.id);
  providers.updateModel(provider.id, "test-model", { enabled: false });
  resolveCatalog({ models: [{ id: "test-model", name: "Remote", source: "discovered" }] });
  await assert.rejects(refreshing, { code: "SETTINGS_CONFLICT" });
  providers.updateModel(provider.id, "test-model", { enabled: true });
  let release!: () => void;
  provider.handler = async request => {
    await new Promise<void>(resolve => { release = resolve; });
    return { output: "completed", modelId: request.modelId, providerId: provider.id };
  };
  const active = providers.run({ providerId: provider.id, modelId: "test-model" }, { cwd: root, prompt: "test", signal: new AbortController().signal, emit: () => {} });
  await until(() => !!release);
  providers.updateModel(provider.id, "test-model", { enabled: false });
  release();
  assert.equal((await active).output, "completed");
  await assert.rejects(providers.run({ providerId: provider.id, modelId: "test-model" }, { cwd: root, prompt: "test", signal: new AbortController().signal, emit: () => {} }), { code: "MODEL_DISABLED" });
});

test("HTTP model CRUD handles slash IDs, default clearing and idempotent deletion", async context => {
  const { store, providers, provider } = setup(context);
  const { app } = createApp(store, providers);
  context.after(() => app.close());
  const base = `/api/providers/${provider.id}/models`;
  const created = await app.inject({ method: "POST", url: base, payload: { id: "custom/model", name: "Custom" } });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().models[0].enabled, true);
  const duplicate = await app.inject({ method: "POST", url: base, payload: { id: "custom/model" } });
  assert.equal(duplicate.statusCode, 409);
  const encoded = encodeURIComponent("custom/model");
  providers.update(provider.id, { defaultModel: "custom/model" });
  const disabled = await app.inject({ method: "PATCH", url: `${base}/${encoded}`, payload: { enabled: false } });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().defaultModel, "");
  const listed = await app.inject({ url: base });
  assert.equal(listed.json().items[0].enabled, false);
  const removed = await app.inject({ method: "DELETE", url: `${base}/${encoded}` });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.json().models, []);
  assert.equal((await app.inject({ method: "DELETE", url: `${base}/${encoded}` })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: `${base}/missing`, payload: { enabled: true } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: `${base}/${encoded}`, payload: { enabled: "yes" } })).statusCode, 400);
});

test("workflow authoring advertises only enabled models", async context => {
  const { store, providers, provider, authoring } = setup(context);
  context.after(async () => { await authoring.close(); store.close(); });
  providers.addModel(provider.id, { id: "test-model" });
  providers.addModel(provider.id, { id: "hidden-model", enabled: false });
  provider.handler = async request => ({ output: { summary: "clarify", changes: [] }, providerId: provider.id, modelId: request.modelId });
  const draft = await authoring.create(undefined, "model-context");
  const turn = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: "Create a flow", requestId: "model-context-turn", expectedRevision: 0 });
  await authoring.wait(turn.id);
  const line = provider.calls[0]!.prompt.split("\n").find(value => value.startsWith("Available providers and models"))!;
  const catalog = JSON.parse(line.slice(line.indexOf(": ") + 2)) as { id: string; models: { id: string }[] }[];
  assert.deepEqual(catalog.find(entry => entry.id === provider.id)!.models.map(model => model.id), ["test-model"]);
});
