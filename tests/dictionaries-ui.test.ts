import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
// Radix Select 等组件依赖完整的 DOM 全局；镜像 JSDOM window 上缺失的属性。
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (!(key in globalThis)) {
    try { Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as Record<string, unknown>)[key] }); } catch { /* 部分属性不可定义时跳过 */ }
  }
}
for (const key of ["window", "document", "Event", "CustomEvent", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLFormElement", "DocumentFragment", "Node", "Element", "MutationObserver", "getComputedStyle", "navigator"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
const { render, screen, fireEvent, cleanup, waitFor, within } = await import("@testing-library/react");
const { SecretKeySettings } = await import("../src/web/features/SecretKeySettings.js");
const { DictionariesPage } = await import("../src/web/features/DictionariesPage.js");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("字典空状态：中间加号和页头按钮均可打开新建字典弹窗", async () => {
  globalThis.fetch = (async () => Response.json({ items: [], nextCursor: null })) as typeof fetch;
  const { container } = render(createElement(DictionariesPage));
  await screen.findByText("还没有字典");
  const emptyButton = container.querySelector<HTMLButtonElement>(".empty button");
  assert.ok(emptyButton);
  assert.equal(emptyButton.getAttribute("aria-label"), "新建字典");
  fireEvent.click(emptyButton);
  await screen.findByRole("dialog", { name: "新建字典" });
  assert.ok(screen.getByLabelText("名称（1–100 字符）"));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  fireEvent.click(screen.getAllByRole("button", { name: "新建字典" })[0]!);
  await screen.findByRole("dialog", { name: "新建字典" });
});

test("字典列表：有无备注均展示字典类型和键数量", async () => {
  globalThis.fetch = (async () => Response.json({ items: [
    { id: "plain", name: "配置", kind: "plain", description: "共享配置备注", keyCount: 3, enabled: true, updatedAt: 1 },
    { id: "encrypted", name: "凭据", kind: "encrypted", description: "凭据备注", keyCount: 2, enabled: true, readiness: "ready", updatedAt: 1 },
    { id: "empty", name: "空字典", kind: "plain", description: "", keyCount: 0, enabled: false, updatedAt: 1 },
  ], nextCursor: null })) as typeof fetch;
  render(createElement(DictionariesPage));
  for (const [id, metadata, description] of [
    ["plain", "普通字典 · 3 个键", "共享配置备注"],
    ["encrypted", "加密字典 · 2 个键", "凭据备注"],
    ["empty", "普通字典 · 0 个键", ""],
  ]) {
    const metadataElement = await screen.findByText(metadata!);
    const row = metadataElement.closest("a");
    assert.equal(row?.getAttribute("href"), `/dictionaries/${id}`);
    if (description) assert.ok(row?.textContent?.includes(description));
  }
});

test("字典删除交互：取消不发请求，失败保留弹窗，成功刷新并可彻底删除", async () => {
  let deleted = false, purged = false, fail = true;
  const requests: Record<string, unknown>[] = [];
  const item = { id: "dict", name: "测试配置", kind: "plain", description: "", keyCount: 0, enabled: true, updatedAt: 1 };
  globalThis.fetch = (async (url, options) => {
    if (options?.method === "DELETE") {
      const body = JSON.parse(String(options.body)); requests.push(body);
      if (fail) return Response.json({ message: "仍有当前工作流引用" }, { status: 409 });
      if (body.permanent) purged = true; else deleted = true;
      return Response.json({ deleted: true });
    }
    const inTrash = String(url).includes("deleted=true");
    return Response.json({ items: !purged && deleted === inTrash ? [{ ...item, revision: deleted ? 2 : 1, deletedAt: deleted ? 10 : null }] : [], nextCursor: null });
  }) as typeof fetch;
  render(createElement(DictionariesPage));
  fireEvent.click(await screen.findByRole("button", { name: "删除字典 测试配置" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  assert.equal(requests.length, 0);
  fireEvent.click(screen.getByRole("button", { name: "删除字典 测试配置" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await screen.findByText("仍有当前工作流引用");
  assert.ok(screen.getByRole("dialog"));
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => assert.ok(!screen.queryByRole("dialog")));
  await screen.findByText("还没有字典");
  assert.equal(requests[0]!.requestId, requests[1]!.requestId);
  assert.equal(requests[1]!.expectedRevision, 1);
  fireEvent.click(screen.getByRole("button", { name: "已删除" }));
  fireEvent.click(await screen.findByRole("button", { name: "彻底删除 测试配置" }));
  const confirm = screen.getByRole("button", { name: "确认彻底删除" }) as HTMLButtonElement;
  assert.equal(confirm.disabled, true);
  fireEvent.change(screen.getByLabelText("输入完整字典名称确认"), { target: { value: "错误" } });
  assert.equal(confirm.disabled, true);
  fireEvent.change(screen.getByLabelText("输入完整字典名称确认"), { target: { value: "测试配置" } });
  fireEvent.click(confirm);
  await screen.findByText("没有已删除字典");
  assert.equal(requests[2]!.permanent, true);
  assert.equal(requests[2]!.confirmationName, "测试配置");
  assert.equal(requests[2]!.expectedRevision, 2);
});

const unconfigured = { configured: false, generation: 0, activeKeyId: null, readOnly: false, keys: [], encryptedDictionaries: 0, missingKeyIds: [] };
const configured = (generation = 1, activeKeyId = "key-aaaaaaaa") => ({
  configured: true, generation, activeKeyId, readOnly: false,
  keys: [{ keyId: activeKeyId, createdAt: 1700000000000, active: true }], encryptedDictionaries: 1, missingKeyIds: [],
});

test("密钥设置页：未配置提示、生成请求携带代次与 requestId、成功后只显示安全元数据", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let state: unknown = unconfigured;
  globalThis.fetch = (async (url, options) => {
    const path = String(url), body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {};
    if (path.endsWith("/secrets/status")) return Response.json(state);
    if (path.endsWith("/secrets/keys")) {
      requests.push({ path, body });
      const keyId = "key-newgenerated";
      state = configured(1, keyId);
      return Response.json({ keyId, generation: 1 });
    }
    return Response.json({});
  }) as typeof fetch;
  render(createElement(SecretKeySettings));
  await screen.findByText(/尚未配置密钥环/);
  assert.equal(screen.queryByText(/material/i), null);
  fireEvent.click(screen.getByRole("button", { name: "生成密钥" }));
  await screen.findByText(/请立即下载备份/);
  await waitFor(() => assert.equal(requests.length, 1));
  assert.equal(requests[0]!.body.expectedGeneration, 0);
  assert.equal(typeof requests[0]!.body.requestId, "string");
  // 刷新后展示活动密钥标识与代次，不回填任何密钥材料。
  await waitFor(() => assert.ok(within(screen.getByLabelText("密钥环状态")).getByText("key-newg…")));
  assert.equal(screen.queryByText(/generateKeyMaterial|randomBytes/), null);
});

test("密钥设置页：导入完成或取消后清空文本，备份下载使用 POST 且释放 Blob URL", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let revoked = 0;
  const originalCreate = globalThis.URL.createObjectURL, originalRevoke = globalThis.URL.revokeObjectURL;
  globalThis.URL.createObjectURL = () => "blob:mock";
  globalThis.URL.revokeObjectURL = () => { revoked += 1; };
  let state: unknown = configured();
  globalThis.fetch = (async (url, options) => {
    const path = String(url), body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {};
    if (path.endsWith("/secrets/status")) return Response.json(state);
    if (path.endsWith("/secrets/import")) {
      requests.push({ path, body });
      state = configured(2);
      return Response.json({ added: 1, unchanged: 0 });
    }
    if (path.endsWith("/secrets/export")) {
      requests.push({ path, body });
      return Response.json({ formatVersion: 1, keys: [{ keyId: "key-aaaaaaaa", algorithm: "aes-256-gcm", material: "TOPSECRET" }] });
    }
    return Response.json({});
  }) as typeof fetch;
  render(createElement(SecretKeySettings));
  await screen.findByLabelText("密钥环状态");
  assert.ok(within(screen.getByLabelText("密钥环状态")).getByText("key-aaaa…"));
  fireEvent.click(screen.getByRole("button", { name: "导入备份" }));
  const textarea = await screen.findByLabelText(/粘贴完整备份文本/);
  fireEvent.change(textarea, { target: { value: '{"formatVersion":1,"keys":[{"keyId":"key-bb","algorithm":"aes-256-gcm","material":"x"}],"activeKeyId":"key-bb"}' } });
  fireEvent.click(screen.getByRole("button", { name: "导入并合并" }));
  await screen.findByText(/导入完成：新增 1 把/);
  assert.equal((requests[0]!.body.backupText as string).includes("key-bb"), true);
  // 提交完成后临时表单关闭并清空文本，浏览器持久化不回填材料。
  assert.equal(screen.queryByLabelText(/粘贴完整备份文本/), null);
  // 等待导入后的状态刷新（代次 2）再下载，避免使用过期代次。
  await screen.findByText(/代次 2/);
  // 下载：POST 请求、Blob URL 释放、页面不显示材料。
  fireEvent.click(screen.getByRole("button", { name: "下载备份" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认下载全部密钥" }));
  await screen.findByText(/已下载包含 1 把密钥的备份/);
  const exportRequest = requests.find(request => request.path.endsWith("/secrets/export"))!;
  assert.equal(exportRequest.body.expectedGeneration, 2);
  assert.equal(revoked, 1);
  assert.equal(screen.queryByText("TOPSECRET"), null);
  globalThis.URL.createObjectURL = originalCreate;
  globalThis.URL.revokeObjectURL = originalRevoke;
});

test("密钥设置页：验证结果只含安全诊断，不出现明文或材料", async () => {
  globalThis.fetch = (async (url, options) => {
    const path = String(url);
    if (path.endsWith("/secrets/status")) return Response.json(configured(3));
    if (path.endsWith("/secrets/verify")) {
      void JSON.parse(String(options?.body));
      return Response.json({ generation: 3, keyFingerprint: "f".repeat(64), dictionaries: [
        { dictionaryId: "d1", versionId: "v1", entries: 2, verified: 1, missingKeyIds: ["ghost"], failedKeys: ["apiToken"] },
      ], verified: false, message: "验证完成" });
    }
    return Response.json({});
  }) as typeof fetch;
  render(createElement(SecretKeySettings));
  await screen.findByLabelText("密钥环状态");
  assert.ok(within(screen.getByLabelText("密钥环状态")).getByText("key-aaaa…"));
  fireEvent.click(screen.getByRole("button", { name: "验证解密" }));
  await screen.findByText(/验证完成/);
  assert.ok(screen.getByText(/认证失败键 apiToken/));
  assert.equal(screen.queryByText(/TOPSECRET/), null);
});
