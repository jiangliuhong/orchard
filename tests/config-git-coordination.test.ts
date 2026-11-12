import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configCoordinator, ConfigWriteCoordinator } from "../src/config-git/coordinator.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { ScriptAgentService } from "../src/authoring/script-agent.js";
import { ScriptMaintenance } from "../src/persistence/script-maintenance.js";
import { ScriptTestRunner } from "../src/runtime/script-tests.js";
import { GraphRunner } from "../src/runtime/runner.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { WebBridgeGateway } from "../src/web-bridge/gateway.js";
import { WebBridgeClient } from "../src/web-bridge/client.js";
import { setupLegacy as setup, until, publishExample } from "./helpers.js";
import type { AgentProvider } from "../src/providers/registry.js";
import type { ScriptDefinition } from "../src/domain/scripts.js";

const definition: ScriptDefinition = {
  id: "coord-script", name: "Coordination", description: "", runtime: "nodejs", entryFile: "main.ts",
  inputSchema: true, outputSchema: true, files: { "main.ts": "export default input => input" },
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test("nested definition writes stay synchronous and work inside restore recovery", () => {
  const coordinator = new ConfigWriteCoordinator();
  assert.equal(coordinator.withWrite(() => coordinator.withWrite(() => 42)), 42);
  assert.equal(coordinator.generation, 1);
  coordinator.setMaintenance("recovering");
  assert.equal(coordinator.withExclusive(() => coordinator.withWrite(() => coordinator.withWrite(() => 43)), true), 43);
  assert.throws(() => coordinator.withWrite(() => 1), { code: "RECOVERY_REQUIRED" });
});

test("maintenance rejects domain writes, task acceptance and cleanup before mutation", async t => {
  const { store, root, providers, provider, authoring } = setup(t);
  t.after(() => store.close());
  const library = new ScriptLibrary(store), created = await library.create(definition);
  const coordinator = configCoordinator(store), bridge = new WebBridgeConfig(root, coordinator);
  const before = readFileSync(join(root, "config/web-bridge.json"), "utf8");
  coordinator.setMaintenance("restore incomplete");
  assert.throws(() => providers.update(provider.id, { enabled: false }), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => providers.modelConfigs.update("test-agent-config", { expectedRevision: 1, requestId: "blocked", enabled: false }), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => new ScriptAgentService(store, providers).archiveConversation(created.script.id, "blocked"), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => store.archiveScript(created.script.id), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => store.publishScript(created.script.id, 0), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => store.createScriptTest(created.script.id, null, 0, {}), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => bridge.saveApplication({ id: "blocked", name: "Blocked" }), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => new ScriptMaintenance(store).clean(created.script.id, { keepDays: 1, keepLatest: 1, token: "invalid", requestId: "blocked" }), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => new GraphRunner(store, providers, undefined, false).start(), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => new ScriptTestRunner(store, false).start(), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(library.update(created.script.id, { ...definition, expectedRevision: 0 }), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(authoring.create(undefined, "blocked"), { code: "RECOVERY_REQUIRED" });
  assert.equal(store.script(created.script.id).status, "draft");
  assert.equal(store.scriptTests(created.script.id).length, 0);
  assert.equal(readFileSync(join(root, "config/web-bridge.json"), "utf8"), before);
  coordinator.setMaintenance(null);
});

test("async model discovery blocks restore through its final definition write and invalidates generation", async t => {
  const { store, providers, provider } = setup(t); t.after(() => store.close());
  const gate = deferred(), coordinator = configCoordinator(store), generation = coordinator.generation;
  let resets = 0;
  (provider as AgentProvider).resetCache = () => { resets++; };
  await providers.detect(provider.id);
  assert.equal(providers.views()[0]!.readiness.state, "ready");
  provider.models = async () => { await gate.promise; return { models: [{ id: "found", name: "Found", source: "discovered" }] }; };
  const pending = providers.models(provider.id);
  assert.ok(coordinator.activeCount > 0);
  assert.throws(() => coordinator.withExclusive(() => {}), { code: "CONFIG_BUSY" });
  assert.throws(() => coordinator.withRead(() => {}), { code: "CONFIG_BUSY" });
  gate.resolve(); await pending;
  assert.equal(coordinator.activeCount, 0);
  assert.ok(coordinator.generation > generation);
  assert.ok(providers.modelList(provider.id).some(model => model.id === "found"));
  coordinator.withExclusive(() => providers.reloadAfterRestore());
  assert.equal(providers.views()[0]!.readiness.state, "unknown");
  assert.equal(resets, 1);
});

test("async publication is covered before validation yields and external restore blocks new work", async t => {
  const { store, providers, provider } = setup(t); t.after(() => store.close());
  const library = new ScriptLibrary(store), coordinator = configCoordinator(store);
  await library.create(definition);
  const publishing = library.publish(definition.id, { expectedRevision: 0, requestId: "publish" });
  assert.ok(coordinator.activeCount > 0);
  assert.throws(() => coordinator.withExclusive(() => {}), { code: "CONFIG_BUSY" });
  await publishing; assert.equal(coordinator.activeCount, 0);
  const gate = deferred(), restoring = coordinator.withExclusive(() => gate.promise);
  assert.throws(() => providers.update(provider.id, { enabled: false }), { code: "CONFIG_BUSY" });
  await assert.rejects(library.create({ ...definition, id: "blocked" }), { code: "CONFIG_BUSY" });
  gate.resolve(); await restoring;
  await assert.rejects(library.publish("missing", { expectedRevision: 0, requestId: "bad" }));
  assert.equal(coordinator.activeCount, 0);
});

test("queued script tests retain activity before runner start and release on cancellation or completion", async t => {
  const { store } = setup(t), coordinator = configCoordinator(store); t.after(() => store.close());
  await new ScriptLibrary(store).create(definition);
  const runner = new ScriptTestRunner(store, false); t.after(() => runner.close());
  const queued = store.createScriptTest(definition.id, null, 0, {});
  assert.equal(coordinator.activeCount, 1);
  assert.throws(() => coordinator.withExclusive(() => {}), { code: "CONFIG_BUSY" });
  runner.cancel(queued.id);
  assert.equal(coordinator.activeCount, 0);
  const next = store.createScriptTest(definition.id, null, 0, { ok: true });
  runner.start(); runner.enqueue(next.id);
  await until(() => store.scriptTest(next.id).status === "succeeded");
  assert.equal(coordinator.activeCount, 0);
  coordinator.withExclusive(() => {});
});

test("workflow queue holds restore barrier from acceptance through execution", async t => {
  const { store, providers, authoring, provider } = setup(t); t.after(() => store.close());
  const version = await publishExample(authoring), coordinator = configCoordinator(store), gate = deferred();
  const runner = new GraphRunner(store, providers, undefined, false); t.after(() => runner.close());
  const cancelled = runner.create(version.id, {}, "cancel");
  assert.throws(() => coordinator.withExclusive(() => {}), { code: "CONFIG_BUSY" });
  runner.cancel(cancelled.id); assert.equal(coordinator.activeCount, 0);
  coordinator.withRead(() => assert.throws(() => runner.create(version.id, {}, "read-blocked"), { code: "CONFIG_BUSY" }));
  assert.equal(store.runs().length, 1);
  provider.handler = async request => { await gate.promise; return { providerId: provider.id, modelId: request.modelId, output: { action: "skip" } }; };
  const run = runner.create(version.id, {}, "execute"); runner.start();
  await until(() => provider.calls.length > 0);
  assert.throws(() => coordinator.withExclusive(() => {}), { code: "CONFIG_BUSY" });
  gate.resolve(); await until(() => store.run(run.id).status === "succeeded" && coordinator.activeCount === 0);
});

test("Agent generation remains active after acceptance returns and final proposal application advances generation", async t => {
  const { store, providers, provider, authoring } = setup(t); t.after(() => store.close());
  const coordinator = configCoordinator(store), gate = deferred();
  const draft = await authoring.create(undefined, "draft");
  provider.handler = async request => { await gate.promise; return { providerId: provider.id, modelId: request.modelId, output: { summary: "unchanged", changes: [] } }; };
  const turn = await authoring.start(draft.id, { prompt: "inspect", expectedRevision: 0, requestId: "turn", providerId: provider.id });
  assert.ok(coordinator.activeCount > 0);
  assert.throws(() => coordinator.withExclusive(() => {}), { code: "CONFIG_BUSY" });
  gate.resolve(); await authoring.wait(turn.id); assert.equal(coordinator.activeCount, 0);
  const library = new ScriptLibrary(store); await library.create(definition);
  const agent = new ScriptAgentService(store, providers);
  t.after(() => agent.close());
  const scriptGate = deferred();
  provider.handler = async request => { await scriptGate.promise; return { providerId: provider.id, modelId: request.modelId, output: { summary: "rename", changes: [], metadata: { name: "Renamed" } } }; };
  const scriptTurn = agent.start(definition.id, { prompt: "rename", expectedRevision: 0, requestId: "script-turn", providerId: provider.id });
  assert.throws(() => coordinator.withExclusive(() => {}), { code: "CONFIG_BUSY" });
  scriptGate.resolve(); await until(() => agent.get(definition.id, scriptTurn.id).status === "succeeded" && coordinator.activeCount === 0);
  const before = coordinator.generation;
  await agent.apply(definition.id, { turnId: scriptTurn.id, expectedRevision: 0, requestId: "apply" });
  assert.ok(coordinator.generation > before); assert.equal(coordinator.activeCount, 0);
});

test("Bridge shared coordinator covers tool lifetime and reload clears restored connection state", async t => {
  const { root, store } = setup(t); t.after(() => store.close());
  const coordinator = configCoordinator(store), config = new WebBridgeConfig(root, coordinator);
  config.saveApplication({ id: "coord", name: "Coord" });
  config.saveEnvironment("coord", { id: "env", origin: "https://example.com", bound: true, tabAvailable: true });
  config.saveTool({ application: "coord", toolId: "read", site: "example.com", description: "Read", path: "/read", method: "GET", timeoutMs: 1000, risk: "read", approval: "none", parameters: { type: "object" }, fields: [], catalogVersion: "1" });
  const gate = deferred(), client = new WebBridgeClient(join(root, "unused.sock"), "");
  client.call = async () => { await gate.promise; return {}; };
  let disconnected = 0;
  client.close = () => { disconnected++; };
  const bridge = new WebBridgeGateway(client, config);
  bridge.registerProfile({ id: "profile", name: "Profile", extensionId: "extension" });
  const pending = bridge.call("coord", "read", {});
  assert.throws(() => coordinator.withExclusive(() => {}), { code: "CONFIG_BUSY" });
  gate.resolve(); await pending; assert.equal(coordinator.activeCount, 0);
  const path = join(root, "config/web-bridge.json"), restored = JSON.parse(readFileSync(path, "utf8"));
  restored.applications.coord.name = "Restored"; writeFileSync(path, JSON.stringify(restored));
  coordinator.withExclusive(() => bridge.reloadAfterRestore());
  assert.equal(config.application("coord")!.name, "Restored");
  assert.equal(config.environments("coord")[0]!.bound, false);
  assert.equal(config.environments("coord")[0]!.tabAvailable, false);
  assert.deepEqual(bridge.profilesList(), []);
  assert.equal(disconnected, 1);
});
