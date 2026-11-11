import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { temporary } from "./helpers.js";
import { SessionManager } from "../src/providers/session-manager.js";
import { JsonlConnection } from "../src/providers/transport/jsonl.js";
import { PendingRequests } from "../src/providers/transport/pending.js";
import { TOOL_POLICY_ARGS } from "../src/providers/codex-app-server.js";
import { ManagedSessionStore } from "../src/providers/managed-session-store.js";
import { CodexSessionLifecycle } from "../src/providers/codex-session-lifecycle.js";
import { PiSessionLifecycle } from "../src/providers/pi-session-lifecycle.js";
import type { SessionLifecycleGuard } from "../src/agent/provider-contract.js";

// 显式 opt-in，只在本测试创建的临时目录内操作；不发送 prompt/turn/start，不读取真实用户会话。
const codex = process.env.ORCHARD_NATIVE_CODEX;
const pi = process.env.ORCHARD_NATIVE_PI;
const piModule = process.env.ORCHARD_NATIVE_PI_MODULE;
const signal = () => new AbortController().signal;
const exitedGuard: SessionLifecycleGuard = { withStoppedSession: (_reference, _signal, action) => action() };

type Request = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
async function control(options: { executable: string; args: string[]; cwd: string; env: Record<string, string>; manager: SessionManager; pi?: boolean }, action: (request: Request, notify: (method: string) => Promise<void>) => Promise<void>) {
  const pending = new PendingRequests(15_000, 4);
  const slot = await options.manager.acquire(null, signal(), "native-test");
  let conn: JsonlConnection | undefined;
  try {
    conn = JsonlConnection.start({
      ...options, limits: options.manager.limits,
      onDiagnostic: () => {}, onBroken: error => pending.close(error),
      onRecord(record) {
        const message = record as { id?: unknown; method?: unknown; result?: unknown; error?: unknown; success?: unknown };
        if (message.id === undefined || message.method !== undefined) return;
        if (message.error !== undefined || message.success === false) pending.reject(message.id, new Error(`native control command failed: ${JSON.stringify(message.error)}`));
        else pending.resolve(message.id, options.pi ? message : message.result);
      },
    });
    const request: Request = (method, params = {}) => {
      const { id, promise } = pending.create(method);
      void conn!.write(JSON.stringify(options.pi ? { id, type: method, ...params } : { id, method, params })).catch(error => pending.reject(id, error));
      return promise;
    };
    await action(request, method => conn!.write(JSON.stringify({ method, params: {} })));
  } finally {
    pending.close();
    try { await conn?.close(); } finally { slot.finish(); }
  }
}

test("真实 Codex：临时原生会话无模型生成直接删除", { skip: !codex, timeout: 60_000 }, async t => {
  const parent = realpathSync(temporary(t)), home = join(parent, "codex-home"), workspace = join(parent, "workspace");
  mkdirSync(home); mkdirSync(workspace);
  const storage = ManagedSessionStore.initialize(home, "codex-cli");
  const manager = new SessionManager({ maxAgentProcesses: 1, requestAckTimeoutMs: 15_000 });
  t.after(() => manager.close());
  let threadId = "";
  await control({ executable: codex!, args: ["app-server", ...TOOL_POLICY_ARGS], cwd: workspace, env: { CODEX_HOME: home }, manager }, async (request, notify) => {
    await request("initialize", { clientInfo: { name: "orchard-native-lifecycle-test", version: "0.1.0" } });
    await notify("initialized");
    const result = await request("thread/start", { cwd: workspace, ephemeral: false, sandbox: "read-only", approvalPolicy: "never", baseInstructions: "Disposable lifecycle fixture; no generation permitted." }) as { thread: { id: string } };
    threadId = result.thread.id;
    assert.ok(threadId);
    // 官方原生注入通道用于持久化测试内容；不是生成请求，不伪造已有用户会话。
    await request("thread/inject_items", { threadId, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Disposable lifecycle test fixture, not a model request." }] }] });
    // 不调用 thread/archive/unarchive；后续由独立连接准确读取和直接删除。
  }); // control 的 finally 已确认子进程退出。
  const provider = new CodexSessionLifecycle({ executable: codex!, storageHome: home, manager, guard: exitedGuard });
  const reference = { providerId: "codex-cli", version: 1, opaque: { threadId, storageHome: home, storeId: storage.id } };
  assert.deepEqual(await provider.inspect(reference, signal()), { status: "present" });
  assert.deepEqual(await provider.deleteSession(reference, signal()), { status: "deleted" });
  assert.deepEqual(await provider.inspect(reference, signal()), { status: "absent" });
  assert.deepEqual(await provider.deleteSession(reference, signal()), { status: "already_absent" });
  assert.ok(existsSync(workspace));
});

test("真实 Pi：官方 SDK 持久化、CLI 准确打开、停止后原生文件删除", { skip: !pi || !piModule, timeout: 60_000 }, async t => {
  const parent = realpathSync(temporary(t)), root = join(parent, "sessions"), cwd = join(parent, "workspace"), config = join(parent, "pi-config");
  mkdirSync(root); mkdirSync(cwd); mkdirSync(config);
  const storage = ManagedSessionStore.initialize(root, "pi-cli");
  const sdk = await import(pathToFileURL(piModule!).href);
  const native = sdk.SessionManager.create(cwd, root);
  native.appendMessage({ role: "user", content: "Disposable test fixture, no model request.", timestamp: Date.now() });
  // SDK 延迟持久化：追加合成的测试 assistant 条目触发正式存储 API，绝不调用模型。
  native.appendMessage({ role: "assistant", content: [{ type: "text", text: "Synthetic lifecycle fixture." }], api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const file = native.getSessionFile(), sessionId = native.getSessionId();
  assert.ok(existsSync(file));
  const manager = new SessionManager(); t.after(() => manager.close());
  await control({ executable: pi!, args: ["--mode", "rpc", "--offline", "--no-extensions", "--no-mcp", "--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--session", file], cwd, env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" }, manager, pi: true }, async request => {
    const response = await request("get_state") as { data: { sessionId: string; isStreaming: boolean } };
    assert.equal(response.data.sessionId, sessionId);
    assert.equal(response.data.isStreaming, false);
  });
  const provider = new PiSessionLifecycle(root, exitedGuard);
  const reference = { providerId: "pi-cli", version: 1, opaque: { file: relative(root, file), cwd, sessionId, storeId: storage.id } };
  assert.deepEqual(await provider.inspect(reference, signal()), { status: "present" });
  assert.deepEqual(await provider.deleteSession(reference, signal()), { status: "deleted" });
  assert.equal(existsSync(file), false);
  assert.deepEqual(await provider.deleteSession(reference, signal()), { status: "already_absent" });
  assert.ok(existsSync(cwd));
});

test("真实 Pi：首次生成前声明稳定原生路径，不猜测文件名", { skip: !pi, timeout: 60_000 }, async t => {
  const parent = realpathSync(temporary(t)), root = join(parent, "sessions"), cwd = join(parent, "workspace"), config = join(parent, "pi-config");
  mkdirSync(root); mkdirSync(cwd); mkdirSync(config);
  const storage = ManagedSessionStore.initialize(root, "pi-cli"), directory = join(root, "conversation");
  mkdirSync(directory);
  const sessionId = randomUUID(), manager = new SessionManager(); t.after(() => manager.close());
  await control({ executable: pi!, args: ["--mode", "rpc", "--offline", "--no-extensions", "--no-mcp", "--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--session-dir", directory, "--session-id", sessionId], cwd,
    env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" }, manager, pi: true }, async request => {
    const first = await request("get_state") as { data: { sessionId: string; sessionFile: string; isStreaming: boolean } };
    assert.equal(first.data.sessionId, sessionId);
    assert.equal(dirname(first.data.sessionFile), directory);
    assert.ok(first.data.sessionFile.endsWith(`_${sessionId}.jsonl`));
    assert.equal(existsSync(first.data.sessionFile), false);
    assert.equal(first.data.isStreaming, false);
    const second = await request("get_state") as typeof first;
    assert.equal(second.data.sessionFile, first.data.sessionFile);
  });
  storage.assert();
});
