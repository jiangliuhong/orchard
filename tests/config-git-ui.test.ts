import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "MutationObserver", "Event", "getComputedStyle", "localStorage", "navigator"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { ConfigGitSettings, ConfigGitGeneralDelivery, adaptPreview } = await import("../src/web/features/ConfigGitSettings.js");
const { ThemeProvider, useTheme, preferenceStorageKey } = await import("../src/web/lib/theme.js");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); localStorage.clear(); globalThis.fetch = originalFetch; });

function mock(extra: (path: string, body: Record<string, unknown>) => unknown) {
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {};
    if (path.endsWith("/repository")) return Response.json({ binding: { id: "b", remoteUrl: "git@example.test:config.git", branch: "main", configDir: "orchard-config", snapshotState: "valid" } });
    if (path.endsWith("/status")) return Response.json({ ahead: 0, behind: 0, diverged: false, dirtyPaths: [] });
    if (path.endsWith("/recovery-points") || path.endsWith("/providers")) return Response.json({ items: [] });
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

test("settings contains only repository configuration, without sync or restore controls", async () => {
  mock(() => ({}));
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings)));
  await screen.findByText("git@example.test:config.git");
  assert.equal(screen.queryByLabelText("变更描述"), null);
  assert.equal(screen.queryByRole("button", { name: "从远端恢复" }), null);
  assert.equal(screen.queryByText("本地恢复点"), null);
  assert.ok(screen.getByRole("button", { name: "解除绑定" }));
});

test("asynchronous commit preview polls operation result and renders raw file differences", async () => {
  mock(path => {
    if (path.endsWith("/commit-preview")) return { operationId: "preview-op", statusUrl: "/api/config-git/operations/preview-op", phase: "accepted" };
    if (path.endsWith("/operations/preview-op")) return { operationId: "preview-op", phase: "completed", result: { token: "raw", expiresAt: Date.now() + 60_000, diff: [{ path: "scripts/a/source.ts", before: null, after: "source" }], cumulativeDiff: [], push: true } };
    return {};
  });
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings, { sync: true })));
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
  const original = mock;
  original((path, body) => {
    requests.push({ path, body });
    if (path.endsWith("/commit-preview")) return { token: "agent-preview", expiresAt: Date.now() + 60000, diffs: [{ category: "scripts", path: "scripts/a.ts", changeType: "add" }] };
    if (path.endsWith("/generate-message")) return { message: "更新脚本配置" };
    return {};
  });
  const fetch = globalThis.fetch;
  globalThis.fetch = (url, options) => String(url).endsWith("/providers") ? Promise.resolve(Response.json({ items: [{ id: "pi", name: "Pi", enabled: true }] })) : fetch(url, options);
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings, { sync: true })));
  await screen.findByRole("button", { name: "进行备份（commit + push）" });
  fireEvent.change(screen.getByLabelText("生成描述的 Agent"), { target: { value: "pi" } });
  fireEvent.click(screen.getByRole("button", { name: "用 Agent 生成描述" }));
  await waitFor(() => assert.equal((screen.getByLabelText("变更描述") as HTMLInputElement).value, "更新脚本配置"));
  await waitFor(() => assert.equal(requests.filter(r => r.path.endsWith("/commit-preview")).length, 2));
  assert.deepEqual(requests.find(r => r.path.endsWith("/generate-message"))!.body, { token: "agent-preview", providerId: "pi" });
  assert.equal(requests.findLast(r => r.path.endsWith("/commit-preview"))!.body.message, "更新脚本配置");
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
