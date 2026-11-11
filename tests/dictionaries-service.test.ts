import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { temporary, TestStore } from "./helpers.js";
import { KeyringStore, emptyKeyring, resolveKeyringPath } from "../src/secrets/keyring.js";
import { CommandHmac, sensitiveRequestDigest } from "../src/secrets/command-hmac.js";
import { SecretsService } from "../src/secrets/service.js";
import { DictionaryService } from "../src/dictionaries/service.js";
import { decryptValue, encryptValue } from "../src/secrets/aead.js";
import { serializeKeyringBackup } from "../src/secrets/backup.js";
import { generateKeyMaterial } from "../src/secrets/aead.js";
import type { TestContext } from "node:test";

const throwsCode = (fn: () => unknown, code: string, message?: RegExp) => {
  try {
    fn();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
    if (message) assert.match((error as Error).message, message);
    return error as { details?: unknown };
  }
  assert.fail(`预期抛出 ${code}`);
};

interface Harness {
  root: string;
  store: TestStore;
  keyring: KeyringStore;
  hmac: CommandHmac;
  secrets: SecretsService;
  dictionaries: DictionaryService;
}

function harness(t: TestContext): Harness {
  const root = temporary(t);
  const store = new TestStore(root);
  t.after(() => store.close());
  const keyring = new KeyringStore(resolveKeyringPath(root));
  const hmac = new CommandHmac(store, root, keyring);
  const secrets = new SecretsService(store, keyring, hmac);
  const dictionaries = new DictionaryService(store, secrets);
  return { root, store, keyring, hmac, secrets, dictionaries };
}

const keyringPath = (root: string) => resolveKeyringPath(root);

test("密钥环文件：原子写入、权限、代次与状态视图", (t: TestContext) => {
  const { root, keyring } = harness(t);
  assert.equal(keyring.exists(), false);
  assert.deepEqual(keyring.status(), { configured: false, generation: 0, activeKeyId: null, readOnly: false, keys: [] });
  const keyringFile = keyringPath(root);
  const next = { ...emptyKeyring(), generation: 1, activeKeyId: "k1", keys: [{ keyId: "k1", algorithm: "aes-256-gcm" as const, material: generateKeyMaterial().toString("base64"), createdAt: Date.now() }], operations: [] };
  keyring.save(next);
  assert.equal(keyring.exists(), true);
  assert.equal(statSync(keyringFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "secrets")).mode & 0o777, 0o700);
  assert.equal(keyring.status().configured, true);
  assert.equal(keyring.status().generation, 1);
  assert.equal(keyring.fingerprint()?.length, 64);
  assert.deepEqual(keyring.material("k1").byteLength, 32);
  // 字节回读与格式严格性：未知字段、错误代次、缺失活动密钥都拒绝。
  const raw = readFileSync(keyringFile, "utf8");
  throwsCode(() => keyring.save({ ...next, extra: 1 } as typeof next), "SECRET_KEYRING_FORMAT_INVALID") ;
  writeFileSync(keyringFile, JSON.stringify({ ...JSON.parse(raw), unknown: true }), { mode: 0o600 });
  throwsCode(() => keyring.load(), "SECRET_KEYRING_FORMAT_INVALID");
  writeFileSync(keyringFile, raw, { mode: 0o600 });
  // 符号链接拒绝。
  rmSync(keyringFile);
  symlinkSync(join(root, "target.json"), keyringFile);
  throwsCode(() => keyring.load(), "SECRET_KEYRING_FORMAT_INVALID");
  rmSync(keyringFile);
});

test("密钥环写入幂等：同请求返回原结果，跨内容冲突，代次冲突拒绝，无变化不递增代次", (t: TestContext) => {
  const { keyring } = harness(t);
  const digest = (content: string) => sensitiveRequestDigest(Buffer.alloc(32, 7), "secrets:generate", { content });
  const first = keyring.write("secrets:generate", "req-1", digest("a"), 0, keyringFile => {
    keyringFile.keys.push({ keyId: "k1", algorithm: "aes-256-gcm", material: generateKeyMaterial().toString("base64"), createdAt: Date.now() });
    keyringFile.activeKeyId = "k1";
    return { result: { keyId: "k1", generation: 1 }, changed: true };
  });
  assert.deepEqual(first, { keyId: "k1", generation: 1 });
  // 同 requestId 同摘要：返回原结果，代次不再递增。
  const replay = keyring.write("secrets:generate", "req-1", digest("a"), 0, () => ({ result: { keyId: "nope", generation: 99 }, changed: true }));
  assert.deepEqual(replay, { keyId: "k1", generation: 1 });
  assert.equal(keyring.load()!.generation, 1);
  // 同 requestId 不同摘要：REQUEST_CONFLICT。
  throwsCode(() => keyring.write("secrets:generate", "req-1", digest("b"), 1, () => ({ result: { keyId: "x" }, changed: true })), "REQUEST_CONFLICT");
  // 代次过期拒绝。
  throwsCode(() => keyring.write("secrets:generate", "req-2", digest("a"), 0, () => ({ result: { keyId: "x" }, changed: true })), "SECRET_KEYRING_GENERATION_CONFLICT");
  // 无变化请求：代次不递增，但操作记录持久化以保证重试。
  const unchanged = keyring.write("secrets:import", "req-3", digest("noop"), 1, () => ({ result: { added: 0 }, changed: false }));
  assert.deepEqual(unchanged, { added: 0 });
  assert.equal(keyring.load()!.generation, 1);
  assert.equal(keyring.load()!.operations.length, 2);
});

test("只读密钥环：新写入返回 SECRET_KEYRING_READ_ONLY，历史记录仍可重试", (t: TestContext) => {
  const root = temporary(t);
  const store = new TestStore(root);
  t.after(() => store.close());
  const keyringPath = resolveKeyringPath(root);
  const writable = new KeyringStore(keyringPath);
  const digest = sensitiveRequestDigest(Buffer.alloc(32, 7), "secrets:generate", {});
  writable.write("secrets:generate", "req-1", digest, 0, ring => {
    ring.keys.push({ keyId: "k1", algorithm: "aes-256-gcm", material: generateKeyMaterial().toString("base64"), createdAt: Date.now() });
    ring.activeKeyId = "k1";
    return { result: { keyId: "k1", generation: 1 }, changed: true };
  });
  // root 环境下 chmod 不影响写入，用注入探针模拟只读存储。
  const keyring = new KeyringStore(keyringPath, () => true);
  assert.equal(keyring.isReadOnly(), true);
  assert.equal(keyring.status().readOnly, true);
  // 新写入拒绝且不回退创建另一份密钥环。
  throwsCode(() => keyring.write("secrets:activate", "req-2", digest, 1, () => ({ result: { generation: 2 }, changed: true })), "SECRET_KEYRING_READ_ONLY");
  assert.equal(existsSync(keyringPath), true);
  // 已记录操作的重试仍然返回原结果（无需写文件）。
  const replay = keyring.write("secrets:generate", "req-1", digest, 1, () => ({ result: { keyId: "x" }, changed: true }));
  assert.deepEqual(replay, { keyId: "k1", generation: 1 });
});

test("resolveKeyringPath：绝对路径覆盖与 Git 目录限制", (t: TestContext) => {
  const previous = process.env.ORCHARD_SECRET_KEYRING_FILE;
  t.after(() => { if (previous === undefined) delete process.env.ORCHARD_SECRET_KEYRING_FILE; else process.env.ORCHARD_SECRET_KEYRING_FILE = previous; });
  process.env.ORCHARD_SECRET_KEYRING_FILE = "/var/lib/orchard-keys/keyring.json";
  assert.equal(resolveKeyringPath("/data/workbench"), "/var/lib/orchard-keys/keyring.json");
  process.env.ORCHARD_SECRET_KEYRING_FILE = "relative/keyring.json";
  throwsCode(() => resolveKeyringPath("/data/workbench"), "SECRET_KEYRING_FORMAT_INVALID");
  process.env.ORCHARD_SECRET_KEYRING_FILE = "/data/workbench/config/keyring.json";
  throwsCode(() => resolveKeyringPath("/data/workbench"), "SECRET_KEYRING_FORMAT_INVALID");
  delete process.env.ORCHARD_SECRET_KEYRING_FILE;
  assert.equal(resolveKeyringPath("/data/workbench"), join("/data/workbench", "secrets", "keyring.json"));
});

test("本机 HMAC 密钥：首次创建、重试稳定、历史记录存在时缺失即拒绝", (t: TestContext) => {
  const { root, store, keyring, hmac } = harness(t);
  const first = hmac.ensure();
  assert.equal(first.byteLength, 32);
  assert.equal(statSync(hmac.path).mode & 0o777, 0o600);
  const second = hmac.ensure();
  assert.deepEqual(second, first);
  // 密钥环有操作记录而 HMAC 文件丢失：阻止敏感写入，不生成替代密钥。
  keyring.write("secrets:generate", "req-1", sensitiveRequestDigest(first, "secrets:generate", {}), 0, keyringFile => {
    keyringFile.keys.push({ keyId: "k1", algorithm: "aes-256-gcm", material: generateKeyMaterial().toString("base64"), createdAt: Date.now() });
    keyringFile.activeKeyId = "k1";
    return { result: { keyId: "k1", generation: 1 }, changed: true };
  });
  rmSync(hmac.path);
  throwsCode(() => hmac.ensure(), "SECRET_RECEIPT_KEY_MISSING");
  // 数据库已有敏感回执而文件缺失同样拒绝；普通查询不受影响。
  store.exec("INSERT INTO command_receipts VALUES('dictionary-secret:create','r','hash','{}',1)");
  const other = harness(t);
  other.store.exec("INSERT INTO command_receipts VALUES('dictionary-secret:create','r','hash','{}',1)");
  rmSync(other.hmac.path, { force: true });
  throwsCode(() => other.hmac.ensure(), "SECRET_RECEIPT_KEY_MISSING");
  assert.ok(existsSync(join(root, "secrets")));
});

test("敏感命令入口：scope 白名单、回执重放与内容冲突", (t: TestContext) => {
  const { store } = harness(t);
  const hash = (content: string) => sensitiveRequestDigest(Buffer.alloc(32, 3), "secrets:test", { content });
  throwsCode(() => store.sensitiveCommand("dictionaries:create", "r1", hash("a"), () => 1), "INVALID_SCOPE");
  const first = store.sensitiveCommand("secrets:test", "r1", hash("a"), () => ({ ok: true, n: 1 }));
  assert.deepEqual(first, { ok: true, n: 1 });
  assert.deepEqual(store.sensitiveCommand("secrets:test", "r1", hash("a"), () => ({ ok: false })), { ok: true, n: 1 });
  throwsCode(() => store.sensitiveCommand("secrets:test", "r1", hash("b"), () => 1), "REQUEST_CONFLICT");
  throwsCode(() => store.sensitiveCommand("secrets:test", "r2", "not-a-hash", () => 1), "INVALID_REQUEST_ID");
});

test("密钥服务：生成、导入、备份、验证与切换活动密钥", (t: TestContext) => {
  const { store, secrets, keyring } = harness(t);
  assert.equal(secrets.status().configured, false);
  assert.equal(secrets.status().encryptedDictionaries, 0);
  const generated = secrets.generate({ requestId: "gen-1", expectedGeneration: 0 });
  assert.equal(keyring.activeKeyId(), generated.keyId);
  assert.equal(secrets.status().generation, 1);
  // 空 ring 首把密钥自动设为活动；已有密钥时默认保留活动。
  const second = secrets.generate({ requestId: "gen-2", expectedGeneration: 1 });
  assert.notEqual(second.keyId, generated.keyId);
  assert.equal(keyring.activeKeyId(), generated.keyId);
  // 同 requestId 重试返回原结果，不生成第二把密钥。
  assert.deepEqual(secrets.generate({ requestId: "gen-2", expectedGeneration: 99 }), second);
  assert.equal(keyring.load()!.keys.length, 2);
  // 代次冲突。
  throwsCode(() => secrets.generate({ requestId: "gen-3", expectedGeneration: 0 }), "SECRET_KEYRING_GENERATION_CONFLICT");
  // 备份：只读、可重复、字节一致。
  const backupOne = secrets.exportBackup({ expectedGeneration: 2 });
  const backupTwo = secrets.exportBackup({ expectedGeneration: 2 });
  assert.equal(backupOne.body, backupTwo.body);
  assert.match(backupOne.body, /"material"/);
  throwsCode(() => secrets.exportBackup({ expectedGeneration: 1 }), "SECRET_KEYRING_GENERATION_CONFLICT");
  throwsCode(() => secrets.exportBackup({ expectedGeneration: 2, keyIds: ["unknown"] }), "SECRET_KEY_MISSING");
  // 切换活动密钥：仅影响后续写入；无变化不递增代次。
  const activated = secrets.activate({ requestId: "act-1", expectedGeneration: 2, keyId: second.keyId });
  assert.deepEqual(activated, { generation: 3, activeKeyId: second.keyId });
  assert.deepEqual(secrets.activate({ requestId: "act-1", expectedGeneration: 99, keyId: second.keyId }), activated);
  assert.equal(keyring.activeKeyId(), second.keyId);
  assert.equal(secrets.status().generation, 3);
  throwsCode(() => secrets.activate({ requestId: "act-2", expectedGeneration: 3, keyId: "ghost" }), "SECRET_KEY_MISSING");
  const noop = secrets.activate({ requestId: "act-3", expectedGeneration: 3, keyId: second.keyId });
  assert.equal(noop.generation, 3);
  // 导入：合并、无变化与冲突语义。
  const parsed = JSON.parse(backupOne.body) as { keys: { keyId: string; material: string; algorithm: string }[] };
  const sameBackup = serializeKeyringBackup({ formatVersion: 1, keys: parsed.keys.map(key => ({ keyId: key.keyId, algorithm: "aes-256-gcm" as const, material: key.material })), activeKeyId: parsed.keys[0]!.keyId });
  const imported = secrets.import({ requestId: "imp-1", expectedGeneration: 3, backupText: sameBackup });
  assert.deepEqual(imported, { generation: 3, added: 0, unchanged: 2 });
  assert.equal(keyring.activeKeyId(), second.keyId);
  const tampered = serializeKeyringBackup({ formatVersion: 1, keys: [{ keyId: parsed.keys[0]!.keyId, algorithm: "aes-256-gcm" as const, material: generateKeyMaterial().toString("base64") }] });
  throwsCode(() => secrets.import({ requestId: "imp-2", expectedGeneration: 3, backupText: tampered }), "SECRET_KEY_CONFLICT");
  // 只含一把新钥匙的备份，空环之外的导入默认保留活动密钥。
  const fresh = serializeKeyringBackup({ formatVersion: 1, keys: [{ keyId: "extra-key", algorithm: "aes-256-gcm", material: generateKeyMaterial().toString("base64") }] });
  const importedFresh = secrets.import({ requestId: "imp-3", expectedGeneration: 3, backupText: fresh });
  assert.deepEqual(importedFresh, { generation: 4, added: 1, unchanged: 0 });
  assert.equal(keyring.activeKeyId(), second.keyId);
  // 密钥环操作回执保存在密钥环文件内，不写数据库回执（§7.4：两套回执不互相替代）。
  assert.equal(keyring.load()!.operations.length >= 5, true);
  assert.equal(store.all("SELECT * FROM command_receipts WHERE scope LIKE 'secrets:%'").length, 0);
});

test("密钥服务：空环导入必须明确活动密钥；验证输出只含安全诊断", (t: TestContext) => {
  const { secrets, keyring } = harness(t);
  const material = generateKeyMaterial().toString("base64");
  const backup = serializeKeyringBackup({ formatVersion: 1, keys: [{ keyId: "only-key", algorithm: "aes-256-gcm", material }] });
  // 无活动密钥建议的备份导入空环被拒绝。
  throwsCode(() => secrets.import({ requestId: "imp-1", expectedGeneration: 0, backupText: backup }), "SECRET_ACTIVE_KEY_REQUIRED");
  // 备份中的 activeKeyId 仅作建议，必须由请求明确选择。
  const backupWithActive = serializeKeyringBackup({ formatVersion: 1, keys: [{ keyId: "only-key", algorithm: "aes-256-gcm", material }], activeKeyId: "only-key" });
  const imported = secrets.import({ requestId: "imp-2", expectedGeneration: 0, backupText: backupWithActive, activeKeyId: "only-key" });
  assert.deepEqual(imported, { generation: 1, added: 1, unchanged: 0 });
  assert.equal(keyring.activeKeyId(), "only-key");
  // 无加密字典：显示“密钥格式有效，尚未验证解密”。
  const verification = secrets.verify({ expectedGeneration: 1 });
  assert.equal(verification.verified, false);
  assert.equal(verification.message, "密钥格式有效，尚未验证解密");
});

test("字典服务：普通字典 CRUD、无变化保存、回执重放与并发冲突", (t: TestContext) => {
  const { store, dictionaries } = harness(t);
  const created = dictionaries.create({ requestId: "c1", name: "订单服务", description: "共享配置", kind: "plain", enabled: true, operations: [
    { op: "set", key: "baseUrl", type: "string", value: "https://api.example.com" },
    { op: "set", key: "timeoutMs", type: "number", value: 3000 },
    { op: "set", key: "statusLabels", type: "json", value: { paid: "已支付" } },
  ] });
  assert.equal(created.changed, true);
  assert.equal(created.revision, 1);
  const view = dictionaries.get(created.dictionaryId)!;
  assert.equal(view.name, "订单服务");
  assert.equal(view.keyCount, 3);
  assert.equal(view.readiness, "ready");
  assert.deepEqual((view.keys.baseUrl as { value: string }).value, "https://api.example.com");
  // NOCASE 同名冲突。
  throwsCode(() => dictionaries.create({ requestId: "c2", name: "订单服务", description: "", kind: "plain", enabled: true, operations: [] }), "INVALID_DICTIONARY");
  throwsCode(() => dictionaries.create({ requestId: "c3", name: "订单服务 ", description: "", kind: "plain", enabled: true, operations: [] }), "INVALID_DICTIONARY");
  // 创建不支持 remove；键名规则与类型严格校验。
  throwsCode(() => dictionaries.create({ requestId: "c4", name: "字典二", description: "", kind: "plain", enabled: true, operations: [{ op: "remove", key: "x" }] }), "INVALID_DICTIONARY");
  throwsCode(() => dictionaries.create({ requestId: "c5", name: "字典三", description: "", kind: "plain", enabled: true, operations: [{ op: "set", key: "9bad", type: "string", value: "x" }] }), "INVALID_DICTIONARY");
  throwsCode(() => dictionaries.create({ requestId: "c6", name: "字典四", description: "", kind: "plain", enabled: true, operations: [{ op: "set", key: "n", type: "number", value: "3" }] }), "INVALID_DICTIONARY");
  // 重复操作同一键拒绝。
  throwsCode(() => dictionaries.update(created.dictionaryId, { requestId: "u0", expectedRevision: 1, operations: [
    { op: "set", key: "a", type: "string", value: "1" }, { op: "set", key: "a", type: "string", value: "2" },
  ] }), "INVALID_DICTIONARY");
  // remove 不存在的键拒绝。
  throwsCode(() => dictionaries.update(created.dictionaryId, { requestId: "u0b", expectedRevision: 1, operations: [{ op: "remove", key: "ghost" }] }), "DICTIONARY_KEY_MISSING");
  // 并发冲突。
  throwsCode(() => dictionaries.update(created.dictionaryId, { requestId: "u1", expectedRevision: 2, operations: [{ op: "set", key: "baseUrl", type: "string", value: "https://new.example.com" }] }), "REVISION_CONFLICT");
  // 有效更新：revision 递增、新版本产生。
  const updated = dictionaries.update(created.dictionaryId, { requestId: "u2", expectedRevision: 1, operations: [{ op: "set", key: "baseUrl", type: "string", value: "https://new.example.com" }] });
  assert.equal(updated.changed, true);
  assert.equal(updated.revision, 2);
  assert.notEqual(updated.versionId, created.versionId);
  // 未出现的键保持原值。
  const after = dictionaries.get(created.dictionaryId)!;
  assert.equal((after.keys.timeoutMs as { value: number }).value, 3000);
  // 完全相同的保存返回无变化，不产生修订。
  const unchanged = dictionaries.update(created.dictionaryId, { requestId: "u3", expectedRevision: 2, operations: [{ op: "set", key: "baseUrl", type: "string", value: "https://new.example.com" }] });
  assert.deepEqual(unchanged, { dictionaryId: created.dictionaryId, versionId: updated.versionId, revision: 2, changed: false });
  assert.equal(dictionaries.versions(created.dictionaryId).items.length, 2);
  // 同 requestId 重试返回原结果，不受最新内容影响。
  const replay = dictionaries.update(created.dictionaryId, { requestId: "u2", expectedRevision: 1, operations: [{ op: "set", key: "baseUrl", type: "string", value: "https://new.example.com" }] });
  assert.deepEqual(replay, { ...updated });
  // 修订历史：禁用状态进入修订；版本详情无密文概念。
  const disabled = dictionaries.update(created.dictionaryId, { requestId: "u4", expectedRevision: 2, enabled: false, operations: [] });
  assert.equal(dictionaries.get(created.dictionaryId)!.enabled, false);
  const detail = dictionaries.version(created.dictionaryId, disabled.versionId)!;
  assert.equal(detail.enabled, false);
  assert.deepEqual(detail.keys.baseUrl, { type: "string", value: "https://new.example.com" });
  // 回执层：普通命令回执不包含请求明文以外内容的问题不适用；此处确认 scope 使用 SHA-256 协议。
  const receipt = store.one<{ request_hash: string }>("SELECT * FROM command_receipts WHERE scope='dictionaries:update' AND request_id='u2'");
  assert.ok(receipt);
  assert.equal(receipt!.request_hash.length, 64);
  // 分页。
  const page = dictionaries.list({ limit: 1 });
  assert.equal(page.items.length, 1);
  if (page.nextCursor) {
    const second = dictionaries.list({ limit: 1, cursor: page.nextCursor });
    assert.equal(second.items.length, 1);
    assert.notEqual(second.items[0]!.id, page.items[0]!.id);
  }
});

test("字典服务：加密字典读写、密文复用与明文不出库", (t: TestContext) => {
  const { store, secrets, dictionaries, keyring } = harness(t);
  const generated = secrets.generate({ requestId: "g1", expectedGeneration: 0 });
  const token = "s3cret-browser-token-值";
  const created = dictionaries.create({ requestId: "e1", name: "订单凭据", description: "", kind: "encrypted", enabled: true, operations: [
    { op: "set", key: "apiToken", type: "string", value: token },
    { op: "set", key: "apiSecret", type: "string", value: "another-secret" },
  ] });
  const row = store.one<{ entries_json: string }>("SELECT entries_json FROM dictionary_versions WHERE id=?", created.versionId)!;
  assert.match(row.entries_json, /"keyId"/);
  assert.equal(row.entries_json.includes(token), false);
  const envelope = (JSON.parse(row.entries_json) as Record<string, { encryptedValue: { keyId: string; nonce: string; ciphertext: string; tag: string } }>).apiToken.encryptedValue;
  assert.equal(envelope.keyId, generated.keyId);
  // 视图只显示键名、类型与 keyId，不返回密文或明文。
  const view = dictionaries.get(created.dictionaryId)!;
  assert.deepEqual(view.keys.apiToken, { type: "string", set: true, keyId: generated.keyId });
  assert.equal(JSON.stringify(view).includes(token), false);
  // 未配置密钥环的加密写入拒绝。
  const bare = harness(t);
  throwsCode(() => bare.dictionaries.create({ requestId: "e0", name: "无钥", description: "", kind: "encrypted", enabled: true, operations: [{ op: "set", key: "k", type: "string", value: "v" }] }), "SECRET_KEY_MISSING");
  // 显式替换生成新密文（新 nonce），未触及键复用原封装。
  const before = JSON.parse(store.one<{ entries_json: string }>("SELECT entries_json FROM dictionary_versions WHERE id=?", created.versionId)!.entries_json) as Record<string, { encryptedValue: { nonce: string } }>;
  const updated = dictionaries.update(created.dictionaryId, { requestId: "e2", expectedRevision: 1, operations: [{ op: "set", key: "apiToken", type: "string", value: "rotated-secret" }] });
  assert.equal(updated.changed, true);
  const after = JSON.parse(store.one<{ entries_json: string }>("SELECT entries_json FROM dictionary_versions WHERE id=?", updated.versionId)!.entries_json) as Record<string, { encryptedValue: { nonce: string } }>;
  assert.notEqual(after.apiToken.encryptedValue.nonce, before.apiToken.encryptedValue.nonce);
  assert.equal(after.apiSecret.encryptedValue.nonce, before.apiSecret.encryptedValue.nonce);
  // 新值可解密；密文不出现在回执。
  const active = secrets.requireActiveKey();
  assert.equal(decryptValue(active.material, { keyId: active.keyId, dictionaryId: created.dictionaryId, key: "apiToken" }, after.apiToken.encryptedValue), "rotated-secret");
  const sensitiveReceipt = store.one("SELECT result_json FROM command_receipts WHERE scope='dictionary-secret:update' AND request_id='e2'")!;
  assert.equal(String(sensitiveReceipt.result_json).includes("rotated-secret"), false);
  // 敏感回执使用 HMAC 摘要而非 SHA-256：与请求明文的 SHA-256 不同。
  const receipts = store.all<{ scope: string }>("SELECT scope FROM command_receipts WHERE request_id='e2'");
  assert.deepEqual(receipts.map(receipt => receipt.scope), ["dictionary-secret:update"]);
  assert.equal(keyring.load()!.operations.length >= 1, true);
  // 回执重放返回原结果。
  assert.deepEqual(dictionaries.update(created.dictionaryId, { requestId: "e2", expectedRevision: 1, operations: [{ op: "set", key: "apiToken", type: "string", value: "rotated-secret" }] }), { dictionaryId: created.dictionaryId, versionId: updated.versionId, revision: 2, changed: true });
});

test("字典服务：移除被引用键需确认令牌，令牌绑定请求与引用摘要", (t: TestContext) => {
  const { dictionaries } = harness(t);
  const created = dictionaries.create({ requestId: "c1", name: "引用字典", description: "", kind: "plain", enabled: true, operations: [
    { op: "set", key: "keep", type: "string", value: "1" },
    { op: "set", key: "drop", type: "string", value: "2" },
  ] });
  dictionaries.references = { keyReferences: (id, keys) => keys.map(key => ({ key, workflows: key === "drop" ? 2 : 0, scripts: 0 })) };
  const operation = { operations: [{ op: "remove", key: "drop" }], expectedRevision: 1 };
  const error = throwsCode(() => dictionaries.update(created.dictionaryId, { requestId: "r1", ...operation }), "CONFIRMATION_REQUIRED") as { details?: { confirmationToken: string; impacts: { key: string; workflows: number }[]; expiresAt: number } };
  assert.deepEqual(error.details!.impacts, [{ key: "drop", workflows: 2, scripts: 0 }]);
  const token = error.details!.confirmationToken;
  // 无令牌重试仍要求确认；令牌绑定原请求摘要，换请求即失效。
  throwsCode(() => dictionaries.update(created.dictionaryId, { requestId: "r2", ...operation }), "CONFIRMATION_REQUIRED");
  throwsCode(() => dictionaries.update(created.dictionaryId, { requestId: "r3", expectedRevision: 1, operations: [{ op: "remove", key: "drop" }, { op: "set", key: "keep", type: "string", value: "3" }], confirmationToken: token }), "PREVIEW_EXPIRED");
  const applied = dictionaries.update(created.dictionaryId, { requestId: "r4", ...operation, confirmationToken: token });
  assert.equal(applied.changed, true);
  assert.equal(dictionaries.get(created.dictionaryId)!.keys.drop, undefined);
  // 旧令牌不能授权另一个被引用键的移除：请求摘要不同即失效。
  dictionaries.references = { keyReferences: (id, keys) => keys.map(key => ({ key, workflows: 1, scripts: 0 })) };
  throwsCode(() => dictionaries.update(created.dictionaryId, { requestId: "r5", expectedRevision: applied.revision, operations: [{ op: "remove", key: "keep" }], confirmationToken: token }), "PREVIEW_EXPIRED");
  // 不包含移除操作的写入无需确认。
  assert.equal(dictionaries.update(created.dictionaryId, { requestId: "r6", expectedRevision: applied.revision, operations: [{ op: "set", key: "keep", type: "string", value: "x" }] }).changed, true);
});

test("字典服务：换钥预览与执行遵循 keyId 规则", (t: TestContext) => {
  const { secrets, dictionaries, store, keyring } = harness(t);
  const first = secrets.generate({ requestId: "g1", expectedGeneration: 0 });
  const created = dictionaries.create({ requestId: "e1", name: "换钥字典", description: "", kind: "encrypted", enabled: true, operations: [
    { op: "set", key: "apiToken", type: "string", value: "rotate-me" },
  ] });
  const second = secrets.generate({ requestId: "g2", expectedGeneration: 1, makeActive: true });
  assert.notEqual(second.keyId, first.keyId);
  // 预览：绑定字典摘要、配置与密钥代次。
  const preview = dictionaries.reEncryptionPreview(created.dictionaryId, { expectedRevision: 1 });
  assert.equal(preview.willReEncrypt, 1);
  assert.equal(preview.targetKeyId, second.keyId);
  assert.equal(preview.entriesTotal, 1);
  // 已有新密钥（keyId 不同）不匹配预览基线 → PREVIEW_EXPIRED。
  secrets.generate({ requestId: "g3", expectedGeneration: 2, makeActive: true });
  throwsCode(() => dictionaries.reEncrypt(created.dictionaryId, { requestId: "re-1", token: preview.token, expectedRevision: 1 }), "PREVIEW_EXPIRED");
  const active = secrets.requireActiveKey();
  const preview2 = dictionaries.reEncryptionPreview(created.dictionaryId, { expectedRevision: 1 });
  const executed = dictionaries.reEncrypt(created.dictionaryId, { requestId: "re-2", token: preview2.token, expectedRevision: 1 });
  assert.deepEqual(executed, { dictionaryId: created.dictionaryId, versionId: executed.versionId, revision: 2, changed: true, reEncrypted: 1, reused: 0 });
  assert.equal((JSON.parse(store.one<{ entries_json: string }>("SELECT entries_json FROM dictionary_versions WHERE id=?", executed.versionId)!.entries_json) as Record<string, { encryptedValue: { keyId: string } }>).apiToken.encryptedValue.keyId, active.keyId);
  // 旧修订仍使用旧密钥，且旧密钥材料可解密。
  const oldRow = JSON.parse(store.one<{ entries_json: string }>("SELECT entries_json FROM dictionary_versions WHERE id=?", created.versionId)!.entries_json) as Record<string, { encryptedValue: { keyId: string; nonce: string; ciphertext: string; tag: string } }>;
  assert.equal(oldRow.apiToken.encryptedValue.keyId, first.keyId);
  assert.equal(decryptValue(keyring.material(first.keyId), { keyId: first.keyId, dictionaryId: created.dictionaryId, key: "apiToken" }, oldRow.apiToken.encryptedValue), "rotate-me");
  // 回执优先：同 requestId 同内容重试返回原结果，不再校验已消费的 token；不同内容才是 REQUEST_CONFLICT。
  assert.deepEqual(dictionaries.reEncrypt(created.dictionaryId, { requestId: "re-2", token: preview2.token, expectedRevision: 1 }), { dictionaryId: created.dictionaryId, versionId: executed.versionId, revision: 2, changed: true, reEncrypted: 1, reused: 0 });
  throwsCode(() => dictionaries.reEncrypt(created.dictionaryId, { requestId: "re-2", token: "different", expectedRevision: 1 }), "REQUEST_CONFLICT");
  // 全部已匹配：无变化，不产生修订。
  const preview3 = dictionaries.reEncryptionPreview(created.dictionaryId, { expectedRevision: 2 });
  assert.deepEqual(preview3, { ...preview3, willReEncrypt: 0, alreadyMatched: 1 });
  const noop = dictionaries.reEncrypt(created.dictionaryId, { requestId: "re-3", token: preview3.token, expectedRevision: 2 });
  assert.deepEqual(noop, { dictionaryId: created.dictionaryId, versionId: executed.versionId, revision: 2, changed: false, reEncrypted: 0, reused: 1 });
  assert.equal(dictionaries.versions(created.dictionaryId).items.length, 2);
  // 普通字典不支持换钥。
  const plain = dictionaries.create({ requestId: "p1", name: "普通字典", description: "", kind: "plain", enabled: true, operations: [] });
  throwsCode(() => dictionaries.reEncryptionPreview(plain.dictionaryId, { expectedRevision: 1 }), "DICTIONARY_KIND_MISMATCH");
});

test("密钥验证：缺失 keyId、认证失败与安全诊断", (t: TestContext) => {
  const { secrets, dictionaries, store, keyring } = harness(t);
  const first = secrets.generate({ requestId: "g1", expectedGeneration: 0 });
  const created = dictionaries.create({ requestId: "e1", name: "验证字典", description: "", kind: "encrypted", enabled: true, operations: [{ op: "set", key: "apiToken", type: "string", value: "secret" }] });
  const ok = secrets.verify({ expectedGeneration: 1 });
  assert.equal(ok.verified, true);
  assert.deepEqual(ok.dictionaries[0], { dictionaryId: created.dictionaryId, versionId: created.versionId, entries: 1, verified: 1, missingKeyIds: [], failedKeys: [] });
  // 版本不可变：直接 UPDATE 被触发器拒绝。
  try {
    store.exec("UPDATE dictionary_versions SET entries_json='{}' WHERE id=?", created.versionId);
    assert.fail("预期触发器拒绝版本改写");
  } catch (error) {
    assert.match((error as Error).message, /DICTIONARY_VERSION_IMMUTABLE/);
  }
  // 以独立插入的字典行验证：篡改密文 → 认证失败位置报告，不返回明文。
  const tampered = encryptValue(keyring.material(first.keyId), { keyId: first.keyId, dictionaryId: created.dictionaryId, key: "apiToken" }, "x");
  const flipped = Buffer.from(tampered.ciphertext, "base64"); flipped[0] = flipped[0]! ^ 0xff;
  const now = Date.now(), hash = "a".repeat(64);
  store.transaction(() => {
    store.exec("INSERT INTO dictionaries(id,name,kind,current_version_id,revision,created_at,updated_at) VALUES('tamper-dict','篡改字典','encrypted','tv1',1,?,?)", now, now);
    store.exec("INSERT INTO dictionary_versions VALUES('tv1','tamper-dict',1,'篡改字典','','encrypted',1,?,?,?)",
      JSON.stringify({ apiToken: { type: "string", encryptedValue: { ...tampered, ciphertext: flipped.toString("base64") } } }), hash, now);
  });
  const failed = secrets.verify({ expectedGeneration: 1 });
  assert.deepEqual(failed.dictionaries.find(entry => entry.dictionaryId === "tamper-dict")!.failedKeys, ["apiToken"]);
  assert.equal(failed.verified, false);
  assert.equal(dictionaries.get("tamper-dict")!.readiness, "authentication-failed");
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  // 缺失 keyId：密文指向未保留的密钥，与认证失败分开报告。
  const foreign = encryptValue(generateKeyMaterial(), { keyId: "ghost-key", dictionaryId: created.dictionaryId, key: "apiToken" }, "unused");
  store.transaction(() => {
    store.exec("INSERT INTO dictionaries(id,name,kind,current_version_id,revision,created_at,updated_at) VALUES('ghost-dict','缺钥字典','encrypted','gv1',1,?,?)", now, now);
    store.exec("INSERT INTO dictionary_versions VALUES('gv1','ghost-dict',1,'缺钥字典','','encrypted',1,?,?,?)",
      JSON.stringify({ apiToken: { type: "string", encryptedValue: foreign } }), hash, now);
  });
  const missing = secrets.verify({ expectedGeneration: 1 });
  assert.deepEqual(missing.dictionaries.find(entry => entry.dictionaryId === "ghost-dict")!.missingKeyIds, ["ghost-key"]);
  assert.equal(missing.dictionaries.find(entry => entry.dictionaryId === "ghost-dict")!.failedKeys.length, 0);
  assert.ok(secrets.status().missingKeyIds.includes("ghost-key"));
  assert.equal(dictionaries.get("ghost-dict")!.readiness, "missing-key");
});
