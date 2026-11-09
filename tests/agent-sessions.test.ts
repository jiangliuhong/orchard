import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/providers/session-manager.js";
import { connectionFingerprint, TOOL_POLICY_VERSION } from "../src/providers/session.js";
import type { ProviderSetting } from "../src/domain/types.js";

const signal = () => new AbortController().signal;

test("single-slot manager serves sequential acquires without deadlock", async () => {
  const manager = new SessionManager({ maxAgentProcesses: 1, queueWaitTimeoutMs: 2000 });
  try {
    const first = await manager.acquire(null, signal(), "a");
    first.finish();
    const second = await manager.acquire(null, signal(), "b");
    second.finish();
    const third = await manager.acquire(null, signal(), "c");
    third.finish();
  } finally { await manager.close(); }
});

test("waiters acquire in FIFO order as slots free up", async () => {
  const manager = new SessionManager({ maxAgentProcesses: 1, queueWaitTimeoutMs: 3000 });
  try {
    const holder = await manager.acquire(null, signal(), "holder");
    const order: string[] = [];
    const waits = ["a", "b", "c"].map(async name => {
      const slot = await manager.acquire(null, signal(), name);
      order.push(name);
      slot.finish();
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(order, []);
    holder.finish();
    await Promise.all(waits);
    assert.deepEqual(order, ["a", "b", "c"]);
  } finally { await manager.close(); }
});

test("queued waiters can cancel via signal while others proceed", async () => {
  const manager = new SessionManager({ maxAgentProcesses: 1, queueWaitTimeoutMs: 3000 });
  try {
    const holder = await manager.acquire(null, signal(), "holder");
    const cancelled = new AbortController();
    const rejected = manager.acquire(null, cancelled.signal, "cancelled").then(() => "ok", error => error);
    const proceeding = manager.acquire(null, signal(), "proceeding").then(() => "ok", error => error);
    await new Promise(resolve => setTimeout(resolve, 50));
    cancelled.abort(new Error("user cancelled"));
    const error = await rejected as Error;
    assert.match(error.message, /取消/);
    holder.finish();
    assert.equal(await proceeding, "ok");
  } finally { await manager.close(); }
});

test("queue cap rejects with AGENT_QUEUE_FULL and wait timeout with TIMEOUT", async () => {
  const manager = new SessionManager({ maxAgentProcesses: 1, maxQueuedTurns: 2, queueWaitTimeoutMs: 3000 });
  try {
    const holder = await manager.acquire(null, signal(), "holder");
    const first = manager.acquire(null, signal(), "w1");
    const second = manager.acquire(null, signal(), "w2");
    await assert.rejects(manager.acquire(null, signal(), "w3"), { code: "AGENT_QUEUE_FULL" });
    holder.finish();
    (await first).finish();
    (await second).finish();
  } finally { await manager.close(); }
  const slow = new SessionManager({ maxAgentProcesses: 1, queueWaitTimeoutMs: 60 });
  try {
    const holder = await slow.acquire(null, signal(), "holder");
    await assert.rejects(slow.acquire(null, signal(), "waiter"), { code: "TIMEOUT" });
    holder.finish();
  } finally { await slow.close(); }
});

test("acquiring a busy slot recycles the longest-idle entry first instead of waiting", async () => {
  const manager = new SessionManager({ maxAgentProcesses: 2, queueWaitTimeoutMs: 2000 });
  let oldestClosed = 0, newestClosed = 0;
  try {
    const oldSlot = await manager.acquire("old", signal(), "old");
    oldSlot.register(async () => { oldestClosed++; });
    oldSlot.finish(); // 转为空闲
    await new Promise(resolve => setTimeout(resolve, 30));
    const newSlot = await manager.acquire("new", signal(), "new");
    newSlot.register(async () => { newestClosed++; });
    newSlot.finish();
    // 容量已满（两个空闲连接）；新的匿名需求应立即回收最久空闲的 old。
    const urgent = await manager.acquire(null, signal(), "urgent");
    assert.equal(oldestClosed, 1);
    assert.equal(newestClosed, 0);
    assert.equal(manager.isCurrent("old", oldSlot.generation), false);
    assert.equal(manager.isCurrent("new", newSlot.generation), true);
    urgent.finish();
  } finally { await manager.close(); }
});

test("busy entries are never recycled and block new acquisitions until freed", async () => {
  const manager = new SessionManager({ maxAgentProcesses: 1, queueWaitTimeoutMs: 2000 });
  try {
    const busy = await manager.acquire("busy", signal(), "busy");
    busy.register(async () => {});
    // 不 finish：连接处于忙碌状态；另一请求排队等待，不能抢占。
    const pending = manager.acquire(null, signal(), "waiting").then(() => "ok");
    const immediate = await Promise.race([pending.then(() => "done"), new Promise(resolve => setTimeout(() => resolve("still-waiting"), 100))]);
    assert.equal(immediate, "still-waiting");
    busy.finish(); // 释放为空闲后，等待者通过回收获得容量
    assert.equal(await pending, "ok");
  } finally { await manager.close(); }
});

test("generations increment per new process and stale callbacks are rejected", async () => {
  const manager = new SessionManager({ maxAgentProcesses: 1, queueWaitTimeoutMs: 2000 });
  try {
    const first = await manager.acquire("key", signal(), "first");
    first.register(async () => {});
    first.finish();
    const generationOne = first.generation;
    await manager.closeSession("key");
    const second = await manager.acquire("key", signal(), "second");
    second.register(async () => {});
    assert.equal(second.generation, generationOne + 1);
    assert.equal(manager.isCurrent("key", generationOne), false);
    assert.equal(manager.isCurrent("key", second.generation), true);
    second.finish();
  } finally { await manager.close(); }
});

test("idle entries are recycled after idleTtl by the sweeper", async () => {
  let closed = 0;
  const manager = new SessionManager({ maxAgentProcesses: 1, idleTtlMs: 80, queueWaitTimeoutMs: 2000 });
  try {
    const slot = await manager.acquire("ttl", signal(), "ttl");
    slot.register(async () => { closed++; });
    slot.finish();
    assert.equal(closed, 0);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(closed, 1);
    assert.equal(manager.isCurrent("ttl", slot.generation), false);
  } finally { await manager.close(); }
});

test("close rejects queued waiters, closes entries and tolerates close failures", async () => {
  let closed = 0;
  const manager = new SessionManager({ maxAgentProcesses: 1, queueWaitTimeoutMs: 2000 });
  const holder = await manager.acquire("keep", signal(), "keep");
  holder.register(async () => { closed++; });
  const waiter = manager.acquire(null, signal(), "waiter");
  await manager.close();
  await assert.rejects(waiter, /取消|关闭/);
  assert.equal(closed, 1);
  await assert.rejects(manager.acquire(null, signal(), "after"), /已关闭/);
  // 二次 close 幂等。
  await manager.close();
});

test("native single turns release the only scheduler slot for the next call", async t => {
  const { setup } = await import("./helpers.js");
  const { installFixture } = await import("./agent-fixtures.js");
  const { CliProvider, ProviderRegistry } = await import("../src/providers/registry.js");
  const { codexNativeAdapter } = await import("../src/providers/codex-app-server.js");
  const { store } = setup(t);
  t.after(() => store.close());
  const manager = new SessionManager({ maxAgentProcesses: 1, queueWaitTimeoutMs: 5000 });
  t.after(() => manager.close());
  const { executable } = installFixture(t, "codex-server.mjs", "default");
  const registry = new ProviderRegistry(store).register(new CliProvider("codex-cli", {
    native: codexNativeAdapter(manager, manager.limits),
  }), executable);
  registry.update("codex-cli", { enabled: true, defaultModel: "test-model" });
  await registry.detect("codex-cli");
  const first = registry.run({ providerId: "codex-cli" }, { cwd: store.root, prompt: "RETURN:done", signal: signal(), emit: () => {} });
  const second = registry.run({ providerId: "codex-cli" }, { cwd: store.root, prompt: "RETURN:done", signal: signal(), emit: () => {} });
  assert.equal((await first).output, "done");
  assert.equal((await second).output, "done");
});

test("connection fingerprints distinguish transport, executable and policy without leaking config", () => {
  const base: ProviderSetting = {
    id: "codex-cli", enabled: true, config: { executable: "/usr/local/bin/codex", transport: "native" },
    models: [], defaultModel: "", revision: 3, updatedAt: 0,
  };
  const fingerprint = connectionFingerprint(base);
  assert.equal(fingerprint, connectionFingerprint({ ...base, revision: 9, models: [{ id: "m", name: "m", source: "configured" }] }));
  assert.throws(() => connectionFingerprint({ ...base, config: { ...base.config, transport: "legacy" } }), { code: "PROTOCOL_UNSUPPORTED" });
  assert.notEqual(fingerprint, connectionFingerprint({ ...base, config: { executable: "/opt/other/codex", transport: "native" } }));
  assert.notEqual(fingerprint, connectionFingerprint({ ...base, id: "pi-cli" }));
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(TOOL_POLICY_VERSION.length > 0);
});
