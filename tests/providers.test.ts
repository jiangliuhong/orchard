import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setup, until } from "./helpers.js";
import { CliProvider, type ProviderEvent } from "../src/providers/registry.js";

test("both CLI adapters validate real process framing, final JSON, metadata and failure", async t => {
  const { root, store, providers } = setup(t); t.after(() => store.close());
  const executable = join(root, "agent");
  copyFileSync(fileURLToPath(new URL("./fixtures/agent.mjs", import.meta.url)), executable); chmodSync(executable, 0o755);
  for (const id of ["codex-cli", "pi-cli"] as const) {
    providers.register(new CliProvider(id), executable);
    assert.equal(providers.views().find(p => p.id === id)!.enabled, false);
    providers.update(id, { enabled: true, defaultModel: "fixture/small" });
    assert.equal((await providers.detect(id)).state, "ready");
    const events: ProviderEvent[] = [], controller = new AbortController();
    const result = await providers.run({ providerId: id, modelId: "fixture/small" }, { cwd: root, prompt: 'RETURN:{"answer":42}', schema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } }, signal: controller.signal, emit: e => events.push(e) });
    assert.deepEqual(result.output, { answer: 42 }); assert.ok(result.usage);
    if (id === "pi-cli") assert.ok(events.some(e => e.type === "provider.text" && (e.payload as { text: string }).text === "hello\u2028world"));
    await assert.rejects(providers.run({ providerId: id }, { cwd: root, prompt: "FAIL", signal: controller.signal, emit: () => {} }), /authentication/);
    await assert.rejects(providers.run({ providerId: id }, { cwd: root, prompt: "RETURN:not json", schema: true, signal: controller.signal, emit: () => {} }), /JSON/);
    await assert.rejects(providers.run({ providerId: id }, { cwd: root, prompt: "LARGE-FINAL", signal: controller.signal, emit: () => {} }), { code: "OUTPUT_LIMIT" });
    const pending = providers.run({ providerId: id }, { cwd: root, prompt: "HANG", signal: controller.signal, emit: () => {} });
    setTimeout(() => controller.abort(), 60); await assert.rejects(pending);
  }
  const catalog = await providers.models("pi-cli"); assert.equal(catalog.models[0]!.id, "fixture/small");
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
    async turn(_setting, request) { return { providerId: "future-provider", modelId: request.modelId, output: true }; },
  });
  providers.update("future-provider", { enabled: true, config: { endpoint: "another-test" }, defaultModel: "explicit" });
  assert.deepEqual(providers.setting("future-provider").config, { endpoint: "another-test" });
  assert.throws(() => providers.update("future-provider", { config: { executable: "/wrong" } }));
});
test("both CLI adapters can continue application authoring history without native sessions", async t => {
  const { root, store, providers, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const executable = join(root, "author-agent");
  copyFileSync(fileURLToPath(new URL("./fixtures/agent.mjs", import.meta.url)), executable); chmodSync(executable, 0o755);
  for (const id of ["codex-cli", "pi-cli"] as const) {
    providers.register(new CliProvider(id), executable); providers.update(id, { enabled: true, defaultModel: "fixture/small" });
    const draft = await authoring.create(undefined, `draft-${id}`);
    for (let index = 0; index < 2; index++) {
      const source = JSON.parse(authoring.snapshot(draft.id).files["workflow.json"]!);
      source.name = `CLI draft ${index}`;
      const response = { summary: `updated ${index}`, changes: [{ operation: "update", path: "workflow.json", content: JSON.stringify(source) }] };
      const turn = await authoring.start(draft.id, { providerId: id, modelId: "fixture/small", prompt: `RETURN:${JSON.stringify(response)}`, expectedRevision: index, requestId: `${id}-${index}` });
      await authoring.wait(turn.id);
      assert.equal(store.turn(turn.id).status, "succeeded", JSON.stringify(store.turn(turn.id).error));
    }
    assert.equal(authoring.snapshot(draft.id).messages.length, 4);
    assert.equal(store.draft(draft.id).revision, 2);
  }
});
