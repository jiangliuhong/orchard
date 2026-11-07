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
    if (path.endsWith("/recovery-points")) return Response.json({ items: [] });
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
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings)));
  fireEvent.change(await screen.findByLabelText("提交说明"), { target: { value: "backup" } });
  fireEvent.click(screen.getByRole("button", { name: "生成提交预览" }));
  const confirm = await screen.findByRole("button", { name: "确认提交并推送" });
  fireEvent.click(screen.getByRole("checkbox"));
  assert.equal((confirm as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByText("secret"), null);
  fireEvent.click(screen.getByRole("button", { name: "加载剩余差异（全部加载后可确认）" }));
  await waitFor(() => assert.equal((confirm as HTMLButtonElement).disabled, false));
  fireEvent.click(confirm);
  await screen.findByText(/本地已提交 abc/);
  const preview = requests.find(r => r.path.endsWith("/commit-preview"))!.body;
  const commit = requests.find(r => r.path.endsWith("/commit"))!.body;
  assert.equal(preview.message, "backup");
  assert.equal(preview.push, true);
  assert.equal(commit.token, "p");
  assert.equal(commit.clientId, preview.clientId);
  assert.equal(commit.preferenceRevision, preview.preferenceRevision);
  assert.equal(commit.theme, "system");
});

test("remote restore finishes fetch before listing remote history", async () => {
  const paths: string[] = [];
  mock(path => {
    paths.push(path);
    if (path.endsWith("/fetch")) return { message: "fetched" };
    if (path.includes("/commits?")) return { items: [], startSha: "abc" };
    return {};
  });
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings)));
  fireEvent.click(await screen.findByRole("button", { name: "从远端恢复" }));
  await screen.findByText("没有可恢复的配置提交。");
  assert.ok(paths.indexOf("/api/config-git/fetch") < paths.findIndex(p => p.includes("source=remote")));
});

test("asynchronous commit preview polls operation result and renders raw file differences", async () => {
  mock(path => {
    if (path.endsWith("/commit-preview")) return { operationId: "preview-op", statusUrl: "/api/config-git/operations/preview-op", phase: "accepted" };
    if (path.endsWith("/operations/preview-op")) return { operationId: "preview-op", phase: "completed", result: { token: "raw", expiresAt: Date.now() + 60_000, diff: [{ path: "scripts/a/source.ts", before: null, after: "source" }], cumulativeDiff: [], push: true } };
    return {};
  });
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings)));
  fireEvent.change(await screen.findByLabelText("提交说明"), { target: { value: "async backup" } });
  fireEvent.click(screen.getByRole("button", { name: "生成提交预览" }));
  await screen.findByText(/add · scripts\/a\/source.ts/);
  assert.ok(screen.getByRole("button", { name: "确认提交并推送" }));
});

test("interrupted operations stop locking the page after restart and allow result checks and a new preview", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  localStorage.setItem("orchard-config-git-operation", "interrupted-op");
  mock((path, body) => {
    requests.push({ path, body });
    if (path.endsWith("/operations/interrupted-op")) return { operationId: "interrupted-op", phase: "interrupted", error: { code: "OPERATION_INTERRUPTED", message: "服务已重启" } };
    if (path.includes("/commits?")) return { items: [{ sha: "previous", message: "之前的提交", author: "Test", date: "2026-11-06" }], startSha: "previous" };
    if (path.endsWith("/commit-preview")) return { token: "new-preview", expiresAt: Date.now() + 60_000, categories: ["general"], diffs: [], blockers: [], requiredMappings: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  const mount = () => render(createElement(ThemeProvider, null, createElement(ConfigGitSettings)));
  const first = mount();
  await screen.findByText(/操作结果尚未确认/);
  assert.equal((screen.getByRole("button", { name: "推送" }) as HTMLButtonElement).disabled, false);
  first.unmount(); mount();
  await screen.findByText(/操作结果尚未确认/);
  assert.equal((screen.getByRole("button", { name: "推送" }) as HTMLButtonElement).disabled, false);
  fireEvent.click(screen.getByRole("button", { name: "核对状态与本地历史" }));
  await screen.findByText("之前的提交");
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(requests.filter(r => r.path.endsWith("/operations/interrupted-op")).length, 2);
  assert.ok(requests.every(r => Object.keys(r.body).length === 0), "result checks must not replay a write");
  fireEvent.change(screen.getByLabelText("提交说明"), { target: { value: "retry after checking" } });
  fireEvent.click(screen.getByRole("button", { name: "生成提交预览" }));
  const confirm = await screen.findByRole("button", { name: "确认提交并推送" });
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => assert.equal((confirm as HTMLButtonElement).disabled, false));
});

test("recovery-required operations keep writes locked and expose the recovery action", async () => {
  localStorage.setItem("orchard-config-git-operation", "recovery-op");
  mock(() => ({ operationId: "recovery-op", phase: "recovery_required", error: { code: "RECOVERY_REQUIRED", message: "恢复尚未完成" } }));
  render(createElement(ThemeProvider, null, createElement(ConfigGitSettings)));
  const recover = await screen.findByRole("button", { name: "重试恢复未完成阶段" });
  assert.equal((recover as HTMLButtonElement).disabled, false);
  assert.equal((screen.getByRole("button", { name: "推送" }) as HTMLButtonElement).disabled, true);
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
