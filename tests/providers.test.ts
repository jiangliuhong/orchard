import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, until } from "./helpers.js";
import { CliProvider, type ProviderEvent } from "../src/providers/registry.js";
import { codexNativeAdapter } from "../src/providers/codex-app-server.js";
import { piNativeAdapter } from "../src/providers/pi-rpc.js";
import { SessionManager } from "../src/providers/session-manager.js";
import { installFixture } from "./agent-transport.test.js";

test("both CLI adapters default to native and validate final JSON without fallback", async t => {
  const { root, store, providers } = setup(t); t.after(() => store.close());
  const manager = new SessionManager();
  t.after(() => manager.close());
  for (const id of ["codex-cli", "pi-cli"] as const) {
    const { executable } = installFixture(t, id === "codex-cli" ? "codex-server.mjs" : "pi-server.mjs", "default");
    const native = id === "codex-cli" ? codexNativeAdapter(manager, manager.limits) : piNativeAdapter(manager, manager.limits);
    providers.register(new CliProvider(id, { native }), executable);
    assert.equal(providers.views().find(p => p.id === id)!.enabled, false);
    assert.equal(providers.setting(id).config.transport, "native");
    assert.throws(() => providers.update(id, { config: { transport: "legacy" } }));
    providers.update(id, { enabled: true, defaultModel: "fixture/small" });
    assert.equal((await providers.detect(id)).state, "ready");
    const events: ProviderEvent[] = [], controller = new AbortController();
    const result = await providers.run({ providerId: id, modelId: "fixture/small" }, { cwd: root, prompt: 'RETURN:{"answer":42}', schema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } }, signal: controller.signal, emit: e => events.push(e) });
    assert.deepEqual(result.output, { answer: 42 });
    assert.ok(events.some(event => event.type === "provider.started" && (event.payload as { transport: string }).transport === "native"));
    await assert.rejects(providers.run({ providerId: id }, { cwd: root, prompt: "RETURN:not json", schema: true, signal: controller.signal, emit: () => {} }), /JSON/);
  }
});
test("in-flight Provider captures configuration, future calls respect disable and model resolution", async t => {
  const { root, store, provider, providers } = setup(t); t.after(() => store.close());
  let release!: () => void;
  provider.handler = async request => { await new Promise<void>(resolve => { release = resolve; }); return { providerId: provider.id, modelId: request.modelId, output: "ok" }; };
  const pending = providers.run({ providerId: provider.id }, { cwd: root, prompt: "test", signal: new AbortController().signal, emit: () => {} });
  await until(() => !!release);
  providers.update(provider.id, { enabled: false, defaultModel: "different" });
  release(); assert.equal((await pending).modelId, "test-model");
  await assert.rejects(providers.run({ providerId: provider.id }, { cwd: root, prompt: "test", signal: new AbortController().signal, emit: () => {} }), /禁用/);
  providers.update(provider.id, { enabled: true });
  assert.deepEqual(providers.resolve({ providerId: provider.id, modelId: "fixed" }), { providerId: provider.id, modelId: "fixed" });
});
test("a future Provider owns its config schema without requiring a CLI executable", async t => {
  const { store, providers } = setup(t); t.after(() => store.close());
  providers.register({
    id: "future-provider", name: "Future", defaultConfig: { endpoint: "local-test" },
    configSchema: { type: "object", required: ["endpoint"], properties: { endpoint: { type: "string" } }, additionalProperties: false },
    capabilities: { modelCatalog: false, structuredOutput: "validated", tools: false, nativeResume: false, textStream: false },
    async detect() { return { state: "ready" }; },
    async models() { return { models: [] }; },
  });
  providers.update("future-provider", { enabled: true, config: { endpoint: "another-test" }, defaultModel: "explicit" });
  assert.deepEqual(providers.setting("future-provider").config, { endpoint: "another-test" });
  assert.throws(() => providers.update("future-provider", { config: { executable: "/wrong" } }));
  await assert.rejects(providers.run({ providerId: "future-provider" }, {
    cwd: store.root, prompt: "test", signal: new AbortController().signal, emit: () => {},
  }), { code: "PROTOCOL_UNSUPPORTED" });
});
