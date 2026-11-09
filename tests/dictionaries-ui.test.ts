import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
// Radix Select 等组件依赖完整的 DOM 全局；镜像 JSDOM window 上缺失的属性。
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (!(key in globalThis)) {
    try { Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as Record<string, unknown>)[key] }); } catch { /* 部分属性不可定义时跳过 */ }
  }
}
for (const key of ["window", "document", "Event", "CustomEvent", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLFormElement", "DocumentFragment", "Node", "Element", "MutationObserver", "getComputedStyle", "navigator"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { SecretKeySettings } = await import("../src/web/features/SecretKeySettings.js");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

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
  await screen.findByText(/活动密钥 key-new/);
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
  await screen.findByText(/活动密钥 key-aa/);
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
  await screen.findByText(/活动密钥 key-aa/);
  fireEvent.click(screen.getByRole("button", { name: "验证解密" }));
  await screen.findByText(/验证完成/);
  assert.ok(screen.getByText(/认证失败键 apiToken/));
  assert.equal(screen.queryByText(/TOPSECRET/), null);
});
