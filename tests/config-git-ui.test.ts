import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLFormElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "getComputedStyle", "localStorage", "navigator"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: ReturnType<typeof setTimeout>) => clearTimeout(id) });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { ConfigGitSettings, ConfigGitGeneralDelivery, adaptPreview } = await import("../src/web/features/ConfigGitSettings.js");
const { ThemeProvider, useTheme, preferenceStorageKey } = await import("../src/web/lib/theme.js");
const { ToastNotice } = await import("../src/web/components/ToastNotice.js");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); localStorage.clear(); globalThis.fetch = originalFetch; });

test("operation toast uses a portal, supports dismissal and automatically expires", async () => {
  let dismissals = 0;
  const view = render(createElement(ToastNotice, { message: "删除成功", onDismiss: () => { dismissals++; } }));
  assert.equal(view.container.textContent, "");
  const close = await screen.findByRole("button", { name: "关闭操作提示" });
  fireEvent.click(close);
  assert.equal(dismissals, 1);
  view.rerender(createElement(ToastNotice, { message: "设置已保存", onDismiss: () => { dismissals++; } }));
  await waitFor(() => assert.equal(dismissals, 2), { timeout: 6500 });
});

function mock(extra: (path: string, body: Record<string, unknown>) => unknown) {
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {};
    if (path.endsWith("/repository")) return Response.json({ binding: { id: "b", remoteUrl: "git@example.test:config.git", branch: "main", configDir: "orchard-config", snapshotState: "valid" } });
    if (path.endsWith("/status")) return Response.json({ ahead: 0, behind: 0, diverged: false, dirtyPaths: [] });
    if (path.endsWith("/recovery-points") || path.endsWith("/providers") || path.endsWith("/agent-model-configs")) return Response.json({ items: [] });
    return Response.json(extra(path, body));
  };
}

test("commit requires all diff pages and confirmation, carries browser preference on preview and commit", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  mock((path, body) => {
    requests.push({ path, body });
    if (path.endsWith("/commit-preview")) return { token: "p", expiresAt: "2099-01-01", categories: ["general"], diffs: [{ category: "general", path: "settings/general.config.ts", changeType: "update", before: "secret", after: "secret", sensitive: true }], blockers: [], requiredMappings: [], nextCursor: "page2" };
    if (path.includes("/diffs?")) return { diffs: [] };
    return { committed: true, pushed: true, sha: "abc" };
  });
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings, { sync: true })));
  await screen.findByRole("button", { name: "进行备份（commit + push）" });
  fireEvent.change(await screen.findByLabelText("变更描述"), { target: { value: "backup" } });
  fireEvent.click(screen.getByRole("button", { name: "生成提交预览" }));
  const confirm = await screen.findByRole("button", { name: "进行备份（commit + push）" });
  fireEvent.click(screen.getByRole("checkbox"));
  assert.equal((confirm as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByText("secret"), null);
  fireEvent.click(screen.getByRole("button", { name: "加载剩余差异（全部加载后可确认）" }));
  await waitFor(() => assert.equal((confirm as HTMLButtonElement).disabled, false));
  fireEvent.click(confirm);
  await screen.findByText(/本地已提交 abc/);
  const preview = requests.findLast(r => r.path.endsWith("/commit-preview"))!.body;
  const commit = requests.find(r => r.path.endsWith("/commit"))!.body;
  assert.equal(preview.message, "backup");
  assert.equal(preview.push, true);
  assert.equal(commit.token, "p");
  assert.equal(commit.clientId, preview.clientId);
  assert.equal(commit.preferenceRevision, preview.preferenceRevision);
  assert.equal(commit.theme, "system");
});

test("repository settings includes description generation settings without sync or restore controls", async () => {
  mock(() => ({}));
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings)));
  await screen.findByText("git@example.test:config.git");
  assert.equal(screen.queryByLabelText("变更描述"), null);
  assert.equal(screen.queryByRole("button", { name: "从远端恢复" }), null);
  assert.equal(screen.queryByText("本地恢复点"), null);
  assert.ok(screen.getByRole("button", { name: "解除绑定" }));
  assert.ok(await screen.findByRole("combobox", { name: "生成描述的 Agent" }));
});

test("asynchronous commit preview polls operation result and renders raw file differences", async () => {
  mock(path => {
    if (path.endsWith("/commit-preview")) return { operationId: "preview-op", statusUrl: "/api/config-git/operations/preview-op", phase: "accepted" };
    if (path.endsWith("/operations/preview-op")) return { operationId: "preview-op", phase: "completed", result: { token: "raw", expiresAt: Date.now() + 60_000, diff: [{ path: "scripts/a/source.ts", before: null, after: "source" }], cumulativeDiff: [], push: true } };
    return {};
  });
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings, { sync: true })));
  fireEvent.click(await screen.findByRole("button", { name: "生成提交预览" }));
  await screen.findByText(/add · scripts\/a\/source.ts/);
  assert.ok(screen.getByRole("button", { name: "进行备份（commit + push）" }));
});

test("recovery-required operations keep writes locked and expose the recovery action", async () => {
  localStorage.setItem("orchard-config-git-operation", "recovery-op");
  mock(() => ({ operationId: "recovery-op", phase: "recovery_required", error: { code: "RECOVERY_REQUIRED", message: "恢复尚未完成" } }));
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings, { sync: true })));
  const recover = await screen.findByRole("button", { name: "重试恢复未完成阶段" });
  assert.equal((recover as HTMLButtonElement).disabled, false);
  assert.equal((screen.getByRole("button", { name: "生成提交预览" }) as HTMLButtonElement).disabled, true);
});

test("agent generates a description from a preview token and refreshes the bound commit preview", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  mock((path, body) => {
    requests.push({ path, body });
    if (path.endsWith("/commit-preview")) return { token: "agent-preview", expiresAt: Date.now() + 60000, diffs: [{ category: "scripts", path: "scripts/a.ts", changeType: "add" }] };
    if (path.endsWith("/message-agent")) return { agentConfigId: "commit-agent", name: "提交说明助手", available: true };
    if (path.endsWith("/generate-message")) return { message: "更新脚本配置" };
    return {};
  });
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings, { sync: true })));
  await screen.findByRole("button", { name: "进行备份（commit + push）" });
  assert.equal(screen.queryByRole("combobox", { name: "生成描述的 Agent" }), null);
  assert.ok(await screen.findByText(/使用「提交说明助手」生成描述/));
  fireEvent.click(screen.getByRole("button", { name: "生成提交预览" }));
  await screen.findByRole("region", { name: "配置差异预览" });
  const generate = screen.getByRole("button", { name: "用 Agent 生成描述" });
  assert.equal(generate.textContent, "");
  assert.equal(generate.getAttribute("title"), "用 Agent 生成描述");
  const editor = screen.getByLabelText("变更描述");
  assert.equal(editor.tagName, "TEXTAREA");
  const commitPanel = screen.getByRole("region", { name: "提交信息" });
  assert.ok(commitPanel.contains(editor));
  assert.ok(commitPanel.contains(generate));
  assert.equal(commitPanel.contains(screen.getByRole("region", { name: "配置差异预览" })), false);
  fireEvent.click(generate);
  await waitFor(() => assert.equal((screen.getByLabelText("变更描述") as HTMLInputElement).value, "更新脚本配置"));
  await waitFor(() => assert.equal(requests.filter(r => r.path.endsWith("/commit-preview")).length, 2));
  assert.deepEqual(requests.find(r => r.path.endsWith("/generate-message"))!.body, { token: "agent-preview" });
  assert.equal(requests.findLast(r => r.path.endsWith("/commit-preview"))!.body.message, "更新脚本配置");
});

test("repository settings saves a named model configuration for later sync dialogs", async () => {
  let setting = { agentConfigId: null as string | null, name: "", available: false };
  const writes: Record<string, unknown>[] = [];
  mock(() => ({}));
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/message-agent")) {
      if (options?.method === "PUT") {
        const body = JSON.parse(String(options.body)); writes.push(body);
        setting = { agentConfigId: body.agentConfigId, name: "提交说明助手", available: !!body.agentConfigId };
      }
      return Response.json(setting);
    }
    if (String(url).endsWith("/agent-model-configs")) return Response.json({ items: [{ id: "commit-agent", name: "提交说明助手", enabled: true, available: true, providerId: "pi", modelId: "explicit-model" }] });
    return fetch(url, options);
  };
  const view = render(createElement(ThemeProvider, null, createElement(ConfigGitSettings)));
  const picker = await screen.findByRole("combobox", { name: "生成描述的 Agent" });
  await waitFor(() => assert.equal((picker as HTMLButtonElement).disabled, false));
  fireEvent.keyDown(picker, { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: "提交说明助手" }));
  fireEvent.click(screen.getByRole("button", { name: "保存 Agent 设置" }));
  await screen.findByText("生成描述的 Agent 已保存");
  assert.deepEqual(writes, [{ agentConfigId: "commit-agent" }]);
  view.unmount();
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings, { sync: true })));
  assert.ok(await screen.findByText(/使用「提交说明助手」生成描述/));
  assert.equal(screen.queryByRole("combobox"), null);
});

for (const setting of [
  { agentConfigId: null, available: false },
  { agentConfigId: "disabled-agent", available: false, unavailableReason: "配置已禁用" },
]) test(`sync without an available saved Agent permits manual descriptions (${setting.agentConfigId ?? "unset"})`, async () => {
  mock(path => {
    if (path.endsWith("/message-agent")) return setting;
    if (path.endsWith("/commit-preview")) return { token: "manual", expiresAt: Date.now() + 60000, diffs: [{ category: "general", path: "settings/general.config.ts", changeType: "update" }] };
    return {};
  });
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings, { sync: true })));
  await screen.findByRole("button", { name: "进行备份（commit + push）" });
  assert.equal((screen.getByRole("button", { name: "用 Agent 生成描述" }) as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByRole("combobox"), null);
  assert.equal(screen.getByRole("link", { name: "前往设置" }).getAttribute("href"), "/settings?section=config-git");
  fireEvent.change(screen.getByLabelText("变更描述"), { target: { value: "手动描述" } });
  assert.equal((screen.getByRole("button", { name: "生成提交预览" }) as HTMLButtonElement).disabled, false);
});

test("raw previews preserve cumulative remote differences and restore details", () => {
  const commit = adaptPreview({ token: "c", expiresAt: 1000, diff: [{ path: "scripts/a/source.ts", before: null, after: "code" }], cumulativeDiff: [{ path: "settings/web-bridge.config.ts", before: "old", after: "new" }] });
  assert.equal(commit.diffs[0].category, "scripts");
  assert.equal(commit.cumulativeDiffs?.[0].category, "webBridge");
  const restore = adaptPreview({ token: "r", expiresAt: 1000, categories: ["webBridge"], changes: [{ category: "webBridge", objectId: "crm", changeType: "update", detail: "preserve local binding" }] });
  assert.equal(restore.diffs[0].detail, "preserve local binding");
});

test("global theme counts A to B to A and persists pre-apply receipt without double apply", async () => {
  function Probe() {
    const theme = useTheme();
    return createElement("button", { onClick: () => {
      theme.setTheme("dark"); theme.setTheme("system");
      const receipt = theme.consumePreference("restore-op", "apply", "light", true);
      assert.equal(receipt.revision, 2);
      assert.deepEqual(theme.consumePreference("restore-op", "apply", "light", true), receipt);
    } }, `${theme.theme}:${theme.preferenceRevision}`);
  }
  render(createElement(ThemeProvider, null, createElement(Probe)));
  fireEvent.click(screen.getByRole("button"));
  await screen.findByRole("button", { name: "light:3" });
  const saved = JSON.parse(localStorage.getItem(preferenceStorageKey)!);
  assert.deepEqual(saved.consumed["restore-op"], { decision: "apply", revision: 2, force: true });
});

test("automatic delivery acknowledges the pre-application revision with force false", async () => {
  const acks: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/pending?")) {
      const clientId = new URL(String(url), "http://localhost").searchParams.get("clientId");
      return Response.json([{ clientId, operationId: "delivery", revision: 0, theme: "dark" }]);
    }
    if (String(url).endsWith("/ack")) acks.push(JSON.parse(String(options?.body)));
    return Response.json({});
  };
  render(createElement(ThemeProvider, null, createElement(ConfigGitGeneralDelivery)));
  await waitFor(() => assert.equal(acks.length, 1));
  assert.equal(acks[0].preferenceRevision, 0);
  assert.equal(acks[0].force, false);
  assert.equal(JSON.parse(localStorage.getItem(preferenceStorageKey)!).preferenceRevision, 1);
});

const { RemoteConfigSync, canApplyRemote } = await import("../src/web/features/RemoteConfigSync.js");
const { parseDeclarations, parseInputBinding, RedactedPayload } = await import("../src/web/features/DictionaryEditors.js");

test("switching sync directions performs no fetch or preview request", async () => {
  const writes: string[] = [];
  mock(path => { if (/remote-sync-source|preview/.test(path)) writes.push(path); return {}; });
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings, { sync: true })));
  await screen.findByRole("button", { name: "生成提交预览" });
  fireEvent.click(screen.getByRole("button", { name: "从远端同步" }));
  await screen.findByRole("button", { name: "获取远端配置" });
  assert.deepEqual(writes, []);
});

const remoteSource = { bindingId: "b", branch: "main", sourceSha: "a".repeat(40), fetchedAt: "2026-11-10", commit: { subject: "跨设备配置", author: "tester", committedAt: "2026-11-10" }, snapshotState: "valid", supportedCategories: ["dictionaries", "workflows"] };
const remoteBinding = { id: "b", branch: "main", remoteUrl: "git@example.test:config.git", configDir: "orchard-config" };

test("discarding sync previews requires confirmation in the application dialog", async () => {
  const preview = { token: "p", expiresAt: Date.now() + 60000, categories: ["dictionaries"], diffs: [], blockers: [] };
  mock(path => {
    if (path.endsWith("/commit-preview")) return preview;
    if (path.endsWith("/remote-sync-source")) return remoteSource;
    if (path.endsWith("/restore-preview")) return { ...preview, requiredMappings: [{ key: "path", label: "本机路径" }] };
    return {};
  });
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings, { sync: true })));
  fireEvent.change(await screen.findByLabelText("变更描述"), { target: { value: "backup" } });
  fireEvent.click(screen.getByRole("button", { name: "生成提交预览" }));
  await screen.findByRole("checkbox");
  const remoteTab = screen.getByRole("button", { name: "从远端同步" });
  fireEvent.click(remoteTab);
  const backupDialog = await screen.findByRole("dialog", { name: "放弃当前备份预览？" });
  fireEvent.keyDown(backupDialog, { key: "Escape" });
  assert.equal(screen.queryByRole("dialog"), null);
  assert.ok(screen.getByRole("checkbox"));
  fireEvent.click(remoteTab);
  fireEvent.click(screen.getByRole("button", { name: "放弃并切换" }));

  fireEvent.click(await screen.findByRole("button", { name: "获取远端配置" }));
  fireEvent.click(await screen.findByRole("button", { name: "预览同步" }));
  const mapping = await screen.findByRole<HTMLInputElement>("textbox", { name: "本机路径" });
  fireEvent.change(mapping, { target: { value: "/local/path" } });
  fireEvent.click(screen.getByRole("button", { name: "返回备份" }));
  await screen.findByRole("dialog", { name: "放弃当前同步预览和映射输入？" });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  assert.equal(mapping.value, "/local/path");
  fireEvent.click(screen.getByRole("button", { name: "备份到远端" }));
  fireEvent.click(screen.getByRole("button", { name: "放弃并返回备份" }));
  fireEvent.click(remoteTab);
  assert.equal(screen.queryByRole("textbox", { name: "本机路径" }), null);
});

test("remote sync fixes source SHA, requires every diff page, confirms and previews recovery points", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  mock((path, body) => {
    requests.push({ path, body });
    if (path.endsWith("/remote-sync-source")) return remoteSource;
    if (path.endsWith("/restore-preview")) return { token: "remote-preview", expiresAt: Date.now() + 60000, categories: ["dictionaries", "workflows", "scripts"], diffs: [{ category: "dictionaries", path: "dictionaries/id", changeType: "update", sensitive: true, before: "HIDDEN_SENTINEL" }], blockers: [], requiredMappings: [], nextCursor: "next" };
    if (path.includes("/diffs?")) return { diffs: [{ category: "workflows", path: "workflows/id", changeType: "preserve" }] };
    if (path.endsWith("/restore")) return { sourceSha: remoteSource.sourceSha, recoveryPointId: "point", result: { updated: 1 } };
    return {};
  });
  render(createElement(ThemeProvider, null, createElement(RemoteConfigSync, { visible: true, binding: remoteBinding, onApplied: () => {}, onLeave: () => {} })));
  fireEvent.click(screen.getByRole("button", { name: "获取远端配置" }));
  await screen.findByText("跨设备配置");
  fireEvent.click(screen.getByRole("button", { name: "预览同步" }));
  await screen.findByText(/依赖自动补入：脚本/);
  assert.equal(screen.queryByText("HIDDEN_SENTINEL"), null);
  const apply = screen.getByRole("button", { name: "应用到本机" }) as HTMLButtonElement;
  assert.equal(apply.disabled, true);
  fireEvent.click(screen.getByRole("button", { name: /加载剩余差异/ }));
  await waitFor(() => assert.equal((screen.getByRole("checkbox", { name: /已查看差异/ }) as HTMLInputElement).disabled, false));
  fireEvent.click(screen.getByRole("checkbox", { name: /已查看差异/ }));
  fireEvent.click(apply);
  fireEvent.click(await screen.findByRole("button", { name: "查看同步前配置" }));
  fireEvent.click(screen.getByRole("button", { name: "预览同步" }));
  await waitFor(() => assert.equal(requests.filter(r => r.path.endsWith("/restore-preview")).length, 2));
  const previews = requests.filter(r => r.path.endsWith("/restore-preview"));
  assert.deepEqual(previews[0].body.source, { kind: "git", sha: remoteSource.sourceSha });
  assert.deepEqual(previews[1].body.source, { kind: "recovery-point", id: "point" });
  const applyBody = requests.find(r => r.path.endsWith("/restore"))!.body;
  assert.deepEqual(Object.keys(applyBody).sort(), ["requestId", "token"]);
});

test("persisted remote operation kind restores fetched metadata after refresh", async () => {
  localStorage.setItem("orchard-config-git-remote-operation", JSON.stringify({ operationId: "fetch-op", kind: "fetch" }));
  mock(path => path.endsWith("/operations/fetch-op") ? { operationId: "fetch-op", phase: "completed", result: remoteSource } : {});
  render(createElement(ThemeProvider, null, createElement(RemoteConfigSync, { visible: true, binding: remoteBinding, onApplied: () => {}, onLeave: () => {} })));
  await screen.findByText("跨设备配置");
  assert.equal(localStorage.getItem("orchard-config-git-remote-operation"), null);
  assert.equal((screen.getByRole("button", { name: "预览同步" }) as HTMLButtonElement).disabled, false);
});

test("remote confirmation rejects expired, blocked, missing mappings, no-op and stale previews", () => {
  const p = adaptPreview({ token: "p", expiresAt: Date.now() + 60000, diffs: [], requiredMappings: [], blockers: [] });
  assert.equal(canApplyRemote(p, true, {}, false), true);
  for (const variant of [{ ...p, expiresAt: 0 }, { ...p, blockers: ["conflict"] }, { ...p, nextCursor: "more" }, { ...p, noChanges: true }, { ...p, requiredMappings: [{ key: "path", label: "路径" }] }]) assert.equal(canApplyRemote(variant, true, {}, false), false);
  assert.equal(canApplyRemote(p, true, {}, true), false);
  assert.equal(canApplyRemote(p, false, {}, false), false);
});

test("dictionary editors validate declarations and preserve nested dictionary bindings", () => {
  const declaration = { service: { dictionaryId: "12345678-1234-1234-1234-123456789abc", kind: "plain", keys: ["url"] } };
  assert.deepEqual(parseDeclarations(JSON.stringify(declaration)), declaration);
  assert.throws(() => parseDeclarations(JSON.stringify({ ...declaration, secret: { dictionaryId: "bad", kind: "encrypted", keys: [] } })));
  const binding = { source: "object", properties: { values: { source: "array", items: [{ source: "dictionary", dictionaryId: declaration.service.dictionaryId, key: "url", pointer: "/nested" }] } } };
  assert.deepEqual(parseInputBinding(JSON.stringify(binding)), binding);
  assert.throws(() => parseInputBinding('{"source":"dictionary","dictionaryId":"id","key":"url","pointer":"bad"}'));
  render(createElement(RedactedPayload, { redacted: true, value: "MUST_NOT_RENDER" }));
  assert.equal(screen.queryByText("MUST_NOT_RENDER"), null);
  assert.ok(screen.getByText(/内容已隐藏/));
});

test("mapping edits expire the token until preview regeneration, and failed fetch keeps source stale", async () => {
  let failFetch = false, previewCount = 0;
  const calls: Record<string, unknown>[] = [];
  mock((path, body) => {
    if (path.endsWith('/remote-sync-source')) {
      if (failFetch) throw new Error('网络中断');
      return remoteSource;
    }
    if (path.endsWith('/restore-preview')) {
      calls.push(body); previewCount++;
      return { token: `mapping-${previewCount}`, expiresAt: Date.now() + 60000, categories: ['scripts'], diffs: [{ category: 'scripts', path: 'scripts/a', changeType: 'update' }], blockers: [], requiredMappings: [{ key: 'runtime', label: '运行时路径' }] };
    }
    return {};
  });
  render(createElement(ThemeProvider, null, createElement(RemoteConfigSync, { visible: true, binding: remoteBinding, onApplied: () => {}, onLeave: () => {} })));
  fireEvent.click(screen.getByRole('button', { name: '获取远端配置' }));
  await screen.findByText('跨设备配置');
  fireEvent.click(screen.getByRole('button', { name: '预览同步' }));
  fireEvent.change(await screen.findByLabelText('运行时路径'), { target: { value: '/usr/bin/node' } });
  assert.equal((screen.getByRole('button', { name: '应用到本机' }) as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByRole('button', { name: '更新映射并重新预览' }));
  await waitFor(() => assert.equal(previewCount, 2));
  assert.deepEqual(calls[1].mappings, { runtime: '/usr/bin/node' });
  fireEvent.click(screen.getByRole('checkbox', { name: /已查看差异/ }));
  assert.equal((screen.getByRole('button', { name: '应用到本机' }) as HTMLButtonElement).disabled, false);
  failFetch = true;
  fireEvent.click(screen.getByRole('button', { name: '获取远端配置' }));
  await screen.findByText('网络中断');
  assert.ok(screen.getByText('跨设备配置'));
  assert.equal((screen.getByRole('button', { name: '预览同步' }) as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByRole('button', { name: '应用到本机' }), null);
});

test('rejected mapping validation unlocks the original inputs and permits a corrected preview', async () => {
  const requests: Record<string, unknown>[] = [];
  mock(path => {
    if (path.endsWith('/remote-sync-source')) return remoteSource;
    return { token: 'mapping-preview', expiresAt: Date.now() + 60000, categories: ['providers'], diffs: [{ category: 'providers', path: 'providers/pi-cli', changeType: 'update' }], blockers: [], requiredMappings: [{ key: 'runtime', label: '运行时路径' }] };
  });
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/restore-preview')) {
      const body = JSON.parse(String(options?.body));
      requests.push(body);
      if (body.mappings?.runtime?.length > 4096) return Response.json({ code: 'INVALID_INPUT', message: '映射路径过长' }, { status: 422 });
    }
    return baseFetch(url, options);
  };
  render(createElement(ThemeProvider, null, createElement(RemoteConfigSync, { visible: true, binding: remoteBinding, onApplied: () => {}, onLeave: () => {} })));
  fireEvent.click(screen.getByRole('button', { name: '获取远端配置' }));
  await screen.findByText('跨设备配置');
  fireEvent.click(screen.getByRole('button', { name: '预览同步' }));
  fireEvent.change(await screen.findByLabelText('运行时路径'), { target: { value: 'x'.repeat(4097) } });
  fireEvent.click(screen.getByRole('button', { name: '更新映射并重新预览' }));
  await screen.findByText('映射路径过长');
  assert.equal(localStorage.getItem('orchard-config-git-remote-operation'), null);
  assert.equal(screen.queryByRole('button', { name: '重试查询原请求' }), null);
  assert.equal((screen.getByLabelText('运行时路径') as HTMLInputElement).disabled, false);
  fireEvent.change(screen.getByLabelText('运行时路径'), { target: { value: '/usr/bin/node' } });
  fireEvent.click(screen.getByRole('button', { name: '更新映射并重新预览' }));
  await waitFor(() => assert.equal(requests.length, 3));
  await waitFor(() => assert.equal((screen.getByRole('button', { name: '更新映射并重新预览' }) as HTMLButtonElement).disabled, false));
  assert.deepEqual(requests[2].mappings, { runtime: '/usr/bin/node' });
  assert.notEqual(requests[1].requestId, requests[2].requestId);
});

test('server failure keeps the request pinned until its acknowledgement is recovered', async () => {
  globalThis.fetch = async () => Response.json({ code: 'INTERNAL_ERROR', message: '服务异常' }, { status: 500 });
  render(createElement(ThemeProvider, null, createElement(RemoteConfigSync, { visible: true, binding: remoteBinding, onApplied: () => {}, onLeave: () => {} })));
  fireEvent.click(screen.getByRole('button', { name: '获取远端配置' }));
  await screen.findByText('服务异常');
  assert.ok(localStorage.getItem('orchard-config-git-remote-operation'));
  assert.ok(screen.getByRole('button', { name: '重试查询原请求' }));
  assert.equal((screen.getByRole('button', { name: '获取远端配置' }) as HTMLButtonElement).disabled, true);
});

for (const responseMode of ['operation', 'receipt'] as const) test(`lost apply ACK survives reload and resumes the original request (${responseMode})`, async () => {
  const storage = 'orchard-config-git-remote-operation';
  const restoreRequests: Record<string, unknown>[] = [];
  const accepted = new Map<string, Record<string, unknown>>();
  let executions = 0, loseAck = true, failRecovery = true, applied = 0;
  const receipt = { sourceSha: remoteSource.sourceSha, recoveryPointId: 'before-lost-ack', result: { changed: 1 } };
  mock((path, body) => {
    if (path.endsWith('/remote-sync-source')) return remoteSource;
    if (path.endsWith('/restore-preview')) return { token: 'confirmed-before-disconnect', expiresAt: Date.now() + 60000, categories: ['dictionaries'], diffs: [{ category: 'dictionaries', path: 'dictionaries/shared', changeType: 'update', sensitive: true, before: 'DO_NOT_PERSIST_DICTIONARY_VALUE' }], blockers: [], requiredMappings: [] };
    if (path.endsWith('/restore')) {
      // Persistence must already be durable at the moment HTTP is sent.
      const saved = JSON.parse(localStorage.getItem(storage)!);
      assert.equal(saved.kind, 'apply');
      assert.equal(saved.path, '/restore');
      assert.deepEqual(saved.payload, { token: 'confirmed-before-disconnect' });
      assert.equal(saved.requestId, body.requestId);
      assert.equal(saved.operationId, undefined);
      assert.equal(localStorage.getItem(storage)!.includes('DO_NOT_PERSIST_DICTIONARY_VALUE'), false);
      restoreRequests.push(body);
      const id = String(body.requestId);
      if (!accepted.has(id)) { accepted.set(id, body); executions++; }
      if (loseAck) { loseAck = false; throw new Error('accepted but HTTP ACK lost'); }
      if (failRecovery) { failRecovery = false; throw new Error('recovery temporarily offline'); }
      return responseMode === 'operation' ? { operationId: 'original-apply', statusUrl: '/api/config-git/operations/original-apply' } : receipt;
    }
    if (path.endsWith('/operations/original-apply')) return { operationId: 'original-apply', phase: 'completed', result: receipt };
    return {};
  });
  const props = { visible: true, binding: remoteBinding, onApplied: () => { applied++; }, onLeave: () => {} };
  const view = render(createElement(ThemeProvider, null, createElement(RemoteConfigSync, props)));
  fireEvent.click(screen.getByRole('button', { name: '获取远端配置' }));
  await screen.findByText('跨设备配置');
  fireEvent.click(screen.getByRole('button', { name: '预览同步' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /已查看差异/ }));
  fireEvent.click(screen.getByRole('button', { name: '应用到本机' }));
  await screen.findByText('accepted but HTTP ACK lost');
  assert.equal(executions, 1);
  const pending = localStorage.getItem(storage);
  assert.ok(pending);
  assert.equal((screen.getByRole('button', { name: '获取远端配置' }) as HTMLButtonElement).disabled, true);
  view.unmount();
  // New context has neither the old source nor its confirmed preview. Only the
  // persisted, previously authorized request may be replayed after reload.
  render(createElement(ThemeProvider, null, createElement(RemoteConfigSync, { ...props, binding: { ...remoteBinding, id: 'different-binding', branch: 'other' } })));
  await screen.findByText(/recovery temporarily offline/);
  assert.equal(localStorage.getItem(storage), pending);
  assert.equal(screen.queryByRole('button', { name: '应用到本机' }), null);
  assert.equal((screen.getByRole('button', { name: '获取远端配置' }) as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByRole('button', { name: '重试查询原请求' }));
  await screen.findByRole('status', { name: '同步结果' });
  assert.equal(restoreRequests.length, 3);
  for (const request of restoreRequests) assert.deepEqual(request, restoreRequests[0]);
  assert.equal(executions, 1);
  assert.equal(applied, 1);
  assert.equal(localStorage.getItem(storage), null);
  assert.equal(screen.queryByRole('button', { name: '应用到本机' }), null);
});
