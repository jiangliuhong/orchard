import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiRpcProvider, piNativeAdapter } from "../src/providers/pi-rpc.js";
import { SessionManager } from "../src/providers/session-manager.js";
import { agentLimits, type AgentLimits } from "../src/providers/agent-limits.js";
import { CliProvider, type ProviderEvent } from "../src/providers/registry.js";
import type { SessionTurnRequest } from "../src/providers/session.js";
import type { ProviderSetting } from "../src/domain/types.js";
import { setup } from "./helpers.js";
import { installFixture, readLog } from "./agent-fixtures.js";

function nativeSetup(t: TestContext, scenario: string, env: Record<string, string> = {}, overrides: Partial<AgentLimits> = {}) {
  const { executable, logPath, root } = installFixture(t, "pi-server.mjs", scenario, env);
  const limits = agentLimits({ initializeTimeoutMs: 1500, requestAckTimeoutMs: 1500, interruptGraceMs: 700, terminateGraceMs: 150, probeCacheMs: 0, ...overrides });
  const manager = new SessionManager(limits);
  t.after(() => manager.close());
  const provider = new PiRpcProvider(manager, limits);
  const setting: ProviderSetting = { id: "pi-cli", enabled: true, config: { executable, transport: "native" }, models: [], defaultModel: "", revision: 1, updatedAt: Date.now() };
  return { provider, setting, manager, limits, logPath, root, executable };
}

/** Pi 持久会话使用受控目录布局：<root>/agent-workspaces/<key> 与 <root>/agent-sessions/pi。 */
const workspace = (root: string, key: string) => {
  const cwd = join(root, "agent-workspaces", key);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return cwd;
};

function turn(prompt: string, overrides: Partial<SessionTurnRequest> = {}) {
  const accepted: (string | null)[] = [];
  const events: ProviderEvent[] = [];
  const request: SessionTurnRequest = {
    modelId: "fixture-model", prompt, signal: new AbortController().signal, cwd: "/tmp", timeoutMs: 5000,
    emit: event => events.push(event), hostTurnId: "host-turn-1",
    onAccepted: async backendTurnId => { accepted.push(backendTurnId); },
    ...overrides,
  };
  return { request, accepted, events };
}

test("openSession validates flags, controlled session dir and structured first turn", async t => {
  const { provider, setting, root, logPath } = nativeSetup(t, "default");
  const key = "conv-pi-1";
  const handle = await provider.openSession(setting, { key, modelId: "fixture-model", cwd: workspace(root, key), persistent: true, signal: new AbortController().signal });
  assert.equal(handle.ref?.kind, "pi");
  if (handle.ref?.kind === "pi") {
    assert.equal(handle.ref.sessionId, "s-fixture");
    assert.ok(handle.ref.sessionFile.length > 0);
    assert.equal(handle.ref.cwd, join(root, "agent-workspaces", key));
  }
  const { request, accepted, events } = turn('RETURN:{"answer":42}', { schema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } });
  const result = await provider.sendTurn(handle, request);
  assert.deepEqual(result.output, { answer: 42 });
  assert.equal(typeof accepted[0], "string");
  assert.ok(events.some(event => event.type === "provider.text"));
  await provider.releaseSession(handle);
  const log = readLog(logPath);
  // 启动参数：无工具、无扩展、无 MCP、固定模型、受控 session 目录与宿主 UUID。
  for (const flag of ["--mode", "rpc", "--no-extensions", "--no-mcp", "--no-tools", "--thinking", "off"]) {
    assert.ok(log.argv.includes(flag), `missing ${flag} in ${JSON.stringify(log.argv)}`);
  }
  assert.equal(log.argv[log.argv.indexOf("--model") + 1], "fixture-model");
  assert.equal(log.argv[log.argv.indexOf("--session-dir") + 1], join(root, "agent-sessions", "pi", key));
  // 启动时使用宿主预分配 UUID；后端报告的 sessionId 在握手后刷新到引用。
  assert.match(log.argv[log.argv.indexOf("--session-id") + 1], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("prompt acceptance is not completion: the turn ends only at agent_settled", async t => {
  const { provider, setting, root } = nativeSetup(t, "slow-settle", { PI_SLOW_MS: "250" });
  const key = "conv-slow";
  const handle = await provider.openSession(setting, { key, modelId: "fixture-model", cwd: workspace(root, key), persistent: true, signal: new AbortController().signal });
  const started = Date.now();
  const result = await provider.sendTurn(handle, turn("slow reply").request);
  assert.ok(Date.now() - started >= 200, "turn resolved before the backend settled");
  assert.equal(JSON.parse(result.output as string).echo, "slow reply");
  await provider.releaseSession(handle);
});

test("transient retry errors are not final: the turn succeeds after recovery", async t => {
  const { provider, setting, root } = nativeSetup(t, "retry");
  const key = "conv-retry";
  const handle = await provider.openSession(setting, { key, modelId: "fixture-model", cwd: workspace(root, key), persistent: true, signal: new AbortController().signal });
  const result = await provider.sendTurn(handle, turn("try again").request);
  assert.equal(JSON.parse(result.output as string).echo, "try again");
  await provider.releaseSession(handle);
});

test("model errors and missing final text fail the turn explicitly", async t => {
  for (const [scenario, code] of [["model-error", "PROVIDER_FAILED"], ["no-text", "INVALID_AGENT_OUTPUT"]] as const) {
    const { provider, setting, root } = nativeSetup(t, scenario);
    const key = `conv-${scenario}`;
    const handle = await provider.openSession(setting, { key, modelId: "fixture-model", cwd: workspace(root, key), persistent: true, signal: new AbortController().signal });
    await assert.rejects(provider.sendTurn(handle, turn("x").request), { code });
    await provider.releaseSession(handle);
  }
});

test("queued or handled dispositions are protocol violations that kill the connection", async t => {
  for (const scenario of ["queued", "handled"] as const) {
    const { provider, setting, root } = nativeSetup(t, scenario);
    const key = `conv-${scenario}`;
    const handle = await provider.openSession(setting, { key, modelId: "fixture-model", cwd: workspace(root, key), persistent: true, signal: new AbortController().signal });
    await assert.rejects(provider.sendTurn(handle, turn("x").request), { code: "PROTOCOL_STATE_INVALID" });
    // 连接已清理：后续轮次明确要求重建，而不是等待永远不会到来的完成事件。
    await assert.rejects(provider.sendTurn(handle, turn("again").request), { code: "SESSION_REBUILD_REQUIRED" });
    await provider.releaseSession(handle);
  }
});

test("interrupt clears the queue before aborting and confirms the terminal state", async t => {
  const { provider, setting, root, logPath } = nativeSetup(t, "interruptible");
  const key = "conv-abort";
  const handle = await provider.openSession(setting, { key, modelId: "fixture-model", cwd: workspace(root, key), persistent: true, signal: new AbortController().signal });
  const pending = provider.sendTurn(handle, turn("long work").request);
  await new Promise(resolve => setTimeout(resolve, 120));
  await provider.interruptTurn(handle, "host-turn-1", new AbortController().signal);
  await assert.rejects(pending, { code: "CANCELLED" });
  await provider.releaseSession(handle);
  await new Promise(resolve => setTimeout(resolve, 80));
  const commands = readLog(logPath).lines.map(line => (JSON.parse(line) as { type?: string }).type).filter(Boolean);
  const clear = commands.indexOf("clear_queue"), abort = commands.indexOf("abort");
  assert.ok(clear >= 0 && abort > clear, `expected clear_queue before abort, got ${commands.join(",")}`);
});

test("turn timeouts interrupt, clean up and the session stays manageable", async t => {
  const { provider, setting, root } = nativeSetup(t, "never-settle");
  const key = "conv-timeout";
  const handle = await provider.openSession(setting, { key, modelId: "fixture-model", cwd: workspace(root, key), persistent: true, signal: new AbortController().signal });
  await assert.rejects(provider.sendTurn(handle, turn("x", { timeoutMs: 250 }).request), { code: "TIMEOUT" });
  // 超时主动中断并清理后：同一会话可继续提交，并仍可被明确取消。
  const second = provider.sendTurn(handle, turn("y").request);
  await new Promise(resolve => setTimeout(resolve, 100));
  await provider.interruptTurn(handle, "host-turn-1", new AbortController().signal);
  await assert.rejects(second, { code: "CANCELLED" });
  await provider.releaseSession(handle);
});

test("persistent sessions keep one process across turns", async t => {
  const { provider, setting, root, logPath } = nativeSetup(t, "default");
  const key = "conv-pi-multi";
  const handle = await provider.openSession(setting, { key, modelId: "fixture-model", cwd: workspace(root, key), persistent: true, signal: new AbortController().signal });
  const counts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const result = await provider.sendTurn(handle, turn(`round ${i}`).request);
    counts.push(JSON.parse(result.output as string).promptCount);
  }
  assert.deepEqual(counts, [1, 2, 3]);
  assert.equal(readLog(logPath).pids.length, 1);
  await provider.releaseSession(handle);
});

test("session files resume only from the host-managed directory", async t => {
  const { provider, setting, root } = nativeSetup(t, "default");
  const key = "conv-resume";
  const sessionsDir = join(root, "agent-sessions", "pi");
  mkdirSync(join(sessionsDir, key), { recursive: true });
  const file = join(sessionsDir, key, "session.jsonl");
  writeFileSync(file, "{}\n", { mode: 0o600 });
  // 合法恢复：文件在受控目录内，get_state 报告同一路径。
  const handle = await provider.openSession(setting, {
    key, modelId: "fixture-model", cwd: workspace(root, key), persistent: true, signal: new AbortController().signal,
    resumeRef: { version: 1, kind: "pi", sessionId: "s-fixture", sessionFile: file, cwd: join(root, "agent-workspaces", key) },
  });
  assert.equal(handle.ref?.kind, "pi");
  const result = await provider.sendTurn(handle, turn("resumed").request);
  assert.equal(JSON.parse(result.output as string).promptCount, 1);
  await provider.releaseSession(handle);
});

test("missing or escaping session files are refused without fake recovery", async t => {
  const { provider, setting, root } = nativeSetup(t, "default");
  const key = "conv-bad-resume";
  const cwd = workspace(root, key);
  const sessionsDir = join(root, "agent-sessions", "pi");
  mkdirSync(join(sessionsDir, key), { recursive: true });
  // 缺失文件：不能创建空同名会话冒充恢复。
  await assert.rejects(provider.openSession(setting, {
    key, modelId: "fixture-model", cwd, persistent: true, signal: new AbortController().signal,
    resumeRef: { version: 1, kind: "pi", sessionId: "s", sessionFile: join(sessionsDir, key, "missing.jsonl"), cwd },
  }), { code: "SESSION_REBUILD_REQUIRED" });
  // 越界 symlink：realpath 解析后必须落在受控目录内。
  writeFileSync(join(root, "agent-sessions", "OUTSIDE.jsonl"), "{}\n");
  symlinkSync(join(root, "agent-sessions", "OUTSIDE.jsonl"), join(sessionsDir, key, "escape.jsonl"));
  await assert.rejects(provider.openSession(setting, {
    key, modelId: "fixture-model", cwd, persistent: true, signal: new AbortController().signal,
    resumeRef: { version: 1, kind: "pi", sessionId: "s", sessionFile: join(sessionsDir, key, "escape.jsonl"), cwd },
  }), { code: "PROTOCOL_STATE_INVALID" });
});

test("get_state accepts raw or provider-qualified model IDs without hiding mismatches", async t => {
  const cases = [
    { requested: "openai/gpt-6.1-sol", provider: "openai", id: "gpt-6.1-sol", matches: true },
    { requested: "gpt-6.1-sol", provider: "openai", id: "gpt-6.1-sol", matches: true },
    { requested: "openrouter/vendor/model", provider: "openrouter", id: "vendor/model", matches: true },
    { requested: "vendor/model", provider: "gateway", id: "vendor/model", matches: true },
    { requested: "custom/provider/vendor/model", provider: "custom/provider", id: "vendor/model", matches: true },
    { requested: "openai/gpt-6.1-sol", provider: "other", id: "gpt-6.1-sol", matches: false },
    { requested: "openai/gpt-6.1-sol", provider: "openai", id: "other-model", matches: false },
    { requested: "openrouter/vendor/model", provider: "openrouter", id: "other/model", matches: false },
    { requested: "openai/gpt-6.1-sol", id: "gpt-6.1-sol", matches: false },
  ];
  for (const [index, example] of cases.entries()) {
    await t.test(`${example.requested} vs ${example.provider ?? "unknown"}/${example.id}`, async t => {
      const { provider, setting, root, logPath } = nativeSetup(t, "state-model", {
        PI_STATE_MODEL: JSON.stringify({ provider: example.provider, id: example.id }),
      });
      const key = `conv-model-${index}`;
      const opening = provider.openSession(setting, {
        key, modelId: example.requested, cwd: workspace(root, key), persistent: true, signal: new AbortController().signal,
      });
      if (example.matches) {
        const handle = await opening;
        // 首轮接受后的状态刷新也必须兼容完整模型标识。
        const result = await provider.sendTurn(handle, turn("RETURN:ok", { modelId: example.requested }).request);
        assert.equal(result.output, "ok");
        await provider.releaseSession(handle);
      } else {
        await assert.rejects(opening, {
          code: "PROTOCOL_STATE_INVALID",
          message: `Pi 实际模型与请求不一致: 请求 ${example.requested}，实际 ${example.provider ? `${example.provider}/` : ""}${example.id}`,
        });
        assert.ok(!readLog(logPath).lines.some(line => JSON.parse(line).type === "prompt"));
      }
    });
  }
});

test("get_state model mismatch refuses to open the session", async t => {
  const { provider, setting, root } = nativeSetup(t, "state-model-mismatch");
  const key = "conv-mismatch";
  await assert.rejects(provider.openSession(setting, { key, modelId: "fixture-model", cwd: workspace(root, key), persistent: true, signal: new AbortController().signal }), { code: "PROTOCOL_STATE_INVALID" });
});

test("registry.run dispatches native Pi single turns with --no-session and fresh processes", async t => {
  const { store, providers } = setup(t);
  t.after(() => store.close());
  const { executable, logPath } = installFixture(t, "pi-server.mjs", "default");
  const limits = agentLimits({ probeCacheMs: 0, initializeTimeoutMs: 1500 });
  const manager = new SessionManager(limits);
  t.after(() => manager.close());
  providers.register(new CliProvider("pi-cli", { native: piNativeAdapter(manager, limits), initializeTimeoutMs: 1500, probeCacheMs: 0 }), executable);
  providers.update("pi-cli", { enabled: true, defaultModel: "fixture-model", config: { transport: "native" } });
  const view = providers.views().find(p => p.id === "pi-cli")!;
  assert.equal(view.capabilities.sessions, "persistent");
  assert.equal(view.capabilities.textStream, true);
  for (let i = 0; i < 2; i++) {
    const events: ProviderEvent[] = [];
    const result = await providers.run({ providerId: "pi-cli", modelId: "fixture-model" }, {
      cwd: store.root, prompt: 'RETURN:{"ok":true}', schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
      signal: new AbortController().signal, emit: event => events.push(event),
    });
    assert.deepEqual(result.output, { ok: true });
    assert.equal((events.find(event => event.type === "provider.started") as { payload: { transport?: string } })?.payload?.transport, "native");
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  const log = readLog(logPath);
  // 单次调用：每轮 --no-session 且全新进程，不继承上次上下文。
  assert.equal(log.pids.length, 4); // 每次运行 ready() 探测 1 次 + dispatch 打开 1 次
  assert.equal(log.lines.filter(line => line.includes('"type":"prompt"')).length, 2);
  assert.ok(log.argv.includes("--no-session"));
});

test("default Pi transport uses native and propagates session failure", async t => {
  const { store, providers } = setup(t);
  t.after(() => store.close());
  const { executable } = installFixture(t, "pi-server.mjs", "default");
  const manager = new SessionManager(agentLimits({ probeCacheMs: 0 }));
  t.after(() => manager.close());
  const adapter = piNativeAdapter(manager, manager.limits);
  let nativeUsed = false;
  providers.register(new CliProvider("pi-cli", {
    native: { ...adapter, sessionProvider: { ...adapter.sessionProvider, async openSession() { nativeUsed = true; throw new Error("session failed"); } } },
  }), executable);
  providers.update("pi-cli", { enabled: true, defaultModel: "fixture-model" });
  assert.equal((await providers.detect("pi-cli")).state, "ready");
  assert.throws(() => providers.update("pi-cli", { config: { transport: "legacy" } }));
  await assert.rejects(providers.run({ providerId: "pi-cli", modelId: "fixture-model" }, {
    cwd: store.root, prompt: "hi", signal: new AbortController().signal, emit: () => {},
  }), /session failed/);
  assert.equal(nativeUsed, true);
});
