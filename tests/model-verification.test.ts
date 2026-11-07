import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setup as setupProviders, until } from "./helpers.js";
import { AppError } from "../src/domain/errors.js";
import { createApp } from "../src/server/app.js";
import type { TurnRequest } from "../src/providers/registry.js";
const setup = (context: TestContext) => setupProviders(context, { models: false });

function waitForAbort(request: TurnRequest): Promise<never> {
  return new Promise((_, reject) => {
    if (request.signal.aborted) reject(request.signal.reason);
    else request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  });
}

test("verification calls a disabled model once without changing persisted settings", async context => {
  const { store, providers, provider } = setup(context);
  context.after(() => store.close());
  providers.addModel(provider.id, { id: "remote/model", enabled: false });
  const before = providers.setting(provider.id);
  provider.handler = async request => ({ output: " OK ", modelId: "reported-model", modelSource: "reported", providerId: provider.id });
  const result = await providers.verifyModel(provider.id, "remote/model");
  assert.equal(result.status, "available");
  assert.equal(result.responsePreview, "OK");
  assert.equal(result.actualModelId, "reported-model");
  assert.equal(result.providerRevision, before.revision);
  assert.ok(result.checkedAt > 0 && result.durationMs >= 0);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]!.modelId, "remote/model");
  assert.equal(provider.calls[0]!.prompt, "Reply with only OK. Do not use tools or perform any other task.");
  assert.deepEqual(providers.setting(provider.id), before);
  assert.equal(providers.activeVerificationCount, 0);
});

test("verification reports model errors, empty output and unavailable CLI without retries", async context => {
  const { store, providers, provider } = setup(context);
  context.after(() => store.close());
  providers.addModel(provider.id, { id: "test-model" });
  for (const code of ["AUTH_FAILED", "MODEL_NOT_FOUND"]) {
    provider.handler = async () => { throw new AppError(code, "fixture rejection"); };
    const result = await providers.verifyModel(provider.id, "test-model");
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, code);
    assert.equal(result.error?.message, "fixture rejection");
  }
  provider.handler = async request => ({ output: "  ", modelId: request.modelId, providerId: provider.id });
  assert.equal((await providers.verifyModel(provider.id, "test-model")).error?.code, "EMPTY_MODEL_RESPONSE");
  providers.adapter(provider.id).detect = async () => ({ state: "unavailable", reason: "CLI missing" });
  const result = await providers.verifyModel(provider.id, "test-model");
  assert.equal(result.error?.code, "PROVIDER_UNAVAILABLE");
  assert.equal(provider.calls.length, 3);
});

test("verification rejects missing, deleted and disabled provider before invoking the model", async context => {
  const { store, providers, provider } = setup(context);
  context.after(() => store.close());
  await assert.rejects(providers.verifyModel(provider.id, "missing"), { code: "MODEL_NOT_FOUND" });
  providers.addModel(provider.id, { id: "deleted" });
  providers.deleteModel(provider.id, "deleted");
  await assert.rejects(providers.verifyModel(provider.id, "deleted"), { code: "MODEL_NOT_FOUND" });
  providers.update(provider.id, { enabled: false });
  await assert.rejects(providers.verifyModel(provider.id, "deleted"), { code: "PROVIDER_DISABLED" });
  assert.equal(provider.calls.length, 0);
});

test("verification times out, cancels, prevents duplicate calls and drains on shutdown", async context => {
  const { store, providers, provider } = setup(context);
  context.after(() => store.close());
  providers.addModel(provider.id, { id: "test-model" });
  provider.handler = waitForAbort;
  const timedOut = await providers.verifyModel(provider.id, "test-model", { timeoutMs: 20 });
  assert.equal(timedOut.status, "failed");
  assert.equal(timedOut.error?.code, "TIMEOUT");
  const controller = new AbortController();
  const active = providers.verifyModel(provider.id, "test-model", { signal: controller.signal });
  await until(() => provider.calls.length === 2);
  assert.equal(providers.activeVerificationCount, 1);
  await assert.rejects(providers.verifyModel(provider.id, "test-model"), { code: "MODEL_VERIFICATION_BUSY" });
  assert.equal(provider.calls.length, 2);
  controller.abort();
  assert.equal((await active).status, "cancelled");
  const closing = providers.verifyModel(provider.id, "test-model");
  await until(() => provider.calls.length === 3);
  await providers.closeVerifications();
  assert.equal((await closing).status, "cancelled");
  assert.equal(providers.activeVerificationCount, 0);
});

test("verification never reports late success after cancellation or a configuration change", async context => {
  const { store, providers, provider } = setup(context);
  context.after(() => store.close());
  providers.addModel(provider.id, { id: "test-model" });
  let release!: () => void;
  provider.handler = async request => {
    await new Promise<void>(resolve => { release = resolve; });
    return { output: "OK", modelId: request.modelId, providerId: provider.id };
  };
  const controller = new AbortController();
  const first = providers.verifyModel(provider.id, "test-model", { signal: controller.signal });
  await until(() => !!release);
  controller.abort(); release();
  assert.equal((await first).status, "cancelled");
  const second = providers.verifyModel(provider.id, "test-model");
  await until(() => provider.calls.length === 2);
  providers.updateModel(provider.id, "test-model", { enabled: false });
  release();
  const result = await second;
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "SETTINGS_CONFLICT");
});

test("bodyless HTTP verification supports encoded model IDs and reports execution failures as results", async context => {
  const { store, providers, provider } = setup(context);
  const { app } = createApp(store, providers);
  context.after(() => app.close());
  await app.ready();
  providers.addModel(provider.id, { id: "remote/model" });
  provider.handler = async request => ({ output: "OK", modelId: request.modelId, providerId: provider.id });
  const url = `/api/providers/${provider.id}/models/${encodeURIComponent("remote/model")}/verify`;
  const success = await app.inject({ method: "POST", url });
  assert.equal(success.statusCode, 200, success.body);
  assert.equal(success.json().status, "available");
  assert.equal(success.json().actualModelId, undefined);
  provider.handler = async () => { throw new AppError("AUTH_FAILED", "Login needed"); };
  const failure = await app.inject({ method: "POST", url });
  assert.equal(failure.statusCode, 200);
  assert.equal(failure.json().error.code, "AUTH_FAILED");
  assert.equal((await app.inject({ url: "/api/health" })).json().activeModelVerifications, 0);
  providers.deleteModel(provider.id, "remote/model");
  assert.equal((await app.inject({ method: "POST", url })).statusCode, 404);
});

test("HTTP disconnect and server shutdown abort verification and await provider cleanup", { timeout: 10000 }, async context => {
  const { store, providers, provider } = setup(context);
  providers.addModel(provider.id, { id: "test-model" });
  provider.handler = waitForAbort;
  const { app } = createApp(store, providers);
  context.after(() => app.close());
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const url = `${base}/api/providers/${provider.id}/models/test-model/verify`;
  const controller = new AbortController();
  const disconnected = fetch(url, { method: "POST", signal: controller.signal }).catch(error => error);
  await until(() => provider.calls.length === 1);
  controller.abort();
  await disconnected;
  await until(() => providers.activeVerificationCount === 0);
  assert.equal(provider.calls[0]!.signal.aborted, true);
  const response = fetch(url, { method: "POST" }).then(value => value.json());
  await until(() => provider.calls.length === 2);
  await app.close();
  assert.equal((await response).status, "cancelled");
  assert.equal(provider.calls[1]!.signal.aborted, true);
  assert.equal(providers.activeVerificationCount, 0);
});
