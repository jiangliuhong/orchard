import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntime } from "../src/agent/runtime.js";
import { MultiProviderHost } from "../src/agent/multi-provider-host.js";
import { piReferenceCodec, nativeMultiProvider } from "../src/agent/native-multi-provider.js";
import { REQUIRED_MULTI_CAPABILITIES, validateSessionReference } from "../src/agent/provider-contract.js";
import { ConversationLocks } from "../src/agent/locks.js";
import { ManagedSessionStore } from "../src/providers/managed-session-store.js";
import { PiSessionLifecycle } from "../src/providers/pi-session-lifecycle.js";
import { piNativeAdapter } from "../src/providers/pi-rpc.js";
import { SessionManager } from "../src/providers/session-manager.js";
import { installFixture, readLog } from "./agent-fixtures.js";
import { knowledgeFixture, knowledgeSignal } from "./knowledge-fixtures.js";

async function fixture(t: TestContext, scenario = "managed-native") {
  const f = knowledgeFixture(t), { hash } = await f.service.initialize(knowledgeSignal());
  const profile = await f.service.withWorkspace("script", hash, knowledgeSignal(), async lease => lease);
  const { executable, logPath } = installFixture(t, "pi-server.mjs", scenario);
  f.db.prepare("INSERT INTO provider_settings VALUES('pi-cli')").run();
  const conversation = f.store.create("actor", "create", { scenario: "script", ownerType: "script", ownerId: "script-id", ownerScope: {}, mode: "multi", providerId: "pi-cli", modelId: "fixture/model", knowledgeHash: hash, workspaceId: "maintenance", contractVersion: profile.contractVersion, toolPolicyVersion: profile.toolPolicyVersion }).conversation;
  const root = join(f.root, "pi-storage"); mkdirSync(root);
  const storage = ManagedSessionStore.initialize(root, "pi-cli"), codec = piReferenceCodec(storage);
  const manager = new SessionManager(); t.after(() => manager.close());
  const outputs: unknown[] = [];
  const provider = nativeMultiProvider({
    installedVersion: "test-protocol-only", report: { providerId: "pi-cli", installedVersion: "test-protocol-only", capabilities: Object.fromEntries(REQUIRED_MULTI_CAPABILITIES.map(name => [name, { status: "verified", evidence: "synthetic fixture only, NOT production evidence" }])) },
    setting: { id: "pi-cli", config: { executable }, enabled: true, models: [], defaultModel: "fixture/model", revision: 1, updatedAt: 1 },
    provider: piNativeAdapter(manager, manager.limits).sessionProvider, storage, codec,
    async prepare() { return { request: { prompt: "only the new message", schema: { type: "object" }, emit() {} }, async proposal(result) { outputs.push(result.output); return {}; } }; },
  });
  const host = new MultiProviderHost(f.service, async () => {}, () => "script", async () => provider);
  const run = async (requestId: string) => {
    const runtime = new AgentRuntime(f.store, new ConversationLocks(), host);
    const { turn } = await runtime.submit("actor", conversation.id, { requestId, requestHash: "a".repeat(64) }, AbortSignal.timeout(10000));
    return runtime.wait("actor", turn.id);
  };
  return { ...f, root, storage, codec, conversation, outputs, run, logPath };
}

test("Pi persists the exact declared lazy path, resumes a second native turn and uses the same deletion reference", async t => {
  const f = await fixture(t);
  assert.equal((await f.run("first")).status, "succeeded");
  const first = JSON.parse(f.store.backend("actor", f.conversation.id)!.reference_json);
  assert.match(first.opaque.file, /2026-11-11T00-00-00_/);
  assert.equal((await f.run("second")).status, "succeeded");
  assert.deepEqual(JSON.parse(f.store.backend("actor", f.conversation.id)!.reference_json), first);
  assert.deepEqual(f.outputs.map((value: any) => value.promptCount), [1, 2]);
  const log = readLog(f.logPath);
  const prompts = log.lines.map(line => JSON.parse(line)).filter(value => value.type === "prompt");
  assert.deepEqual(prompts.map(value => value.message), ["only the new message", "only the new message"]);
  const native = f.codec.decode(first, f.storage, f.workspace);
  assert.equal(native.kind, "pi");
  if (native.kind === "pi") assert.equal(readFileSync(native.sessionFile, "utf8").trim().split("\n").length, 3);
  const lifecycle = new PiSessionLifecycle(f.root, { async withStoppedSession(_ref, _signal, action) { return action(); } });
  assert.deepEqual(await lifecycle.inspect(first, knowledgeSignal()), { status: "present" });
  assert.deepEqual(await lifecycle.deleteSession(first, knowledgeSignal()), { status: "deleted" });
  assert.deepEqual(await lifecycle.inspect(first, knowledgeSignal()), { status: "absent" });
});

test("Pi rejects missing or changed native paths instead of persisting invented references", async t => {
  for (const scenario of ["managed-missing-path", "managed-changed-path"]) await t.test(scenario, async t => {
    const f = await fixture(t, scenario), result = await f.run("first");
    assert.equal(result.status, "failed");
    assert.equal(JSON.parse(result.error_json!).code, "BACKEND_BINDING_CONFLICT");
    assert.equal(f.outputs.length, 0);
    if (scenario === "managed-missing-path") assert.equal(f.store.backend("actor", f.conversation.id), undefined);
  });
});

test("Pi opaque codec rejects path traversal, store substitution, unknown versions and different cwd", async t => {
  const f = await fixture(t);
  await f.run("first");
  const reference = JSON.parse(f.store.backend("actor", f.conversation.id)!.reference_json);
  for (const file of ["../outside.jsonl", "/absolute.jsonl", "dir/../file.jsonl", "dir\\file.jsonl"])
    assert.throws(() => validateSessionReference({ ...reference, opaque: { ...reference.opaque, file } }, f.codec), { code: "BACKEND_REFERENCE_INVALID" });
  assert.throws(() => validateSessionReference({ ...reference, version: 99 }, f.codec), { code: "BACKEND_REFERENCE_VERSION_UNSUPPORTED" });
  assert.throws(() => f.codec.decode(reference, f.storage, "/different"), { code: "BACKEND_BINDING_CONFLICT" });
});
