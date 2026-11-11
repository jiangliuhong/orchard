import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../src/domain/errors.js";
import type { ProviderSessionReference, SessionLifecycleGuard } from "../src/agent/provider-contract.js";
import { PiSessionLifecycle } from "../src/providers/pi-session-lifecycle.js";
import { CodexSessionLifecycle } from "../src/providers/codex-session-lifecycle.js";
import { SessionManager } from "../src/providers/session-manager.js";
import { ManagedSessionStore } from "../src/providers/managed-session-store.js";
import { temporary } from "./helpers.js";

// 仅用于临时测试存储。生产宿主必须提供持久操作锁和真实停止确认，不能使用这个 guard。
const stopped: SessionLifecycleGuard = { withStoppedSession: (_reference, signal, action) => { signal.throwIfAborted(); return action(); } };
const signal = () => new AbortController().signal;
function pi(t: TestContext, guard = stopped) {
  const parent = realpathSync(temporary(t));
  const root = join(parent, "sessions"); mkdirSync(root);
  const storage = ManagedSessionStore.initialize(root, "pi-cli");
  const cwd = join(parent, "workspace"); mkdirSync(cwd);
  const file = join(root, "target.jsonl");
  const header = { type: "session", version: 3, id: "target-id", cwd };
  writeFileSync(file, JSON.stringify(header) + "\n" + JSON.stringify({ type: "message", content: "native history" }) + "\n");
  const reference: ProviderSessionReference = { providerId: "pi-cli", version: 1, opaque: { file: "target.jsonl", sessionId: "target-id", cwd, storeId: storage.id } };
  return { parent, root, cwd, file, header, reference, provider: new PiSessionLifecycle(root, guard) };
}

function codex(t: TestContext, scenario = "default", guard = stopped) {
  const root = realpathSync(temporary(t));
  const storage = ManagedSessionStore.initialize(root, "codex-cli");
  const executable = join(root, "codex-fixture");
  copyFileSync(new URL("./fixtures/codex-lifecycle.mjs", import.meta.url), executable); chmodSync(executable, 0o755);
  const stateFile = join(root, "fixture-state.json");
  writeFileSync(stateFile, JSON.stringify({ scenario, active: ["target-thread", "other-thread"], archived: ["archived-thread"] }));
  // Leave room for parallel package compilation/CI startup; the lost-response fixture
  // deliberately never responds, so it still tests timeout rather than a narrow timing race.
  const manager = new SessionManager({ maxAgentProcesses: 1, initializeTimeoutMs: 5000, requestAckTimeoutMs: 1500, terminateGraceMs: 100 });
  t.after(() => manager.close());
  const reference: ProviderSessionReference = { providerId: "codex-cli", version: 1, opaque: { threadId: "target-thread", storageHome: root, storeId: storage.id } };
  const provider = new CodexSessionLifecycle({ executable, storageHome: root, manager, guard });
  const records = () => readFileSync(join(root, "fixture-log.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { root, executable, stateFile, manager, reference, provider, records };
}

test("Pi 删除确切原生文件且幂等，保留 workspace 和其他历史", async t => {
  const { provider, reference, root, file, cwd } = pi(t);
  const other = join(root, "other.jsonl"); writeFileSync(other, "other history");
  assert.deepEqual(await provider.inspect(reference, signal()), { status: "present" });
  assert.deepEqual(await provider.deleteSession(reference, signal()), { status: "deleted" });
  assert.equal(existsSync(file), false);
  assert.deepEqual(await provider.inspect(reference, signal()), { status: "absent" });
  assert.deepEqual(await provider.deleteSession(reference, signal()), { status: "already_absent" });
  assert.equal(readFileSync(other, "utf8"), "other history");
  assert.ok(existsSync(cwd)); assert.ok(existsSync(root));
});

test("Pi 拒绝越界、错误 Provider/版本、身份和损坏 header", async t => {
  const { provider, reference, file, header, root } = pi(t);
  const payload = reference.opaque as Record<string, string>;
  for (const value of [
    { ...reference, providerId: "other" }, { ...reference, version: 9 },
    ...["../escape.jsonl", file, "./target.jsonl", "sub/../target.jsonl", "target.txt"].map(file => ({ ...reference, opaque: { ...payload, file } })),
    { ...reference, opaque: { ...payload, sessionId: "other" } },
  ]) await assert.rejects(provider.deleteSession(value, signal()), AppError);
  for (const content of ["not json\n", "null\n", JSON.stringify({ ...header, version: 4 }) + "\n", "x".repeat(70_000)]) {
    writeFileSync(file, content);
    await assert.rejects(provider.deleteSession(reference, signal()), { code: "BACKEND_REFERENCE_INVALID" });
    assert.ok(existsSync(file));
  }
  assert.ok(existsSync(root));
});

test("Pi 拒绝符号链接、父目录链接和硬链接", async t => {
  const { provider, reference, file, root } = pi(t);
  const backup = join(root, "original.jsonl"); renameSync(file, backup); symlinkSync(backup, file);
  await assert.rejects(provider.deleteSession(reference, signal()), { code: "BACKEND_REFERENCE_INVALID" });
  rmSync(file); linkSync(backup, file);
  await assert.rejects(provider.deleteSession(reference, signal()), { code: "BACKEND_REFERENCE_INVALID" });
  symlinkSync(root, join(root, "nested"));
  await assert.rejects(provider.deleteSession({ ...reference, opaque: { ...(reference.opaque as object), file: "nested/original.jsonl" } }, signal()), { code: "BACKEND_REFERENCE_INVALID" });
  assert.ok(existsSync(backup));
});

test("Pi 根消失/被替换或父目录不可访问不是已删除", async t => {
  const { provider, reference, root } = pi(t);
  renameSync(root, root + "-old");
  assert.equal((await provider.inspect(reference, signal())).status, "unknown");
  await assert.rejects(provider.deleteSession(reference, signal()));
  mkdirSync(root);
  assert.equal((await provider.inspect(reference, signal())).status, "unknown");
  await assert.rejects(provider.deleteSession(reference, signal()), { code: "BACKEND_STORAGE_UNAVAILABLE" });
});

test("Pi 进程停止证明失败或取消时不删除，锁内重新校验身份", async t => {
  const guard: SessionLifecycleGuard = { async withStoppedSession() { throw new AppError("TURN_ACTIVE", "still running"); } };
  const value = pi(t, guard);
  await assert.rejects(value.provider.deleteSession(value.reference, signal()), { code: "TURN_ACTIVE" });
  assert.ok(existsSync(value.file));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(value.provider.deleteSession(value.reference, controller.signal));
  const racing = pi(t);
  // 修改目标身份发生在取得锁时；删除必须重新读取而不是信任锁前检查。
  const changed = new PiSessionLifecycle(racing.root, { async withStoppedSession(_ref, _signal, action) {
    writeFileSync(racing.file, JSON.stringify({ ...racing.header, id: "replacement" }) + "\n");
    return action();
  } });
  await assert.rejects(changed.deleteSession(racing.reference, signal()), { code: "BACKEND_REFERENCE_INVALID" });
  assert.ok(existsSync(racing.file));
});

test("Codex 原生 thread/delete，完整分页核对并保留其他会话，无模型或归档调用", async t => {
  const { provider, reference, stateFile, root, records } = codex(t);
  assert.deepEqual(await provider.inspect(reference, signal()), { status: "present" });
  assert.deepEqual(await provider.deleteSession(reference, signal()), { status: "deleted" });
  assert.deepEqual(await provider.deleteSession(reference, signal()), { status: "already_absent" });
  assert.deepEqual(await provider.inspect(reference, signal()), { status: "absent" });
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).active, ["other-thread"]);
  const log = records();
  assert.ok(log.filter(value => value.argv).every(value => value.home === root && value.argv.includes("mcp_servers={}")));
  const methods = log.filter(value => value.method).map(value => value.method);
  assert.equal(methods.filter(value => value === "thread/delete").length, 1);
  assert.ok(methods.every(value => ["initialize", "initialized", "thread/read", "thread/list", "thread/delete"].includes(value)));
  assert.ok(log.some(value => value.method === "thread/list" && value.params.cursor === "page2"));
  assert.ok(log.some(value => value.method === "thread/list" && value.params.archived === true && value.params.sourceKinds.includes("appServer")));
});

test("Codex 原生列表不可见但精确读取存在的目标仍执行删除", async t => {
  const { provider, reference, records } = codex(t, "read-invisible");
  assert.deepEqual(await provider.inspect(reference, signal()), { status: "present" });
  assert.deepEqual(await provider.deleteSession(reference, signal()), { status: "deleted" });
  assert.deepEqual(await provider.inspect(reference, signal()), { status: "absent" });
  assert.equal(records().filter(value => value.method === "thread/delete").length, 1);
});

test("Codex 支持精确删除已归档目标，不影响活动对话", async t => {
  const { provider, reference, stateFile } = codex(t);
  const archived = { ...reference, opaque: { ...(reference.opaque as object), threadId: "archived-thread" } };
  assert.deepEqual(await provider.deleteSession(archived, signal()), { status: "deleted" });
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.deepEqual(state.archived, []); assert.deepEqual(state.active, ["target-thread", "other-thread"]);
});

test("Codex 非法分页/循环/权限错误不算不存在且不发送 delete", async t => {
  for (const scenario of ["invalid-list", "loop", "list-error", "read-error", "read-wrong-id"]) {
    const { provider, reference, records } = codex(t, scenario);
    assert.equal((await provider.inspect(reference, signal())).status, "unknown");
    await assert.rejects(provider.deleteSession(reference, signal()));
    assert.ok(!records().some(value => value.method === "thread/delete"));
  }
});

test("Codex 删除错误或删除后仍存在不能报告成功，不泄漏原生诊断", async t => {
  for (const [scenario, code] of [["delete-error", "NATIVE_DELETE_FAILED"], ["delete-no-effect", "NATIVE_DELETE_UNCONFIRMED"]]) {
    const { provider, reference } = codex(t, scenario);
    await assert.rejects(provider.deleteSession(reference, signal()), (error: unknown) => error instanceof AppError && error.code === code && !error.message.includes("secret"));
    assert.deepEqual(await provider.inspect(reference, signal()), { status: "present" });
  }
});

test("Codex 删除响应丢失不自动补发，下次精确核对后幂等完成且槽位可复用", async t => {
  const { provider, reference, records } = codex(t, "delete-lost-response");
  await assert.rejects(provider.deleteSession(reference, signal()), { code: "TIMEOUT" });
  assert.deepEqual(await provider.inspect(reference, signal()), { status: "absent" });
  assert.deepEqual(await provider.deleteSession(reference, signal()), { status: "already_absent" });
  assert.equal(records().filter(value => value.method === "thread/delete").length, 1);
});

test("Codex 停止证明失败、引用存储不匹配和取消时不启动控制进程", async t => {
  const { provider, reference, root } = codex(t, "default", { async withStoppedSession() { throw new AppError("TURN_ACTIVE", "still running"); } });
  await assert.rejects(provider.deleteSession(reference, signal()), { code: "TURN_ACTIVE" });
  await assert.rejects(provider.inspect({ ...reference, opaque: { ...(reference.opaque as object), storageHome: root + "-wrong" } }, signal()), { code: "BACKEND_REFERENCE_INVALID" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.inspect(reference, controller.signal));
  assert.equal(existsSync(join(root, "fixture-log.jsonl")), false);
});

test("Codex 存储根丢失不当作不存在", async t => {
  const { provider, reference, root } = codex(t);
  renameSync(root, root + "-moved");
  t.after(() => { renameSync(root + "-moved", root); });
  assert.equal((await provider.inspect(reference, signal())).status, "unknown");
  await assert.rejects(provider.deleteSession(reference, signal()));
});
