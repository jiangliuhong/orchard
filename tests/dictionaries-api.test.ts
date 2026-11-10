import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setup } from "./helpers.js";
import { createApp } from "../src/server/app.js";
import type { TestContext } from "node:test";

const HOST = "127.0.0.1:7441";

function harness(t: TestContext) {
  const { store, providers } = setup(t);
  const handle = createApp(store, providers);
  const app = handle.app;
  t.after(() => app.close());
  // LocalApiAuth 在 app.ready() 后的 initialize 中落盘；服务实例也必须经 getter 在 ready 后访问。
  let cachedToken = "";
  const token = async () => {
    await app.ready();
    if (!cachedToken) cachedToken = readFileSync(join(store.root, "runtime", "api-token"), "utf8").trim();
    return cachedToken;
  };
  return { store, app, token, dictionaries: () => handle.dictionaries };
}

const harnessCacheMap = new Map<TestContext, ReturnType<typeof harness>>();
function harnessCache(t: TestContext) {
  let value = harnessCacheMap.get(t);
  if (!value) { value = harness(t); harnessCacheMap.set(t, value); }
  return value;
}

/** 敏感调用默认带同源 Origin；可覆盖头以测试守卫。 */
function sensitiveHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return { origin: `http://${HOST}`, "sec-fetch-site": "same-origin", ...headers };
}

test("字典 HTTP：就绪状态认证当前密钥材料，替换和恢复密钥无需重启", async t => {
  const handle = harness(t);
  await handle.app.ready();
  const dictionaries = handle.dictionaries(), secrets = dictionaries.secrets;
  secrets.generate({ requestId: "generate", expectedGeneration: 0 });
  const created = dictionaries.create({ requestId: "create", name: "认证字典", description: "", kind: "encrypted", enabled: true,
    operations: [{ op: "set", key: "token", type: "string", value: "SENSITIVE_DICTIONARY_VALUE" }] });
  const path = secrets.keyring.path, original = readFileSync(path, "utf8");
  const get = () => handle.app.inject({ url: `/api/dictionaries/${created.dictionaryId}`, headers: { host: HOST } });
  assert.equal((await get()).json().readiness, "ready");
  const wrong = JSON.parse(original);
  wrong.keys[0].material = Buffer.alloc(32, 3).toString("base64");
  writeFileSync(path, JSON.stringify(wrong));
  const failed = await get();
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.json().readiness, "authentication-failed");
  assert.deepEqual(failed.json().missingKeyIds, []);
  assert.equal(failed.body.includes("SENSITIVE_DICTIONARY_VALUE"), false);
  assert.equal(failed.body.includes(wrong.keys[0].material), false);
  assert.equal(failed.body.includes("encryptedValue"), false);
  const filtered = await handle.app.inject({ url: "/api/dictionaries?readiness=authentication-failed", headers: { host: HOST } });
  assert.equal(filtered.statusCode, 200);
  assert.deepEqual(filtered.json().items.map((item: { id: string }) => item.id), [created.dictionaryId]);
  const ready = await handle.app.inject({ url: "/api/dictionaries?readiness=ready", headers: { host: HOST } });
  assert.deepEqual(ready.json().items, []);
  writeFileSync(path, original);
  assert.equal((await get()).json().readiness, "ready");
  rmSync(path);
  const missing = await get();
  assert.equal(missing.json().readiness, "missing-key");
  assert.deepEqual(missing.json().missingKeyIds, [wrong.keys[0].keyId]);
});

test("字典 HTTP：损坏或权限异常的密钥环不阻断普通字典列表与编辑", async t => {
  const handle = harness(t);
  await handle.app.ready();
  const dictionaries = handle.dictionaries(), secrets = dictionaries.secrets;
  secrets.generate({ requestId: "generate", expectedGeneration: 0 });
  const plain = dictionaries.create({ requestId: "plain", name: "普通字典", description: "", kind: "plain", enabled: true, operations: [] });
  const encrypted = dictionaries.create({ requestId: "encrypted", name: "加密字典", description: "", kind: "encrypted", enabled: true,
    operations: [{ op: "set", key: "token", type: "string", value: "PRIVATE_VALUE" }] });
  const path = secrets.keyring.path, original = readFileSync(path, "utf8");
  for (const failure of ["invalid-json", "permissions"] as const) {
    writeFileSync(path, failure === "invalid-json" ? "{" : original);
    chmodSync(path, failure === "permissions" ? 0o644 : 0o600);
    const list = await handle.app.inject({ url: "/api/dictionaries", headers: { host: HOST } });
    assert.equal(list.statusCode, 200, list.body);
    const items = list.json().items;
    assert.equal(items.find((item: { id: string }) => item.id === plain.dictionaryId).readiness, "ready");
    assert.equal(items.find((item: { id: string }) => item.id === encrypted.dictionaryId).readiness, "keyring-unavailable");
    assert.equal(list.body.includes("PRIVATE_VALUE"), false);
    const detail = await handle.app.inject({ url: `/api/dictionaries/${encrypted.dictionaryId}`, headers: { host: HOST } });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().readiness, "keyring-unavailable");
    const filtered = await handle.app.inject({ url: "/api/dictionaries?readiness=keyring-unavailable", headers: { host: HOST } });
    assert.equal(filtered.statusCode, 200);
    assert.deepEqual(filtered.json().items.map((item: { id: string }) => item.id), [encrypted.dictionaryId]);
  }
  const updated = await handle.app.inject({ method: "PATCH", url: `/api/dictionaries/${plain.dictionaryId}`, headers: { host: HOST },
    payload: { requestId: "update", expectedRevision: 1, operations: [{ op: "set", key: "value", type: "string", value: "updated" }] } });
  assert.equal(updated.statusCode, 200, updated.body);
  const detail = await handle.app.inject({ url: `/api/dictionaries/${plain.dictionaryId}`, headers: { host: HOST } });
  assert.equal(detail.json().keys.value.value, "updated");
  chmodSync(path, 0o600);
  writeFileSync(path, original);
  assert.equal(dictionaries.get(encrypted.dictionaryId)!.readiness, "ready");
});

test("字典 HTTP：创建、列表、详情、更新、无变化保存与并发冲突", async (t: TestContext) => {
  const { app } = harnessCache(t);
  const create = await app.inject({ method: "POST", url: "/api/dictionaries", headers: { host: HOST }, payload: {
    requestId: randomUUID(), name: "订单服务", description: "共享配置", kind: "plain", enabled: true,
    operations: [{ op: "set", key: "baseUrl", type: "string", value: "https://api.example.com" }],
  } });
  assert.equal(create.statusCode, 201, create.body);
  const created = create.json() as { dictionaryId: string; versionId: string; revision: number };
  assert.equal(created.revision, 1);
  // 列表与筛选。
  const list = await app.inject({ url: "/api/dictionaries?kind=plain", headers: { host: HOST } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items.some((item: { id: string }) => item.id === created.dictionaryId), true);
  const encryptedList = await app.inject({ url: "/api/dictionaries?kind=encrypted", headers: { host: HOST } });
  assert.equal(encryptedList.json().items.length, 0);
  // 详情视图包含条目值。
  const view = await app.inject({ url: `/api/dictionaries/${created.dictionaryId}`, headers: { host: HOST } });
  assert.equal(view.json().keys.baseUrl.value, "https://api.example.com");
  assert.equal(view.json().revision, 1);
  // 更新：expectedRevision 冲突。
  const conflict = await app.inject({ method: "PATCH", url: `/api/dictionaries/${created.dictionaryId}`, headers: { host: HOST }, payload: {
    requestId: randomUUID(), expectedRevision: 5, operations: [{ op: "set", key: "baseUrl", type: "string", value: "https://new.example.com" }],
  } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "REVISION_CONFLICT");
  // 有效更新。
  const update = await app.inject({ method: "PATCH", url: `/api/dictionaries/${created.dictionaryId}`, headers: { host: HOST }, payload: {
    requestId: randomUUID(), expectedRevision: 1, operations: [{ op: "set", key: "baseUrl", type: "string", value: "https://new.example.com" }],
  } });
  assert.equal(update.statusCode, 200);
  assert.deepEqual(update.json(), { dictionaryId: created.dictionaryId, versionId: update.json().versionId, revision: 2, changed: true });
  // 完全相同保存返回无变化。
  const unchanged = await app.inject({ method: "PATCH", url: `/api/dictionaries/${created.dictionaryId}`, headers: { host: HOST }, payload: {
    requestId: randomUUID(), expectedRevision: 2, operations: [{ op: "set", key: "baseUrl", type: "string", value: "https://new.example.com" }],
  } });
  assert.equal(unchanged.json().changed, false);
  // 版本列表与详情。
  const versions = await app.inject({ url: `/api/dictionaries/${created.dictionaryId}/versions`, headers: { host: HOST } });
  assert.equal(versions.json().items.length, 2);
  const detail = await app.inject({ url: `/api/dictionaries/${created.dictionaryId}/versions/${update.json().versionId}`, headers: { host: HOST } });
  assert.equal(detail.json().versionNo, 2);
  const missing = await app.inject({ url: `/api/dictionaries/${created.dictionaryId}/versions/nope`, headers: { host: HOST } });
  assert.equal(missing.statusCode, 404);
  // 未知字段拒绝。
  const unknownField = await app.inject({ method: "POST", url: "/api/dictionaries", headers: { host: HOST }, payload: {
    requestId: randomUUID(), name: "x", description: "", kind: "plain", enabled: true, operations: [], extra: 1,
  } });
  assert.equal(unknownField.statusCode, 400);
  // 无引用且所有定义可读取时，引用扫描完整。
  const references = await app.inject({ url: `/api/dictionaries/${created.dictionaryId}/references`, headers: { host: HOST } });
  assert.equal(references.json().complete, true);
});

test("字典 HTTP：移除被引用键返回 CONFIRMATION_REQUIRED 与影响详情", async (t: TestContext) => {
  const handle = harnessCache(t);
  const create = await handle.app.inject({ method: "POST", url: "/api/dictionaries", headers: { host: HOST }, payload: {
    requestId: randomUUID(), name: "引用字典", description: "", kind: "plain", enabled: true,
    operations: [{ op: "set", key: "drop", type: "string", value: "1" }],
  } });
  const { dictionaryId } = create.json() as { dictionaryId: string };
  // 注入引用提供者模拟任务 5 的扫描结果（ready 后经 getter 取真实服务实例）。
  handle.dictionaries().references = { keyReferences: (id: string, keys: string[]) => keys.map(key => ({ key, workflows: 1, scripts: 0 })) };
  const first = await handle.app.inject({ method: "PATCH", url: `/api/dictionaries/${dictionaryId}`, headers: { host: HOST }, payload: {
    requestId: randomUUID(), expectedRevision: 1, operations: [{ op: "remove", key: "drop" }],
  } });
  assert.equal(first.statusCode, 409);
  assert.equal(first.json().code, "CONFIRMATION_REQUIRED");
  const { confirmationToken, impacts } = first.json().details as { confirmationToken: string; impacts: { key: string; workflows: number }[] };
  assert.deepEqual(impacts, [{ key: "drop", workflows: 1, scripts: 0 }]);
  // 携带令牌重放通过。
  const confirmed = await handle.app.inject({ method: "PATCH", url: `/api/dictionaries/${dictionaryId}`, headers: { host: HOST }, payload: {
    requestId: randomUUID(), expectedRevision: 1, operations: [{ op: "remove", key: "drop" }], confirmationToken,
  } });
  assert.equal(confirmed.json().changed, true);
  // 消费后的令牌无法授权另一个被引用键的移除。
  const again = await handle.app.inject({ method: "PATCH", url: `/api/dictionaries/${dictionaryId}`, headers: { host: HOST }, payload: {
    requestId: randomUUID(), expectedRevision: confirmed.json().revision, operations: [{ op: "remove", key: "drop" }],
  } });
  assert.equal(again.json().code, "DICTIONARY_KEY_MISSING");
});

test("敏感来源守卫：跨端口、扩展来源、伪造 Sec-Fetch-Site 与无 Origin 无令牌", async (t: TestContext) => {
  const { app, token: readToken } = harnessCache(t);
  const token = await readToken();
  const base = { requestId: randomUUID(), expectedGeneration: 0 };
  // 无 Origin 且无令牌：UNAUTHORIZED。
  const noToken = await app.inject({ method: "POST", url: "/api/secrets/keys", headers: { host: HOST }, payload: { ...base, requestId: randomUUID() } });
  assert.equal(noToken.statusCode, 401);
  assert.equal(noToken.json().code, "UNAUTHORIZED");
  // 无 Origin 但带有效令牌：允许。
  const withToken = await app.inject({ method: "POST", url: "/api/secrets/keys", headers: { host: HOST, "x-orchard-token": token }, payload: base });
  assert.equal(withToken.statusCode, 201, withToken.body);
  // 跨端口 Origin 拒绝。
  const crossPort = await app.inject({ method: "POST", url: "/api/secrets/keys", headers: { host: HOST, origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-origin" }, payload: base });
  assert.equal(crossPort.statusCode, 403);
  assert.equal(crossPort.json().code, "INVALID_ORIGIN");
  // 扩展来源拒绝。
  const extension = await app.inject({ method: "POST", url: "/api/secrets/keys", headers: { host: HOST, origin: "chrome-extension://abcdefghijklmnop" }, payload: base });
  assert.equal(extension.statusCode, 403);
  // Sec-Fetch-Site 不匹配拒绝。
  const crossSite = await app.inject({ method: "POST", url: "/api/secrets/keys", headers: { host: HOST, origin: `http://${HOST}`, "sec-fetch-site": "cross-site" }, payload: base });
  assert.equal(crossSite.statusCode, 403);
});

test("密钥与加密字典 HTTP：生成、加密写入、换钥、备份下载与验证", async (t: TestContext) => {
  const { app, store, token: readToken } = harnessCache(t);
  const token = await readToken();
  const headers = { host: HOST, ...sensitiveHeaders(), "x-orchard-token": token };
  // 生成活动密钥。
  const generate = await app.inject({ method: "POST", url: "/api/secrets/keys", headers, payload: { requestId: randomUUID(), expectedGeneration: 0 } });
  assert.equal(generate.statusCode, 201);
  const { keyId } = generate.json() as { keyId: string };
  const status = await app.inject({ url: "/api/secrets/status", headers: { host: HOST } });
  assert.equal(status.json().activeKeyId, keyId);
  assert.equal(status.json().generation, 1);
  // 加密字典创建需要敏感来源。
  const secret = "browser-secret-token";
  const createWithoutOrigin = await app.inject({ method: "POST", url: "/api/dictionaries", headers: { host: HOST }, payload: {
    requestId: randomUUID(), name: "凭据", description: "", kind: "encrypted", enabled: true, operations: [{ op: "set", key: "apiToken", type: "string", value: secret }],
  } });
  // 无 Origin 无令牌 → UNAUTHORIZED（须提供有效 x-orchard-token）。
  assert.equal(createWithoutOrigin.statusCode, 401);
  assert.equal(createWithoutOrigin.json().code, "UNAUTHORIZED");
  const create = await app.inject({ method: "POST", url: "/api/dictionaries", headers: { host: HOST, ...sensitiveHeaders() }, payload: {
    requestId: randomUUID(), name: "凭据", description: "", kind: "encrypted", enabled: true, operations: [{ op: "set", key: "apiToken", type: "string", value: secret }],
  } });
  assert.equal(create.statusCode, 201, create.body);
  const { dictionaryId } = create.json() as { dictionaryId: string };
  // 视图不出现明文。
  const view = await app.inject({ url: `/api/dictionaries/${dictionaryId}`, headers: { host: HOST } });
  assert.equal(view.body.includes(secret), false);
  assert.equal(view.json().keys.apiToken.keyId, keyId);
  // 加密更新也需要来源守卫：无 Origin 无令牌 → UNAUTHORIZED。
  const patchGuard = await app.inject({ method: "PATCH", url: `/api/dictionaries/${dictionaryId}`, headers: { host: HOST }, payload: {
    requestId: randomUUID(), expectedRevision: 1, operations: [{ op: "set", key: "apiToken", type: "string", value: "next" }],
  } });
  assert.equal(patchGuard.statusCode, 401);
  // 换钥：生成第二把并设为活动，预览 → 执行。
  const second = await app.inject({ method: "POST", url: "/api/secrets/keys", headers, payload: { requestId: randomUUID(), expectedGeneration: 1, makeActive: true } });
  assert.equal(second.statusCode, 201);
  const preview = await app.inject({ method: "POST", url: `/api/dictionaries/${dictionaryId}/re-encryption-preview`, headers: { host: HOST, ...sensitiveHeaders() }, payload: { expectedRevision: 1 } });
  assert.equal(preview.statusCode, 200, preview.body);
  const { token: previewToken, willReEncrypt } = preview.json() as { token: string; willReEncrypt: number };
  assert.equal(willReEncrypt, 1);
  const reEncrypt = await app.inject({ method: "POST", url: `/api/dictionaries/${dictionaryId}/re-encrypt`, headers: { host: HOST, ...sensitiveHeaders() }, payload: { requestId: randomUUID(), token: previewToken, expectedRevision: 1 } });
  assert.equal(reEncrypt.json().changed, true);
  // 备份下载：attachment + no-store，正文含材料但不入库不入日志。
  const backup = await app.inject({ method: "POST", url: "/api/secrets/export", headers, payload: { expectedGeneration: 2 } });
  assert.equal(backup.statusCode, 200);
  assert.equal(backup.headers["cache-control"], "no-store");
  assert.match(String(backup.headers["content-disposition"]), /attachment/);
  const backupBody = JSON.parse(backup.body) as { keys: { keyId: string }[] };
  assert.equal(backupBody.keys.length, 2);
  assert.equal(store.all("SELECT * FROM command_receipts WHERE result_json LIKE '%material%'").length, 0);
  // 验证：全部可解密。
  const verify = await app.inject({ method: "POST", url: "/api/secrets/verify", headers, payload: { expectedGeneration: 2 } });
  assert.equal(verify.json().verified, true);
  assert.equal(JSON.stringify(verify.json()).includes(secret), false);
  // 切换回第一把。
  const activate = await app.inject({ method: "PUT", url: "/api/secrets/active-key", headers, payload: { requestId: randomUUID(), expectedGeneration: 2, keyId } });
  assert.equal(activate.json().activeKeyId, keyId);
});
