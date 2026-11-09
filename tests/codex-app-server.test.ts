import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { CodexAppServerProvider, codexNativeAdapter } from "../src/providers/codex-app-server.js";
import { SessionManager } from "../src/providers/session-manager.js";
import { agentLimits, type AgentLimits } from "../src/providers/agent-limits.js";
import { CliProvider, type ProviderEvent } from "../src/providers/registry.js";
import type { SessionTurnRequest } from "../src/providers/session.js";
import type { ProviderSetting } from "../src/domain/types.js";
import { setup } from "./helpers.js";
import { installFixture, readLog } from "./agent-fixtures.js";

function nativeSetup(t: TestContext, scenario: string, overrides: Partial<AgentLimits> = {}) {
  const { executable, logPath, root } = installFixture(t, "codex-server.mjs", scenario);
  const limits = agentLimits({ initializeTimeoutMs: 1500, requestAckTimeoutMs: 1500, interruptGraceMs: 700, terminateGraceMs: 150, probeCacheMs: 0, ...overrides });
  const manager = new SessionManager(limits);
  t.after(() => manager.close());
  const provider = new CodexAppServerProvider(manager, limits);
  const setting: ProviderSetting = { id: "codex-cli", enabled: true, config: { executable, transport: "native" }, models: [], defaultModel: "", revision: 1, updatedAt: Date.now() };
  return { provider, setting, manager, limits, logPath, root, executable };
}

const open = (key: string, overrides: Partial<Parameters<CodexAppServerProvider["openSession"]>[1]> = {}) => ({
  key, modelId: "fixture-model", cwd: "/tmp", persistent: true, signal: new AbortController().signal, ...overrides,
});

function turn(prompt: string, overrides: Partial<SessionTurnRequest> = {}) {
  const accepted: string[] = [];
  const events: ProviderEvent[] = [];
  const request: SessionTurnRequest = {
    modelId: "fixture-model", prompt, signal: new AbortController().signal, cwd: "/tmp", timeoutMs: 5000,
    emit: event => events.push(event), hostTurnId: "host-turn-1",
    onAccepted: async backendTurnId => { accepted.push(backendTurnId ?? "null"); },
    ...overrides,
  };
  return { request, accepted, events };
}

test("handshake order, no-tool policy args, structured output and backend turn identity", async t => {
  const { provider, setting, logPath } = nativeSetup(t, "default");
  const handle = await provider.openSession(setting, open("conv-1"));
  assert.deepEqual(handle.ref, { version: 1, kind: "codex", threadId: "thread-fixture-1", cwd: "/tmp" });
  const { request, accepted } = turn('RETURN:{"answer":42}', { schema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } });
  const result = await provider.sendTurn(handle, request);
  assert.deepEqual(result.output, { answer: 42 });
  assert.equal(result.providerId, "codex-cli");
  assert.equal(result.backendTurnId, "turn-fixture-1");
  assert.deepEqual(accepted, ["turn-fixture-1"]);
  await provider.releaseSession(handle);
  await new Promise(resolve => setTimeout(resolve, 60)); // 等待日志落盘
  const log = readLog(logPath);
  // 握手顺序：initialize → initialized → thread/start → turn/start。
  const methods = log.lines.map(line => JSON.parse(line) as { method?: string }).map(entry => entry.method).filter(Boolean);
  assert.deepEqual(methods.slice(0, 4), ["initialize", "initialized", "thread/start", "turn/start"]);
  for (const pair of [["-c", "mcp_servers={}"], ["-c", "notify=[]"], ["-c", 'web_search="disabled"'], ["-c", "features.shell_tool=false"], ["-c", "features.browser_use=false"]]) {
    const index = log.argv.indexOf(pair[0]!, log.argv.includes(pair[1]!) ? log.argv.indexOf(pair[1]!) - 1 : 0);
    assert.ok(index >= 0 && log.argv[index + 1] === pair[1], `missing tool policy override ${pair.join(" ")} in ${JSON.stringify(log.argv)}`);
  }
});

test("notifications arriving before the turn/start response are buffered and attributed", async t => {
  const { provider, setting } = nativeSetup(t, "notify-first");
  const handle = await provider.openSession(setting, open("conv-notify"));
  const { request, events } = turn("hello");
  const result = await provider.sendTurn(handle, request);
  assert.equal(result.output, "early world");
  assert.equal(events.filter(event => event.type === "provider.text").length, 2); // early + world 增量都送达
  await provider.releaseSession(handle);
});

test("completed item text overwrites the delta buffer exactly once", async t => {
  const { provider, setting } = nativeSetup(t, "overwrite");
  const handle = await provider.openSession(setting, open("conv-overwrite"));
  const result = await provider.sendTurn(handle, turn("x").request);
  assert.equal(result.output, "hello world"); // 不是 "hello worldhello world"
  await provider.releaseSession(handle);
});

test("deltas assemble the final text when no completed item arrives", async t => {
  const { provider, setting } = nativeSetup(t, "deltas-only");
  const handle = await provider.openSession(setting, open("conv-deltas"));
  const result = await provider.sendTurn(handle, turn("x").request);
  assert.equal(result.output, "partial story");
  await provider.releaseSession(handle);
});

test("turn failed and interrupted statuses produce explicit terminal errors", async t => {
  for (const [scenario, code] of [["failed", "PROVIDER_FAILED"], ["interrupted", "TURN_INTERRUPTED"]] as const) {
    const { provider, setting } = nativeSetup(t, scenario);
    const handle = await provider.openSession(setting, open(`conv-${scenario}`));
    await assert.rejects(provider.sendTurn(handle, turn("x").request), { code });
    await provider.releaseSession(handle);
  }
});

test("approval, tool and MCP requests are denied, fail the turn TOOLS_DISABLED and never hang", async t => {
  const { provider, setting, logPath } = nativeSetup(t, "approval");
  const handle = await provider.openSession(setting, open("conv-approval"));
  await assert.rejects(provider.sendTurn(handle, turn("x").request), { code: "TOOLS_DISABLED" });
  // 等待拒绝应答被对端读取，再释放连接。
  await new Promise(resolve => setTimeout(resolve, 120));
  await provider.releaseSession(handle);
  await new Promise(resolve => setTimeout(resolve, 80));
  const responses = readLog(logPath).lines.map(line => JSON.parse(line) as { id?: unknown; error?: { message?: string } });
  for (const id of [901, 903, 904]) {
    const denial = responses.find(entry => entry.id === id);
    assert.ok(denial, `missing denial response for ${id}`);
    assert.match(denial!.error!.message!, /TOOLS_DISABLED/);
  }
});

test("unknown server requests receive method-not-found and the turn continues", async t => {
  const { provider, setting, logPath } = nativeSetup(t, "unknown-request");
  const handle = await provider.openSession(setting, open("conv-unknown"));
  const result = await provider.sendTurn(handle, turn("x").request);
  assert.equal(result.output, "kept going");
  await provider.releaseSession(handle);
  await new Promise(resolve => setTimeout(resolve, 80));
  const responses = readLog(logPath).lines.map(line => JSON.parse(line) as { id?: unknown; error?: { code?: number } }).filter(entry => entry.id === 902);
  assert.equal(responses.length, 1);
  assert.equal(responses[0]!.error!.code, -32601);
});

test("thread-level usage is reported with session scope and turn-scoped usage in results", async t => {
  const { provider, setting } = nativeSetup(t, "usage");
  const handle = await provider.openSession(setting, open("conv-usage"));
  const { request, events } = turn("x");
  const result = await provider.sendTurn(handle, request);
  const usageEvent = events.find(event => event.type === "provider.usage") as { payload: { usage: { total: unknown }; scope: string } } | undefined;
  assert.ok(usageEvent, "expected provider.usage event");
  assert.equal(usageEvent.payload.scope, "session"); // 线程总量不冒充单轮用量
  assert.deepEqual((usageEvent.payload.usage as { total: { totalTokens: number } }).total.totalTokens, 13);
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 7 });
  assert.equal(result.usageScope, "turn");
  await provider.releaseSession(handle);
});

test("notifications for other turns or threads never leak into the current turn", async t => {
  {
    const { provider, setting } = nativeSetup(t, "wrong-turn");
    const handle = await provider.openSession(setting, open("conv-wrong-turn"));
    const result = await provider.sendTurn(handle, turn("x").request);
    assert.equal(result.output, "mine final"); // 其他轮次的增量被丢弃，未拼入最终文本
    await provider.releaseSession(handle);
  }
  {
    const { provider, setting } = nativeSetup(t, "wrong-thread");
    const handle = await provider.openSession(setting, open("conv-wrong-thread"));
    const result = await provider.sendTurn(handle, turn("x").request);
    // 异 thread 的 failed 终态被丢弃，本轮仍以本 thread 的 completed 结束。
    assert.ok(typeof result.output === "string" && (result.output as string).includes("threadId"));
    await provider.releaseSession(handle);
  }
});

test("thread resume failure for a missing thread requires a rebuild instead of a silent retry", async t => {
  const { provider, setting } = nativeSetup(t, "resume-missing");
  await assert.rejects(provider.openSession(setting, open("conv-resume", {
    resumeRef: { version: 1, kind: "codex", threadId: "does-not-exist", cwd: "/tmp" },
  })), { code: "SESSION_REBUILD_REQUIRED" });
});

test("malformed thread ids are permanent failures and also require a rebuild (codex 0.165.0 wording)", async t => {
  const { provider, setting } = nativeSetup(t, "resume-invalid");
  await assert.rejects(provider.openSession(setting, open("conv-invalid", {
    resumeRef: { version: 1, kind: "codex", threadId: "bogus-thread", cwd: "/tmp" },
  })), { code: "SESSION_REBUILD_REQUIRED" });
});

test("a hanging initialize fails with an explicit protocol error", async t => {
  const { provider, setting } = nativeSetup(t, "hang-init", { initializeTimeoutMs: 500 });
  await assert.rejects(provider.openSession(setting, open("conv-hang")), error => {
    const code = (error as { code?: string }).code;
    return code === "TIMEOUT" || code === "PROTOCOL_UNSUPPORTED";
  });
});

test("persistent sessions keep one process and thread across turns", async t => {
  const { provider, setting, logPath } = nativeSetup(t, "default");
  const handle = await provider.openSession(setting, open("conv-multi"));
  const outputs: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    const result = await provider.sendTurn(handle, turn(`round ${i}`).request);
    outputs.push(JSON.parse(result.output as string).promptCount);
  }
  assert.deepEqual(outputs, [1, 2, 3]); // 同一后端 thread 的状态延续
  const log = readLog(logPath);
  assert.equal(log.lines.filter(line => line.includes("turn/start")).length, 3);
  assert.equal(log.lines.filter(line => line.includes("thread/start")).length, 1);
  await provider.releaseSession(handle);
});

test("interrupt requests a stop, waits for the terminal state and frees the next turn", async t => {
  const { provider, setting, logPath } = nativeSetup(t, "interruptible");
  const handle = await provider.openSession(setting, open("conv-interrupt"));
  const pending = provider.sendTurn(handle, turn("long work").request);
  await new Promise(resolve => setTimeout(resolve, 120));
  await provider.interruptTurn(handle, "host-turn-1", new AbortController().signal);
  await assert.rejects(pending, { code: "CANCELLED" });
  // 取消确认后同会话可继续下一轮。
  const next = await provider.sendTurn(handle, turn("after cancel").request);
  assert.equal(JSON.parse(next.output as string).promptCount, 2);
  await provider.releaseSession(handle);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(readLog(logPath).lines.some(line => line.includes("turn/interrupt")));
});

test("released sessions close their process and a fresh session starts a new one", async t => {
  const { provider, setting, logPath } = nativeSetup(t, "default");
  const first = await provider.openSession(setting, open("conv-release"));
  await provider.sendTurn(first, turn("one").request);
  await provider.releaseSession(first);
  const second = await provider.openSession(setting, open("conv-release-2"));
  await provider.sendTurn(second, turn("two").request);
  await provider.releaseSession(second);
  await new Promise(resolve => setTimeout(resolve, 80));
  const log = readLog(logPath);
  assert.equal(log.lines.filter(line => line.includes("thread/start")).length, 2);
});

test("registry.run dispatches native single turns with isolated context and transport events", async t => {
  const { store, providers } = setup(t);
  t.after(() => store.close());
  const { executable, logPath } = installFixture(t, "codex-server.mjs", "default");
  const limits = agentLimits({ probeCacheMs: 0, initializeTimeoutMs: 1500 });
  const manager = new SessionManager(limits);
  t.after(() => manager.close());
  providers.register(new CliProvider("codex-cli", { native: codexNativeAdapter(manager, limits), initializeTimeoutMs: 1500, probeCacheMs: 0 }), executable);
  providers.update("codex-cli", { enabled: true, defaultModel: "fixture-model", config: { transport: "native" } });
  const view = providers.views().find(p => p.id === "codex-cli")!;
  assert.equal(view.capabilities.sessions, "persistent");
  assert.equal(view.capabilities.nativeResume, true);
  assert.equal((await providers.detect("codex-cli")).transport, "native");
  for (let i = 0; i < 2; i++) {
    const events: ProviderEvent[] = [];
    const result = await providers.run({ providerId: "codex-cli", modelId: "fixture-model" }, {
      cwd: store.root, prompt: 'RETURN:{"answer":42}', schema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
      signal: new AbortController().signal, emit: event => events.push(event),
    });
    assert.deepEqual(result.output, { answer: 42 });
    const started = events.find(event => event.type === "provider.started") as { payload: { transport?: string } } | undefined;
    assert.equal(started?.payload?.transport, "native");
    assert.ok(events.some(event => event.type === "provider.completed"));
  }
  await new Promise(resolve => setTimeout(resolve, 80));
  const log = readLog(logPath);
  // 每次运行前 ready() 探测一次 + dispatch 打开一次临时句柄：两个独立进程、互不复用。
  assert.equal(log.lines.filter(line => line.includes("thread/start")).length, 2);
  assert.equal(log.lines.filter(line => line.includes('"method":"initialize"')).length, 5);
  // 单次上下文隔离：两次运行的后端各自从 promptCount=1 开始。
  const turns = readLog(logPath).lines.filter(line => line.includes("turn/start"));
  assert.equal(turns.length, 2);
});

test("native readiness reports explicit failure codes without falling back silently", async t => {
  const { store, providers } = setup(t);
  t.after(() => store.close());
  const { executable } = installFixture(t, "codex-server.mjs", "hang-init");
  const limits = agentLimits({ probeCacheMs: 0, initializeTimeoutMs: 400 });
  const manager = new SessionManager(limits);
  t.after(() => manager.close());
  providers.register(new CliProvider("codex-cli", { native: codexNativeAdapter(manager, limits), initializeTimeoutMs: 400, probeCacheMs: 0 }), executable);
  providers.update("codex-cli", { enabled: true, defaultModel: "m", config: { transport: "native" } });
  const readiness = await providers.detect("codex-cli");
  assert.equal(readiness.state, "unavailable");
  assert.equal(readiness.transport, "native");
  assert.ok(readiness.errorCode === "TIMEOUT" || readiness.errorCode === "PROTOCOL_UNSUPPORTED");
  assert.throws(() => providers.update("codex-cli", { config: { transport: "legacy" } }));
});

test("default Codex transport uses native and propagates session failure", async t => {
  const { store, providers } = setup(t);
  t.after(() => store.close());
  const { executable } = installFixture(t, "codex-server.mjs", "default");
  const manager = new SessionManager(agentLimits({ probeCacheMs: 0 }));
  t.after(() => manager.close());
  const adapter = codexNativeAdapter(manager, manager.limits);
  let nativeUsed = false;
  providers.register(new CliProvider("codex-cli", {
    native: { ...adapter, sessionProvider: { ...adapter.sessionProvider, async openSession() { nativeUsed = true; throw new Error("session failed"); } } },
  }), executable);
  providers.update("codex-cli", { enabled: true, defaultModel: "m" });
  assert.equal((await providers.detect("codex-cli")).state, "ready");
  assert.notEqual(providers.views().find(p => p.id === "codex-cli")!.capabilities.sessions, "none");
  await assert.rejects(providers.run({ providerId: "codex-cli", modelId: "m" }, {
    cwd: store.root, prompt: "anything", signal: new AbortController().signal, emit: () => {},
  }), /session failed/);
  assert.equal(nativeUsed, true);
});

test("outputSchema is only sent when the host schema satisfies codex strict structured output", async t => {
  const { provider, setting, logPath } = nativeSetup(t, "default");
  const handle = await provider.openSession(setting, open("conv-strict"));
  // 可选属性（required 未覆盖 properties）→ 省略 outputSchema，仅宿主校验。
  const optional = turn('RETURN:{"summary":"ok","changes":[]}', { schema: {
    type: "object", required: ["summary", "changes"], properties: {
      summary: { type: "string" }, changes: { type: "array", items: { type: "object", required: ["operation", "path"], properties: { operation: { type: "string" }, path: { type: "string" }, content: { type: "string" } } } },
    }, additionalProperties: false,
  } });
  assert.deepEqual((await provider.sendTurn(handle, optional.request)).output, { summary: "ok", changes: [] });
  // maxLength 等不支持关键字同样省略。
  const limited = turn('RETURN:{"a":"b"}', { schema: { type: "object", required: ["a"], properties: { a: { type: "string", maxLength: 5 } } } });
  assert.deepEqual((await provider.sendTurn(handle, limited.request)).output, { a: "b" });
  // 完全严格的 schema 仍随请求发送。
  const strict = turn('RETURN:{"answer":7}', { schema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } });
  assert.deepEqual((await provider.sendTurn(handle, strict.request)).output, { answer: 7 });
  await provider.releaseSession(handle);
  await new Promise(resolve => setTimeout(resolve, 60));
  const turns = readLog(logPath).lines.map(line => JSON.parse(line) as { method?: string; params?: { outputSchema?: unknown } })
    .filter(entry => entry.method === "turn/start");
  assert.equal(turns.length, 3);
  assert.equal(turns[0]!.params!.outputSchema, undefined, "可选属性 schema 不应发送 outputSchema");
  assert.equal(turns[1]!.params!.outputSchema, undefined, "不支持关键字 schema 不应发送 outputSchema");
  assert.deepEqual(turns[2]!.params!.outputSchema, { type: "object", required: ["answer"], properties: { answer: { type: "number" } } });
});
