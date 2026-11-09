import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { temporary, TestProvider, TestStore } from "./helpers.js";
import { ProviderRegistry } from "../src/providers/registry.js";

test("HTTP Git workflow binds, commits, restores and delivers browser preferences through durable operations", async t => {
  const root = temporary(t), bare = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "ignore" });
  const store = new TestStore(join(root, "data"));
  const { app } = createApp(store, undefined, undefined, undefined, { testTransport: () => bare });
  t.after(() => app.close()); await app.ready();
  const request = async (path: string, payload: Record<string, unknown> = {}) => {
    const response = await app.inject({ method: "POST", url: `/api/config-git${path}`, payload: { requestId: randomUUID(), ...payload } });
    assert.ok(response.statusCode < 300, response.body);
    let result = response.json();
    if (response.statusCode === 202) {
      for (let i = 0; i < 300; i++) {
        const operation = await app.inject(result.statusUrl); const status = operation.json();
        if (status.phase === "completed") return status.result;
        assert.ok(!["failed", "recovery_required"].includes(status.phase), JSON.stringify(status));
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("operation timed out");
    }
    return result;
  };
  assert.equal((await app.inject("/api/config-git/repository")).json().binding, null);
  await request("/bind", { remoteUrl: "https://fixture.invalid/config.git", branch: "main", identity: { name: "Fixture", email: "fixture@example.invalid" } });
  const bundle = await request("/export", { theme: "dark" });
  assert.equal(bundle.snapshot.general.theme, "dark");
  const preview = await request("/commit-preview", { theme: "dark", message: "First configuration", push: true, clientId: "browser", preferenceRevision: 0 });
  assert.ok(preview.token); assert.ok(preview.diffs.length);
  const invalidMessageRequest = await app.inject({ method: "POST", url: "/api/config-git/generate-message", payload: {} });
  assert.equal(invalidMessageRequest.statusCode, 400);
  const missingPreview = await app.inject({ method: "POST", url: "/api/config-git/generate-message", payload: { token: "expired-token" } });
  assert.equal(missingPreview.statusCode, 409);
  const committed = await request("/commit", { token: preview.token, theme: "dark", clientId: "browser", preferenceRevision: 0 });
  assert.equal(committed.pushed, true);
  const history = (await app.inject("/api/config-git/commits?source=remote")).json();
  assert.equal(history.items[0].sha, committed.sha);
  await request("/export", { theme: "light" });
  const plan = await request("/restore-preview", { source: { kind: "git", sha: committed.sha }, categories: ["general"], clientId: "browser", preferenceRevision: 1, theme: "light" });
  const restored = await request("/restore", { token: plan.token });
  assert.equal(restored.phase, "completed");
  assert.equal((await app.inject("/api/config-git/general/pending?clientId=other")).json().items.length, 0);
  const pending = (await app.inject("/api/config-git/general/pending?clientId=browser")).json().items[0];
  assert.equal(pending.theme, "dark");
  const mismatch = await app.inject({ method: "POST", url: "/api/config-git/general/ack", payload: { clientId: "browser", operationId: pending.operationId, preferenceRevision: 2, decision: "apply" } });
  assert.equal(mismatch.statusCode, 409);
  await request("/general/ack", { clientId: "browser", operationId: pending.operationId, preferenceRevision: 2, decision: "keep" });
  assert.equal((await app.inject("/api/config-git/general/pending?clientId=browser")).json().items.length, 0);
  const claim = await request("/general/claim", { clientId: "new-browser", preferenceRevision: 0 });
  assert.equal(claim.requiresConfirmation, true);
  assert.equal((await app.inject("/api/config-git/recovery-points")).json().items.length, 1);
});

test("description generation persists its named Agent setting and uses its explicit model", async t => {
  const root = temporary(t), store = new TestStore(join(root, "data"));
  const providers = new ProviderRegistry(store).register(new TestProvider("codex-cli"), process.execPath);
  providers.update("codex-cli", { enabled: true, defaultModel: "test-model", models: [{ id: "test-model", name: "Test", source: "configured" }] });
  const modelConfig = providers.modelConfigs.create({ name: "提交说明助手", providerId: "codex-cli", modelId: "test-model", requestId: randomUUID() });
  const bare = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "ignore" });
  let app = createApp(store, providers, undefined, undefined, { testTransport: () => bare }).app;
  t.after(() => app.close());
  await app.ready();
  const endpoint = "/api/config-git/message-agent";
  assert.deepEqual((await app.inject(endpoint)).json(), { agentConfigId: null, available: false });
  const invalid = await app.inject({ method: "PUT", url: endpoint, payload: { agentConfigId: "missing" } });
  assert.equal(invalid.statusCode, 404);
  const saved = await app.inject({ method: "PUT", url: endpoint, payload: { agentConfigId: modelConfig.id } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().modelId, "test-model");
  assert.equal(saved.json().available, true);

  await app.close();
  const reopened = new TestStore(store.root), adapter = new TestProvider("codex-cli");
  adapter.handler = async request => ({ output: "更新配置备份", providerId: adapter.id, modelId: request.modelId });
  const registry = new ProviderRegistry(reopened).register(adapter, process.execPath);
  registry.update(adapter.id, { defaultModel: "different-default", models: [{ id: "test-model", name: "Configured", source: "configured" }, { id: "different-default", name: "Default", source: "configured" }] });
  app = createApp(reopened, registry, undefined, undefined, { testTransport: () => bare }).app;
  await app.ready();
  assert.equal((await app.inject(endpoint)).json().agentConfigId, modelConfig.id);
  const operation = async (path: string, payload: Record<string, unknown>) => {
    const accepted = await app.inject({ method: "POST", url: `/api/config-git/${path}`, payload: { ...payload, requestId: randomUUID() } });
    assert.equal(accepted.statusCode, 202, accepted.body);
    for (let i = 0; i < 300; i++) {
      const state = (await app.inject(accepted.json().statusUrl)).json();
      if (state.phase === "completed") return state.result;
      assert.ok(!["failed", "recovery_required"].includes(state.phase), JSON.stringify(state));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("operation timed out");
  };
  await operation("bind", { remoteUrl: "https://fixture.invalid/config.git", branch: "main", identity: { name: "Fixture", email: "fixture@example.invalid" } });
  const preview = await operation("commit-preview", { message: "备份配置", theme: "light", push: true });
  const generated = await app.inject({ method: "POST", url: "/api/config-git/generate-message", payload: { token: preview.token } });
  assert.equal(generated.statusCode, 200, generated.body);
  assert.equal(generated.json().message, "更新配置备份");
  assert.equal(adapter.calls.at(-1)?.modelId, "test-model");
  assert.equal(adapter.calls.length, 1);
  const override = await app.inject({ method: "POST", url: "/api/config-git/generate-message", payload: { token: preview.token, providerId: adapter.id } });
  assert.equal(override.statusCode, 400);
  registry.modelConfigs.update(modelConfig.id, { enabled: false, expectedRevision: 1, requestId: randomUUID() });
  assert.equal((await app.inject(endpoint)).json().available, false);
  const disabled = await app.inject({ method: "POST", url: "/api/config-git/generate-message", payload: { token: preview.token } });
  assert.equal(disabled.json().code, "MESSAGE_AGENT_UNAVAILABLE");
  const disabledSave = await app.inject({ method: "PUT", url: endpoint, payload: { agentConfigId: modelConfig.id } });
  assert.equal(disabledSave.statusCode, 409);
  await app.inject({ method: "PUT", url: endpoint, payload: { agentConfigId: null } });
  const unset = await app.inject({ method: "POST", url: "/api/config-git/generate-message", payload: { token: preview.token } });
  assert.equal(unset.json().code, "MESSAGE_AGENT_REQUIRED");
  assert.equal(adapter.calls.length, 1);
});
