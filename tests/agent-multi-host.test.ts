import assert from "node:assert/strict";
import { test } from "node:test";
import { MultiProviderHost, type MultiProvider } from "../src/agent/multi-provider-host.js";
import { REQUIRED_MULTI_CAPABILITIES, type ProviderSessionReference } from "../src/agent/provider-contract.js";
import { AgentRuntime } from "../src/agent/runtime.js";
import { ConversationLocks } from "../src/agent/locks.js";
import { knowledgeFixture, knowledgeSignal as signal } from "./knowledge-fixtures.js";

test("maintenance runtime reopens the exact native reference and rejects unverified Provider versions", async t => {
  const { store, service } = knowledgeFixture(t);
  const { hash } = await service.initialize(signal());
  const profile = await service.withWorkspace("workflow", hash, signal(), async lease => lease);
  const { conversation } = store.create("actor", "create", {
    scenario: "workflow", ownerType: "draft", ownerId: "draft", ownerScope: {}, mode: "multi",
    providerId: "third-provider", modelId: "model", knowledgeHash: hash, workspaceId: "maintenance",
    contractVersion: profile.contractVersion, toolPolicyVersion: profile.toolPolicyVersion,
  });
  const reference: ProviderSessionReference = { providerId: conversation.provider_id, version: 1, opaque: "native-thread" };
  let opens = 0, closes = 0, alternate = false;
  const provider: MultiProvider = {
    installedVersion: "fixture-v1",
    report: {
      providerId: reference.providerId, installedVersion: "fixture-v1",
      capabilities: Object.fromEntries(REQUIRED_MULTI_CAPABILITIES.map(name => [name, { status: "verified", evidence: "test fixture" }])),
    },
    validator: { providerId: reference.providerId, supportedVersions: [1], validatePayload() {} },
    async open(_, workspace, resume) {
      assert.equal(workspace.cwd, profile.cwd);
      assert.deepEqual(resume, opens++ === 0 ? undefined : reference);
      return {
        reference: alternate ? { ...reference, opaque: "unexpected-thread" } : reference,
        fingerprint: "a".repeat(64),
        async send({ accepted }) { accepted(); return {}; },
        async close() { closes++; },
      };
    },
  };
  const host = new MultiProviderHost(service, async () => {}, () => "workflow", async () => provider);
  const runtime = new AgentRuntime(store, new ConversationLocks(), host);
  const run = async (requestId: string) => {
    const { turn } = await runtime.submit("actor", conversation.id, { requestId, requestHash: "b".repeat(64) }, signal());
    return runtime.wait("actor", turn.id);
  };
  assert.equal((await run("first")).status, "succeeded");
  assert.equal((await run("second")).generation, 2);
  assert.equal(store.backend("actor", conversation.id)?.generation, 2);
  assert.equal(closes, 2);
  alternate = true;
  assert.equal(JSON.parse((await run("wrong-target")).error_json!).code, "BACKEND_BINDING_CONFLICT");
  assert.equal(store.backend("actor", conversation.id)?.generation, 2);
  assert.equal(closes, 3);
  provider.installedVersion = "fixture-v2";
  assert.equal(JSON.parse((await run("unverified-version")).error_json!).code, "MULTI_CAPABILITY_UNAVAILABLE");
  assert.equal(opens, 3);
});

test("Codex native protocol adapter runs and resumes two maintenance turns through the Runtime", async t => {
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { codexNativeAdapter } = await import("../src/providers/codex-app-server.js");
  const { SessionManager } = await import("../src/providers/session-manager.js");
  const { ManagedSessionStore } = await import("../src/providers/managed-session-store.js");
  const { nativeMultiProvider, codexReferenceCodec } = await import("../src/agent/native-multi-provider.js");
  const { installFixture } = await import("./agent-fixtures.js");
  const { store, service, db, root } = knowledgeFixture(t);
  const { hash } = await service.initialize(signal());
  const profile = await service.withWorkspace("workflow", hash, signal(), async lease => lease);
  const { executable } = installFixture(t, "codex-server.mjs", "default");
  const providerId = "codex-cli";
  db.prepare("INSERT INTO provider_settings VALUES(?)").run(providerId);
  const { conversation } = store.create("actor", "create", {
    scenario: "workflow", ownerType: "draft", ownerId: "draft", ownerScope: {}, mode: "multi",
    providerId, modelId: "fixture/small", knowledgeHash: hash, workspaceId: "maintenance",
    contractVersion: profile.contractVersion, toolPolicyVersion: profile.toolPolicyVersion,
  });
  const storageRoot = join(root, "codex-storage");
  mkdirSync(storageRoot);
  const storage = ManagedSessionStore.initialize(storageRoot, providerId);
  const manager = new SessionManager();
  t.after(() => manager.close());
  const outputs: unknown[] = [];
  const adapter = nativeMultiProvider({
    installedVersion: "fixture-v1",
    report: {
      providerId, installedVersion: "fixture-v1",
      capabilities: Object.fromEntries(REQUIRED_MULTI_CAPABILITIES.map(name => [name, { status: "verified", evidence: "test fixture" }])),
    },
    setting: { id: providerId, enabled: true, config: { executable }, models: [], defaultModel: "fixture/small", revision: 1, updatedAt: 1 },
    provider: codexNativeAdapter(manager, manager.limits).sessionProvider,
    storage,
    codec: codexReferenceCodec(storage),
    async prepare() {
      return {
        request: { prompt: 'RETURN:{"answer":42}', schema: { type: "object" }, emit() {} },
        async proposal(result) { outputs.push(result.output); return {}; },
      };
    },
  });
  const host = new MultiProviderHost(service, async () => {}, () => "workflow", async () => adapter);
  for (const requestId of ["first", "second"]) {
    const runtime = new AgentRuntime(store, new ConversationLocks(), host);
    const { turn } = await runtime.submit("actor", conversation.id, { requestId, requestHash: "b".repeat(64) }, AbortSignal.timeout(10_000));
    const result = await runtime.wait("actor", turn.id);
    assert.equal(result.status, "succeeded", result.error_json ?? "Codex turn failed");
  }
  assert.deepEqual(outputs, [{ answer: 42 }, { answer: 42 }]);
  assert.equal(store.backend("actor", conversation.id)?.generation, 2);
});
