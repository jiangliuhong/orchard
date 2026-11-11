import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiRpcProvider } from "../src/providers/pi-rpc.js";
import { SessionManager } from "../src/providers/session-manager.js";
import { ManagedSessionStore } from "../src/providers/managed-session-store.js";
import type { ProviderSetting } from "../src/domain/types.js";
import { validateWorkflow } from "../src/domain/validation.js";
import { AgentStore } from "../src/agent/store.js";
import { HostFeedbackDispatcher } from "../src/agent/feedback.js";
import { AgentModelControl, type ModelControlHost } from "../src/agent/model-control.js";
import { DEFINITION_FILE, PlatformQueryGateway, assertQuerySafe, type PlatformQueryHost, type QueryContext } from "../src/agent/query-gateway.js";
import { AssetQueryHost } from "../src/agent/asset-query-host.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { executionFixture } from "./agent-execution-fixtures.js";
import { installFixture } from "./agent-fixtures.js";
import { exampleFiles, setup } from "./helpers.js";
const signal = () => new AbortController().signal;

test("Pi failed initialization removes only its own stopped empty directory, allowing retry", async t => {
  const f = installFixture(t, "pi-server.mjs", "managed-missing-path"), root = realpathSync(f.root), storage = join(root, "storage");
  mkdirSync(storage); ManagedSessionStore.initialize(storage, "pi-cli");
  const manager = new SessionManager(); t.after(() => manager.close());
  const provider = new PiRpcProvider(manager, manager.limits);
  const setting: ProviderSetting = { id: "pi-cli", enabled: true, config: { executable: f.executable }, models: [], defaultModel: "model", revision: 1, updatedAt: 1 };
  const request = { key: "conversation", cwd: root, modelId: "model", persistent: true, managedStorageRoot: storage, signal: signal() };
  await assert.rejects(provider.openSession(setting, request), { code: "BACKEND_BINDING_CONFLICT" });
  assert.equal(existsSync(join(storage, request.key)), false);
  process.env.PI_FIXTURE_SCENARIO = "managed-native";
  const handle = await provider.openSession(setting, request);
  assert.equal(handle.ref?.kind, "pi");
  await provider.releaseSession(handle);
  // A successful open is not cleanup authority, even while its session file is still lazy.
  assert.equal(existsSync(join(storage, request.key)), true);
  await assert.rejects(provider.openSession(setting, request), { code: "EEXIST" });
  const unknown = join(storage, "unknown"); mkdirSync(unknown); writeFileSync(join(unknown, "keep"), "unowned");
  await assert.rejects(provider.openSession(setting, { ...request, key: "unknown" }), { code: "EEXIST" });
  assert.equal(readFileSync(join(unknown, "keep"), "utf8"), "unowned");
});

test("Pi failed setup preserves a session file created before handshake rejection", async t => {
  const f = installFixture(t, "pi-server.mjs", "managed-changed-path"), root = realpathSync(f.root), storage = join(root, "storage");
  mkdirSync(storage); ManagedSessionStore.initialize(storage, "pi-cli");
  const directory = join(storage, "conversation");
  const manager = new SessionManager(); t.after(() => manager.close());
  const provider = new PiRpcProvider(manager, manager.limits);
  // Simulate a native persistence side effect before the initialization error is observed.
  const spawn = (provider as unknown as { spawn: (...args: unknown[]) => void }).spawn.bind(provider);
  (provider as unknown as { spawn: (...args: unknown[]) => void }).spawn = (...args) => {
    writeFileSync(join(directory, "native.jsonl"), "preserve native history");
    throw new Error("spawn failed after persistence");
  };
  const setting: ProviderSetting = { id: "pi-cli", enabled: true, config: { executable: f.executable }, models: [], defaultModel: "model", revision: 1, updatedAt: 1 };
  await assert.rejects(provider.openSession(setting, { key: "conversation", cwd: root, modelId: "model", persistent: true, managedStorageRoot: storage, signal: signal() }), /spawn failed/);
  assert.equal(readFileSync(join(directory, "native.jsonl"), "utf8"), "preserve native history");
  (provider as unknown as { spawn: (...args: unknown[]) => void }).spawn = spawn;
});

test("feedback enqueue order survives identical/backward clocks and a store restart; unknown predecessor blocks successors", async t => {
  const f = executionFixture(t); f.bind();
  let store = f.store;
  const enqueue = (eventId: string, revision: string) => store.enqueueFeedback(f.actor, f.conversation.id, { eventId, generation: 1, type: "resource_changed", payload: { revision } });
  const now = Date.now;
  try {
    Date.now = () => 1000;
    enqueue("z-first", "8");
    store.feedbackReceipt(f.actor, f.conversation.id, "z-first", { status: "unknown" });
    enqueue("a-second", "9");
    store = new AgentStore(f.db);
    Date.now = () => 1;
    enqueue("0-third", "10");
    assert.equal(enqueue("a-second", "9"), false);
  } finally { Date.now = now; }
  const rows = store.pendingFeedback(f.actor, f.conversation.id);
  assert.deepEqual(rows.map(row => row.event_id), ["z-first", "a-second", "0-third"]);
  assert.deepEqual(rows.map(row => row.created_at), [1000, 1001, 1002]);
  const delivered: string[] = [];
  let unknown = true;
  const dispatcher = new HostFeedbackDispatcher(store, f.locks, {
    async authorize() {},
    async inspect(_conversation, fact) { return unknown ? { status: "unknown" } : { status: "delivered", receipt: { eventId: fact.eventId, confirmed: true } }; },
    async deliver(_conversation, fact) { delivered.push(fact.eventId); return { eventId: fact.eventId, confirmed: true }; },
  });
  assert.deepEqual(await dispatcher.flush(f.actor, f.conversation.id, signal()), { delivered: 0, blocked: true });
  assert.deepEqual(delivered, []);
  unknown = false;
  assert.deepEqual(await dispatcher.flush(f.actor, f.conversation.id, signal()), { delivered: 3, blocked: false });
  assert.deepEqual(delivered, ["a-second", "0-third"]);
});

test("unknown model switch is inspected after target disablement, while fresh switches remain forbidden", async t => {
  const f = executionFixture(t); f.bind();
  let disabled = false, inspections = 0, switches = 0;
  const host: ModelControlHost = {
    async authorize() {},
    async validateModel() { assert.equal(disabled, false, "model disabled"); },
    async switchModel() { switches++; return { status: "unknown" }; },
    async inspect() { inspections++; return { status: "confirmed", modelId: "next" }; },
  };
  const input = { requestId: "change", expectedRevision: f.store.conversation(f.actor, f.conversation.id).revision, modelId: "next" };
  await new AgentModelControl(f.store, f.locks, host).switch(f.actor, f.conversation.id, input, signal());
  disabled = true;
  const control = new AgentModelControl(f.store, f.locks, host);
  assert.equal((await control.switch(f.actor, f.conversation.id, input, signal())).status, "succeeded");
  assert.equal(inspections, 1); assert.equal(switches, 1);
  await assert.rejects(control.switch(f.actor, f.conversation.id, { ...input, requestId: "fresh", expectedRevision: f.store.conversation(f.actor, f.conversation.id).revision }, signal()), /model disabled/);
});

test("large valid current workflow records a baseline and its entire definition is recoverable through Unicode-safe bounded pages", async t => {
  const f = executionFixture(t), turn = f.start();
  const definition = JSON.parse(exampleFiles()["workflow.json"]!);
  definition.nodes.find((node: { type: string }) => node.type === "agent").config.prompt = "😀正文".repeat(14000);
  validateWorkflow(definition);
  const snapshot = { kind: "workflow" as const, id: "draft-id", name: "Workflow", version: "draft", revision: "7", definition, files: {} };
  const host: PlatformQueryHost = {
    async authorize() {}, async current() { return snapshot; }, async get() { return snapshot; },
    async search() { return { items: [], nextCursor: null }; }, async references() { return { items: [], nextCursor: null }; },
    async selectedTest() { return null; }, assertSafe: assertQuerySafe,
  };
  const gateway = new PlatformQueryGateway(f.store, host), grant = gateway.issue({ actor: f.actor, conversationId: f.conversation.id, turnId: turn.id, generation: 1, signal: signal() });
  const metadata = await gateway.call(grant.token, "current.get", {}) as { revision: string; definitionIncluded: boolean; definitionFile: string };
  assert.equal(metadata.revision, "7"); assert.equal(metadata.definitionIncluded, false); assert.equal(metadata.definitionFile, DEFINITION_FILE);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 65536);
  f.store.recordProposalBaseline(f.actor, turn.id, "7");
  let offset: number | null = 0, text = "";
  do {
    const page = await gateway.call(grant.token, "assets.read_file", { kind: "workflow", id: "draft-id", version: "draft", path: DEFINITION_FILE, offset, maxChars: 8192 }) as { content: string; nextOffset: number | null; truncated: boolean };
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 65536);
    assert.equal(Buffer.from(page.content).toString("utf8"), page.content);
    text += page.content; offset = page.nextOffset;
    assert.equal(page.truncated, offset !== null);
  } while (offset !== null);
  assert.deepEqual(JSON.parse(text), definition);
  await assert.rejects(gateway.call(grant.token, "assets.read_file", { kind: "workflow", id: "draft-id", path: DEFINITION_FILE, offset: 0, startLine: 1 }), { code: "INVALID_REQUEST" });
});

test("incomplete unrelated drafts do not break reference queries and explicitly mark results incomplete", async t => {
  const { store, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const good = await authoring.create(undefined, "good"), bad = await authoring.create(undefined, "bad");
  const original = JSON.parse(store.files.readTree(bad.artifactPath).files["workflow.json"]!);
  await authoring.update(bad.id, 0, { "workflow.json": JSON.stringify({ id: original.id, name: "Incomplete" }) });
  const host = new AssetQueryHost(store, new WebBridgeConfig(store.root), { async authorize() {}, async selectedTest() { return null; }, knownSecrets: () => [] });
  const context = { actor: "local", turnId: "turn", generation: 1, conversation: { owner_type: "draft", owner_id: good.id, scenario: "workflow", owner_scope_json: "{}" } } as QueryContext;
  const result = await host.references(context, { kind: "workflow", id: good.id, version: `draft:${good.id}` }, undefined, 20);
  assert.deepEqual(result.items, []);
  assert.equal(result.incomplete, true); assert.equal(result.incompleteSourceCount, 1);
  assert.equal(result.incompleteSources[0]!.version, `draft:${bad.id}`);
  const invalid = await host.get(context, { kind: "workflow", id: bad.id, version: `draft:${bad.id}` });
  assert.equal(invalid.validation?.valid, false);
  // Partially edited node arrays are safe too, not just a missing nodes field.
  await authoring.update(bad.id, 1, { "workflow.json": JSON.stringify({ id: original.id, nodes: [null, { type: "script", config: {} }, { type: "web-bridge", config: null }] }) });
  assert.equal((await host.references(context, { kind: "workflow", id: good.id, version: `draft:${good.id}` }, undefined, 20)).incomplete, true);
});
