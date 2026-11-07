import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createApp } from "../src/server/app.js";
import { ConfigRestoreService } from "../src/config-git/restore.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { GraphRunner } from "../src/runtime/runner.js";
import { ScriptTestRunner } from "../src/runtime/script-tests.js";
import { setup } from "./helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("startup awaits restore before business recovery, service caches and queue activation", async t => {
  const { store } = setup(t);
  const entered = deferred(), release = deferred();
  const recover = ConfigRestoreService.prototype.recover;
  t.mock.method(ConfigRestoreService.prototype, "recover", async function (this: ConfigRestoreService, operationId?: string) {
    entered.resolve();
    await release.promise;
    return recover.call(this, operationId);
  });
  const business = t.mock.method(store, "recoverBusiness");
  const registration = t.mock.method(ProviderRegistry.prototype, "register");
  const graphStart = t.mock.method(GraphRunner.prototype, "start");
  const testsStart = t.mock.method(ScriptTestRunner.prototype, "start");
  const services = createApp(store);
  t.after(async () => { release.resolve(); await services.ready; await services.app.close(); });
  let initialized = false, fastifyReady = false;
  const initializedPromise = services.ready.then(() => { initialized = true; });
  const readyPromise = services.app.ready().then(() => { fastifyReady = true; });
  await entered.promise;
  // Yield a full event-loop turn so an incorrectly unawaited recovery can advance.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(initialized, false);
  assert.equal(fastifyReady, false);
  assert.equal(business.mock.callCount(), 0);
  assert.equal(registration.mock.callCount(), 0);
  assert.equal(graphStart.mock.callCount(), 0);
  assert.equal(testsStart.mock.callCount(), 0);
  assert.throws(() => services.authoring.snapshot("missing"), { code: "SERVICE_NOT_READY" });
  assert.throws(() => services.bridge.config, { code: "SERVICE_NOT_READY" });

  // Simulate the file installed by restore; eager construction would cache the old file.
  const configPath = store.files.path("config/web-bridge.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.applications.restored = { id: "restored", name: "Restored application", enabled: true };
  writeFileSync(configPath, JSON.stringify(config));
  release.resolve();
  await Promise.all([initializedPromise, readyPromise]);
  assert.equal(business.mock.callCount(), 1);
  assert.equal(registration.mock.callCount(), 2);
  assert.equal(graphStart.mock.callCount(), 1);
  assert.equal(testsStart.mock.callCount(), 1);
  assert.equal(services.bridge.config!.applications()[0]!.name, "Restored application");
  const draft = await services.authoring.create(undefined, "startup-ready");
  assert.equal(store.draft(draft.id).id, draft.id);
});

test("failed restore rejects readiness without business recovery or queue activation", async t => {
  const { store } = setup(t);
  const failure = new Error("restore recovery failed");
  t.mock.method(ConfigRestoreService.prototype, "recover", async () => { throw failure; });
  const business = t.mock.method(store, "recoverBusiness");
  const registration = t.mock.method(ProviderRegistry.prototype, "register");
  const graphStart = t.mock.method(GraphRunner.prototype, "start");
  const testsStart = t.mock.method(ScriptTestRunner.prototype, "start");
  const services = createApp(store);
  t.after(() => services.app.close());
  await assert.rejects(services.ready, error => error === failure);
  await assert.rejects(async () => { await services.app.ready(); }, error => error === failure);
  assert.equal(business.mock.callCount(), 0);
  assert.equal(registration.mock.callCount(), 0);
  assert.equal(graphStart.mock.callCount(), 0);
  assert.equal(testsStart.mock.callCount(), 0);
  assert.throws(() => services.bridge.config, { code: "SERVICE_NOT_READY" });
});
