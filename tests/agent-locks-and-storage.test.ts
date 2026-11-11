import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AsyncReadWriteLock, ConversationLocks } from "../src/agent/locks.js";
import { BoundSessionLifecycleGuard, type LifecycleBinding, type LifecycleGuardHost } from "../src/agent/session-lifecycle-guard.js";
import { ManagedSessionStore } from "../src/providers/managed-session-store.js";
import { PiSessionLifecycle } from "../src/providers/pi-session-lifecycle.js";
import { AppError } from "../src/domain/errors.js";
import { temporary } from "./helpers.js";
const signal = () => new AbortController().signal;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("共享知识读租约并发，升级写锁等待所有读者且不被新读者饿死", async () => {
  const lock = new AsyncReadWriteLock(), first = deferred(), second = deferred();
  const order: string[] = [];
  const a = lock.read(signal(), async () => { order.push("reader-a"); await first.promise; });
  const b = lock.read(signal(), async () => { order.push("reader-b"); await second.promise; });
  await tick(); assert.deepEqual(order, ["reader-a", "reader-b"]);
  const writer = lock.write(signal(), async () => { order.push("upgrade"); });
  const later = lock.read(signal(), async () => { order.push("later-reader"); });
  first.resolve(); await a; await tick(); assert.equal(order.length, 2);
  second.resolve(); await Promise.all([b, writer, later]);
  assert.deepEqual(order, ["reader-a", "reader-b", "upgrade", "later-reader"]);
});

test("锁等待可取消、失败释放；取消持有者不能提前释放运行中的 action", async () => {
  const lock = new AsyncReadWriteLock(), hold = deferred(), controller = new AbortController();
  const first = lock.write(controller.signal, async () => { await hold.promise; });
  await tick();
  const waiting = new AbortController();
  const cancelled = lock.write(waiting.signal, async () => { assert.fail("cancelled waiter ran"); });
  waiting.abort(); await assert.rejects(cancelled);
  let nextRan = false;
  const next = lock.write(signal(), async () => { nextRan = true; throw new Error("expected"); });
  const rejection = assert.rejects(next, /expected/);
  controller.abort(); await tick(); assert.equal(nextRan, false);
  hold.resolve(); await first; await rejection;
  assert.equal(await lock.read(signal(), async () => "released"), "released");
});

test("对话操作同键串行，不同对话不被串行化；取消等待不影响其他请求", async () => {
  const locks = new ConversationLocks(), hold = deferred(), order: string[] = [];
  const first = locks.run("a", signal(), async () => { order.push("a1"); await hold.promise; });
  await tick();
  const controller = new AbortController();
  const cancelled = locks.run("a", controller.signal, async () => assert.fail("cancelled"));
  controller.abort(); await assert.rejects(cancelled);
  const second = locks.run("a", signal(), async () => { order.push("a2"); });
  await locks.run("b", signal(), async () => { order.push("b"); });
  assert.deepEqual(order, ["a1", "b"]);
  hold.resolve(); await Promise.all([first, second]);
  assert.deepEqual(order, ["a1", "b", "a2"]);
});

function bound() {
  const reference = { providerId: "third-test", version: 1, opaque: { privateKey: "locator-not-secret" } };
  let binding: LifecycleBinding = { conversationId: "conv", revision: 2, generation: 3, reference, lifecycle: "deleting", hasActiveTurn: false };
  let stop: "stopped" | "unknown" = "stopped", authorized = 0, stopped = 0;
  const host: LifecycleGuardHost = {
    async load() { return structuredClone(binding); },
    async authorize() { authorized++; },
    async stopAndConfirm() { stopped++; return stop; },
  };
  const locks = new ConversationLocks();
  const guard = new BoundSessionLifecycleGuard(locks, host, { conversationId: "conv", revision: 2, generation: 3 });
  return { reference, guard, host, locks, set: (value: Partial<LifecycleBinding>) => { binding = { ...binding, ...value }; },
    unknown: () => { stop = "unknown"; }, counts: () => ({ authorized, stopped }) };
}

test("生命周期 guard 在共享对话锁内校验绑定、授权、停止并二次核对", async () => {
  const { reference, guard, locks, counts } = bound();
  const entered = deferred(), release = deferred(); let sendRan = false;
  const deletion = guard.withStoppedSession(reference, signal(), async () => { entered.resolve(); await release.promise; return "deleted"; });
  await entered.promise;
  const send = locks.run("conv", signal(), async () => { sendRan = true; });
  await tick(); assert.equal(sendRan, false);
  release.resolve(); assert.equal(await deletion, "deleted"); await send;
  assert.deepEqual(counts(), { authorized: 2, stopped: 1 });
});

test("生命周期 guard 拒绝未登记删除、活动轮次、错误代次或其他引用", async () => {
  for (const change of [{ lifecycle: "active" as const }, { hasActiveTurn: true }, { revision: 99 }, { generation: 99 }, { conversationId: "other" }]) {
    const value = bound(); value.set(change);
    await assert.rejects(value.guard.withStoppedSession(value.reference, signal(), async () => assert.fail("must not delete")), AppError);
    assert.equal(value.counts().stopped, 0);
  }
  const value = bound();
  await assert.rejects(value.guard.withStoppedSession({ ...value.reference, opaque: "wrong" }, signal(), async () => assert.fail("must not delete")), { code: "BACKEND_BINDING_CONFLICT" });
});

test("生命周期 guard 不把停止未知/权限撤销/停止期间绑定变化当作可删除", async () => {
  const unknown = bound(); unknown.unknown();
  await assert.rejects(unknown.guard.withStoppedSession(unknown.reference, signal(), async () => assert.fail()), { code: "PROCESS_STOP_UNCONFIRMED" });
  const raced = bound();
  raced.host.stopAndConfirm = async () => { raced.set({ generation: 4 }); return "stopped"; };
  await assert.rejects(raced.guard.withStoppedSession(raced.reference, signal(), async () => assert.fail()), { code: "BACKEND_BINDING_CONFLICT" });
  const revoked = bound(); let calls = 0;
  revoked.host.authorize = async () => { if (++calls === 2) throw new AppError("FORBIDDEN", "revoked"); };
  await assert.rejects(revoked.guard.withStoppedSession(revoked.reference, signal(), async () => assert.fail()), { code: "FORBIDDEN" });
});

test("生命周期 guard 失败仍释放锁，取消后不会继续执行删除", async () => {
  const value = bound(), controller = new AbortController();
  value.host.stopAndConfirm = async () => { controller.abort(); return "stopped"; };
  await assert.rejects(value.guard.withStoppedSession(value.reference, controller.signal, async () => assert.fail()));
  assert.equal(await value.locks.run("conv", signal(), async () => "free"), "free");
});

test("Provider 存储标识持久、可重开、不混用 Provider，不自动收编未知目录", t => {
  const root = realpathSync(temporary(t));
  const first = ManagedSessionStore.initialize(root, "test-provider");
  assert.equal(ManagedSessionStore.open(root, "test-provider").id, first.id);
  assert.equal(ManagedSessionStore.initialize(root, "test-provider").id, first.id);
  first.assert();
  assert.throws(() => ManagedSessionStore.open(root, "other"), { code: "BACKEND_STORAGE_UNAVAILABLE" });
  const unknown = join(root, "unknown"); mkdirSync(unknown); writeFileSync(join(unknown, "history"), "keep");
  assert.throws(() => ManagedSessionStore.initialize(unknown, "test-provider"), { code: "BACKEND_STORAGE_UNAVAILABLE" });
  assert.equal(readFileSync(join(unknown, "history"), "utf8"), "keep");
});

test("Provider 存储标识拒绝篡改、符号链接、损坏及超预算 marker", t => {
  const root = realpathSync(temporary(t)), store = ManagedSessionStore.initialize(root, "p"), marker = join(root, ".orchard-session-store.json");
  const original = readFileSync(marker, "utf8");
  writeFileSync(marker, original.replace(store.id, "00000000-0000-4000-8000-000000000000"));
  assert.throws(() => store.assert(), { code: "BACKEND_STORAGE_UNAVAILABLE" });
  for (const content of ["not JSON", "x".repeat(5000)]) { writeFileSync(marker, content); assert.throws(() => ManagedSessionStore.open(root, "p")); }
  const backup = join(root, "original-marker"); writeFileSync(backup, original); rmSync(marker); symlinkSync(backup, marker);
  assert.throws(() => ManagedSessionStore.open(root, "p"));
});

test("跨进程重启后根目录被替换也不能将旧引用误判为已删除", async t => {
  const parent = realpathSync(temporary(t)), root = join(parent, "sessions"); mkdirSync(root);
  const store = ManagedSessionStore.initialize(root, "pi-cli");
  const reference = { providerId: "pi-cli", version: 1, opaque: { file: "missing.jsonl", cwd: parent, sessionId: "target", storeId: store.id } };
  renameSync(root, root + "-old"); mkdirSync(root); ManagedSessionStore.initialize(root, "pi-cli");
  // 新适配器没有旧进程的 inode 快照，仍必须凭持久 storeId 拒绝旧引用。
  const guard = { withStoppedSession: <T>(_ref: unknown, _signal: AbortSignal, action: () => Promise<T>) => action() };
  const provider = new PiSessionLifecycle(root, guard);
  assert.equal((await provider.inspect(reference, signal())).status, "unknown");
  await assert.rejects(provider.deleteSession(reference, signal()), { code: "BACKEND_STORAGE_UNAVAILABLE" });
});
