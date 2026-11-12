import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProviderEventBatcher } from "../src/providers/event-batcher.js";
import type { ProviderEvent } from "../src/providers/registry.js";
import { installNativeHost, uninstallNativeHost, nativeHostManifest, nativeHostStatus, localServerUrl } from "../src/web-bridge/install.js";
import { runNativeHost } from "../src/web-bridge/native-host.js";
import { decodeNativeMessages, encodeNativeMessage } from "../src/web-bridge/protocol.js";
import { extensionId } from "../src/web-bridge/catalog.js";
import { WebBridgeGateway } from "../src/web-bridge/gateway.js";
import { WebBridgeClient } from "../src/web-bridge/client.js";
import { setupLegacy as setup, until } from "./helpers.js";

test("text batching preserves UTF-8 offsets, item boundaries, deadlines and terminal event ordering", async t => {
  const events: ProviderEvent[] = [], errors: unknown[] = [];
  const batch = new ProviderEventBatcher(event => events.push(event), error => errors.push(error));
  t.after(() => batch.close());
  batch.emit({ type: "provider.text", payload: { text: "中", offset: 0, itemId: "a" } });
  batch.emit({ type: "provider.text", payload: { text: "😀", offset: 3, itemId: "a" } });
  assert.equal(events.length, 0);
  await until(() => events.length === 1);
  assert.deepEqual(events[0]!.payload, { text: "中😀", offset: 0, itemId: "a" });
  batch.emit({ type: "provider.text", payload: { text: "x", offset: 7, itemId: "a" } });
  batch.emit({ type: "provider.text", payload: { text: "y", offset: 8, itemId: "b" } });
  batch.emit({ type: "provider.completed", payload: {} });
  assert.deepEqual(events.map(event => event.type), ["provider.text", "provider.text", "provider.text", "provider.completed"]);
  batch.emit({ type: "provider.text", payload: { text: "z".repeat(4096), offset: 9 } });
  assert.equal(events.length, 5);
  assert.deepEqual(errors, []);
});

test("a whole-message delta is split at UTF-8 boundaries and stays below artifact-sized SSE payloads", () => {
  const events: ProviderEvent[] = [], text = "中😀".repeat(12000);
  const batch = new ProviderEventBatcher(event => events.push(event), error => { throw error; });
  batch.emit({ type: "provider.text", payload: { text, offset: 0, itemId: "large" } }); batch.flush(); batch.close();
  let offset = 0, restored = "";
  for (const event of events) {
    const payload = event.payload as { text: string; offset: number };
    assert.equal(payload.offset, offset); assert.ok(!payload.text.includes("\uFFFD"));
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 32768);
    restored += payload.text; offset += Buffer.byteLength(payload.text);
  }
  assert.equal(restored, text); assert.equal(offset, Buffer.byteLength(text));
});

test("a timed persistence failure aborts the producer and does not escape as an uncaught timer exception", async () => {
  let failure: unknown;
  const batch = new ProviderEventBatcher(() => { throw new Error("disk failure"); }, error => { failure = error; });
  batch.emit({ type: "provider.text", payload: { text: "pending", offset: 0 } });
  await until(() => failure);
  assert.throws(() => batch.flush(), /disk failure/);
  batch.close();
});

test("Chrome Native Host installation uses a real launcher, stable identity, owned uninstall and local-only discovery", async t => {
  const root = mkdtempSync(join(tmpdir(), "orchard-host-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { home: join(root, "chrome home"), platform: "darwin", serverUrl: "http://127.0.0.1:7555" };
  const dataDir = join(root, "data ' $() space"), executable = join(root, "cli.js");
  writeFileSync(executable, "");
  const installed = installNativeHost(dataDir, executable, options);
  const manifest = JSON.parse(readFileSync(installed.manifest, "utf8"));
  assert.equal(installed.manifest, nativeHostManifest(options));
  assert.equal(manifest.path, installed.launcher);
  assert.equal(manifest.args, undefined);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.equal(statSync(installed.launcher).mode & 0o777, 0o700);
  assert.equal(statSync(installed.manifest).mode & 0o777, 0o600);
  assert.deepEqual(nativeHostStatus(options), { ok: true, code: "NATIVE_HOST_INSTALLED" });
  assert.equal(installNativeHost(dataDir, executable, options).manifest, installed.manifest);
  assert.throws(() => installNativeHost(join(root, "other"), executable, options), { code: "NATIVE_HOST_CONFLICT" });
  assert.equal(existsSync(join(root, "other/runtime/native-host/orchard-host")), false);
  assert.throws(() => uninstallNativeHost(join(root, "other"), options), { code: "NATIVE_HOST_CONFLICT" });
  const responses: Uint8Array[] = [], frame = encodeNativeMessage({ id: "discover", type: "discover" });
  async function* input() { yield frame.subarray(0, 3); yield frame.subarray(3); }
  await runNativeHost(installed.serverUrl, extensionId, `chrome-extension://${extensionId}/`, input(), value => responses.push(value));
  assert.deepEqual(decodeNativeMessages(Buffer.concat(responses)).values, [{ id: "discover", result: { serverUrl: options.serverUrl } }]);
  await assert.rejects(runNativeHost(installed.serverUrl, extensionId, "chrome-extension://wrong/", input(), () => {}), { code: "INVALID_ORIGIN" });
  async function* truncated() { yield frame.subarray(0, 5); }
  await assert.rejects(runNativeHost(installed.serverUrl, extensionId, `chrome-extension://${extensionId}/`, truncated(), () => {}), { code: "INVALID_NATIVE_MESSAGE" });
  for (const url of ["https://example.test", "http://127.0.0.1@evil.test", "http://localhost/path"]) assert.throws(() => localServerUrl(url));
  assert.equal(localServerUrl("http://localhost:7555"), options.serverUrl);
  uninstallNativeHost(dataDir, options);
  assert.equal(existsSync(installed.manifest), false);
  assert.equal(existsSync(installed.launcher), false);
  assert.equal(nativeHostStatus(options).code, "NATIVE_HOST_NOT_INSTALLED");
  assert.match(nativeHostManifest({ ...options, platform: "linux" }), /\.config\/google-chrome\/NativeMessagingHosts/);
});

test("HTTP bridge status and doctor reflect registered profiles and pending calls without a Socket", async t => {
  const bridge = new WebBridgeGateway(new WebBridgeClient("/nonexistent/orchard.sock", ""));
  t.after(() => bridge.close());
  assert.equal((await bridge.status()).connected, false);
  bridge.registerProfile({ id: "browser", name: "Browser", extensionId });
  bridge.browserChannel.register("browser", extensionId);
  const pending = bridge.browserChannel.call("browser", {}, AbortSignal.timeout(2000));
  assert.equal((await bridge.status()).connected, true);
  assert.equal((await bridge.status()).pending, 1);
  const doctor = await bridge.doctor();
  assert.equal(doctor.transport, "http");
  assert.equal(doctor.checks.find(check => check.id === "browser")!.code, "BROWSER_CONNECTED");
  const [call] = bridge.browserChannel.poll("browser");
  bridge.browserChannel.complete("browser", call!.id, { ok: true });
  await pending;
  assert.equal((await bridge.status()).pending, 0);
  t.mock.method(Date, "now", () => Number.MAX_SAFE_INTEGER);
  assert.equal((await bridge.status()).connected, false);
});

test("acceptance rolls back lazy conversations when context preparation fails", async t => {
  const { store, provider, authoring } = setup(t);
  t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  const files = authoring.snapshot(draft.id).files;
  await authoring.update(draft.id, 0, { ...files, "scripts/start.ts": files["scripts/start.ts"] + "\n//" + "x".repeat(500000) });
  await assert.rejects(authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: "x".repeat(90000), expectedRevision: 1, requestId: randomUUID() }), { code: "CONTEXT_LIMIT" });
  assert.equal(store.conversations(draft.id).length, 0);
  assert.equal(store.turns(draft.id).length, 0);
  assert.equal(provider.calls.length, 0);
});

test("a delayed concurrent receipt replay never dispatches a second model call after completion", async t => {
  const { store, provider, providers, authoring } = setup(t);
  t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  const ready = providers.ready.bind(providers), gates: (() => void)[] = [];
  t.mock.method(providers, "ready", async (choice: Parameters<typeof ready>[0]) => {
    const selection = await ready(choice);
    await new Promise<void>(resolve => gates.push(resolve));
    return selection;
  });
  provider.handler = async request => ({ output: { summary: "done", changes: [] }, providerId: provider.id, modelId: request.modelId });
  const input = { providerId: provider.id, modelId: "test-model", prompt: "once", expectedRevision: 0, requestId: randomUUID() };
  const first = authoring.start(draft.id, input), replay = authoring.start(draft.id, input);
  await until(() => gates.length === 2);
  gates[0]!(); const turn = await first; await authoring.wait(turn.id);
  gates[1]!(); assert.equal((await replay).id, turn.id);
  assert.equal(provider.calls.length, 1);
  assert.equal(store.turns(draft.id).length, 1);
});

test("cancellation flushes buffered text before the unique terminal event and exposes stopping state", async t => {
  const { store, provider, authoring } = setup(t);
  t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  let release!: () => void;
  provider.handler = async request => {
    request.emit({ type: "provider.text", payload: { text: "pending", offset: 0 } });
    await new Promise<void>(resolve => { release = resolve; });
    return { output: { summary: "late", changes: [] }, providerId: provider.id, modelId: request.modelId };
  };
  const turn = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: "cancel", expectedRevision: 0, requestId: randomUUID() });
  await until(() => release);
  authoring.cancel(draft.id, turn.id);
  assert.equal(authoring.conversations.view(turn.conversationId!).connectionState, "stopping");
  release(); await authoring.wait(turn.id);
  const events = store.stream("authoring_turn", turn.id);
  const terminal = events.filter(event => /^turn\.(succeeded|failed|cancelled|interrupted)$/.test(event.type));
  assert.equal(terminal.length, 1); assert.equal(terminal[0]!.type, "turn.cancelled");
  assert.ok(events.findIndex(event => event.type === "provider.text") < events.indexOf(terminal[0]!));
});

for (const mode of ["single", "multi"] as const) test(`${mode} authoring batches persisted text and records accepted and successful revision identity`, async t => {
  const { store, provider, authoring } = setup(t);
  t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  let release!: () => void;
  let live = true;
  provider.sessionProvider.getConnectionState = () => live ? "ready" : "absent";
  provider.handler = async request => {
    for (let i = 0; i < 20; i++) request.emit({ type: "provider.text", payload: { text: "中", offset: i * 3 } });
    await new Promise<void>(resolve => { release = resolve; });
    return { output: { summary: "done", changes: [] }, providerId: provider.id, modelId: request.modelId };
  };
  const turn = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: "test", expectedRevision: 0, requestId: randomUUID(), mode });
  await until(() => release);
  const cid = turn.conversationId!;
  assert.equal(authoring.conversations.view(cid).connectionState, "ready");
  assert.equal(store.turn(turn.id).submissionState, "accepted");
  release(); await authoring.wait(turn.id);
  const events = store.stream("authoring_turn", turn.id);
  const text = events.filter(event => event.type === "provider.text");
  assert.equal(text.length, 1);
  assert.equal((text[0]!.payload as { text: string }).text, "中".repeat(20));
  assert.ok(events.indexOf(text[0]!) < events.findIndex(event => event.type === "provider.completed"));
  assert.equal(events.filter(event => event.type === "turn.succeeded").length, 1);
  assert.deepEqual(events.at(-1)!.payload, { summary: "done", validation: store.draft(draft.id).validation, conversationId: cid, appliedRevision: 0 });
  assert.equal(authoring.conversations.view(cid).connectionState, mode === "multi" ? "ready" : "absent");
  live = false;
  assert.equal(authoring.conversations.view(cid).connectionState, "absent");
  assert.equal(store.conversation(cid)!.backendRef === null, mode === "single");
});
