import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setup } from "./helpers.js";
import { installFixture, readLog } from "./agent-fixtures.js";
import { CliProvider } from "../src/providers/registry.js";
import { codexNativeAdapter } from "../src/providers/codex-app-server.js";
import { piNativeAdapter } from "../src/providers/pi-rpc.js";
import { SessionManager } from "../src/providers/session-manager.js";
import { agentLimits } from "../src/providers/agent-limits.js";
import { connectionFingerprint } from "../src/providers/session.js";

for (const id of ["pi-cli", "codex-cli"] as const) {
  test(`${id}: project uses snapshot cwd and scene-specific tools without deleting caller files`, async t => {
    const { root, store, providers } = setup(t);
    t.after(() => store.close());
    const fixture = installFixture(t, id === "pi-cli" ? "pi-server.mjs" : "codex-server.mjs", "default");
    const manager = new SessionManager();
    t.after(() => manager.close());
    const native = id === "pi-cli" ? piNativeAdapter(manager, manager.limits) : codexNativeAdapter(manager, manager.limits);
    providers.register(new CliProvider(id, { native }), fixture.executable);
    providers.update(id, { enabled: true, defaultModel: "fixture/small" });
    const cwd = join(root, "project-git", "workspaces", "snapshot");
    mkdirSync(cwd, { recursive: true });
    const result = await providers.run({ providerId: id }, {
      executionContext: "project", cwd, prompt: 'RETURN:{"answer":42}', schema: { type: "object" },
      signal: new AbortController().signal, emit: () => {},
    });
    assert.deepEqual(result.output, { answer: 42 });
    assert.ok(existsSync(cwd));
    assert.deepEqual(readdirSync(cwd), []);
    assert.equal(providers.views().find(p => p.id === id)!.capabilities.tools, false);
    assert.equal(providers.views().find(p => p.id === id)!.capabilities.projectAnalysis, true);
    const log = readLog(fixture.logPath);
    // Detection may log a preceding no-tool probe; inspect the final spawned process.
    const entries = readFileSync(fixture.logPath, "utf8").split("\n").filter(Boolean);
    const args = entries.filter(line => line.startsWith('{"argv"')).map(line => JSON.parse(line).argv as string[]).at(-1)!;
    if (id === "pi-cli") {
      assert.ok(!args.includes("--no-tools"));
      assert.ok(args.includes("--no-session"));
      assert.ok(args.includes("--no-extensions"));
    } else {
      assert.ok(!args.includes("features.shell_tool=false"));
      assert.ok(!args.includes("features.unified_exec=false"));
      assert.ok(args.includes("mcp_servers={}"));
      const start = log.lines.map(line => JSON.parse(line)).find(entry => entry.method === "thread/start");
      assert.equal(start.params.cwd, cwd);
      assert.equal(start.params.sandbox, "workspace-write");
      assert.equal(start.params.approvalPolicy, "never");
      assert.equal(start.params.ephemeral, true);
    }
    assert.notEqual(connectionFingerprint(providers.setting(id)), connectionFingerprint(providers.setting(id), "project"));
    await assert.rejects(native.sessionProvider.openSession(providers.setting(id), {
      key: "persistent-project", cwd, modelId: "fixture/small", persistent: true,
      executionContext: "project", signal: new AbortController().signal,
    }), { code: "PROTOCOL_STATE_INVALID" });
  });

  for (const mode of ["cancel", "timeout"] as const) {
    test(`${id}: project ${mode} releases session capacity and preserves snapshot`, async t => {
      const { root, store, providers } = setup(t);
      t.after(() => store.close());
      const fixture = installFixture(t, id === "pi-cli" ? "pi-server.mjs" : "codex-server.mjs", "interruptible");
      const manager = new SessionManager(agentLimits({ interruptGraceMs: 200, terminateGraceMs: 100 }));
      t.after(() => manager.close());
      const native = id === "pi-cli" ? piNativeAdapter(manager, manager.limits) : codexNativeAdapter(manager, manager.limits);
      const setting = { id, enabled: true, config: { executable: fixture.executable }, models: [], defaultModel: "fixture/small", revision: 1, updatedAt: 0 };
      const controller = new AbortController();
      const handle = await native.sessionProvider.openSession(setting, {
        key: "project", cwd: root, modelId: "fixture/small", persistent: false,
        executionContext: "project", signal: controller.signal,
      });
      try {
        await assert.rejects(native.sessionProvider.sendTurn(handle, {
          cwd: root, modelId: "fixture/small", prompt: "wait", hostTurnId: "turn", executionContext: "project",
          signal: controller.signal, timeoutMs: mode === "timeout" ? 100 : 5000, emit: () => {},
          onAccepted: async () => { if (mode === "cancel") controller.abort(); },
        }), { code: mode === "cancel" ? "CANCELLED" : "TIMEOUT" });
      } finally { await native.sessionProvider.releaseSession(handle); }
      assert.ok(existsSync(root));
      // Opening another anonymous session proves capacity was released.
      const next = await native.sessionProvider.openSession(setting, {
        key: "next", cwd: root, modelId: "fixture/small", persistent: false,
        executionContext: "project", signal: new AbortController().signal,
      });
      await native.sessionProvider.releaseSession(next);
    });
  }
}

for (const scenario of ["project-final", "project-final-legacy"]) {
  test(`Codex ${scenario}: commentary is excluded from final JSON`, async t => {
    const { root, store, providers } = setup(t);
    t.after(() => store.close());
    const fixture = installFixture(t, "codex-server.mjs", scenario);
    const manager = new SessionManager();
    t.after(() => manager.close());
    providers.register(new CliProvider("codex-cli", { native: codexNativeAdapter(manager, manager.limits) }), fixture.executable);
    providers.update("codex-cli", { enabled: true, defaultModel: "fixture/small" });
    const result = await providers.run({ providerId: "codex-cli" }, {
      executionContext: "project", cwd: root, prompt: 'RETURN:{"answer":42}', schema: { type: "object" },
      signal: new AbortController().signal, emit: () => {},
    });
    assert.deepEqual(result.output, { answer: 42 });
  });
}

test("unsupported provider rejects project before opening a session", async t => {
  const { root, store, providers, provider } = setup(t);
  t.after(() => store.close());
  await assert.rejects(providers.run({ providerId: provider.id }, {
    executionContext: "project", cwd: root, prompt: "analyze", signal: new AbortController().signal, emit: () => {},
  }), { code: "PROJECT_CAPABILITY_UNSUPPORTED" });
  assert.equal(provider.calls.length, 0);
  assert.ok(!readdirSync(root).some(name => name.startsWith(".agent-")));
});
