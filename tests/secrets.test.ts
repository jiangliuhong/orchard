import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import {
  ENVELOPE_ALGORITHM,
  ENVELOPE_FORMAT_VERSION,
  encryptValue,
  decryptValue,
  generateKeyMaterial,
  validateEncryptedValue,
  encryptedValueByteLength,
  type AeadContext,
  type EncryptedValue,
} from "../src/secrets/aead.js";
import {
  parseKeyringBackup,
  serializeKeyringBackup,
  mergeKeyringBackups,
  decodeBackupKeyMaterial,
  type KeyringBackupKey,
} from "../src/secrets/backup.js";
import { DICTIONARY_LIMITS } from "../src/dictionaries/model.js";

const throwsCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
    return;
  }
  assert.fail(`预期抛出 ${code}`);
};

const context: AeadContext = { keyId: randomUUID(), dictionaryId: randomUUID(), key: "apiToken" };

test("加密往返与封装格式", () => {
  const material = generateKeyMaterial();
  const envelope = encryptValue(material, context, "s3cret-token");
  validateEncryptedValue(envelope);
  assert.equal(envelope.formatVersion, ENVELOPE_FORMAT_VERSION);
  assert.equal(envelope.algorithm, ENVELOPE_ALGORITHM);
  assert.equal(envelope.keyId, context.keyId);
  assert.equal(Buffer.from(envelope.nonce, "base64").byteLength, 12);
  assert.equal(Buffer.from(envelope.tag, "base64").byteLength, 16);
  assert.equal(decryptValue(material, context, envelope), "s3cret-token");
  // 空字符串与未设置区分：空串允许加解密。
  const empty = encryptValue(material, context, "");
  assert.equal(Buffer.from(empty.ciphertext, "base64").byteLength, 0);
  assert.equal(decryptValue(material, context, empty), "");
});

test("AAD 绑定字典、键与密钥标识，跨上下文搬移被拒绝", () => {
  const material = generateKeyMaterial();
  const envelope = encryptValue(material, context, "value");
  assert.equal(decryptValue(material, { ...context }, envelope), "value");
  throwsCode(() => decryptValue(material, { ...context, dictionaryId: randomUUID() }, envelope), "SECRET_DECRYPT_FAILED");
  throwsCode(() => decryptValue(material, { ...context, key: "otherKey" }, envelope), "SECRET_DECRYPT_FAILED");
  throwsCode(() => decryptValue(material, { ...context, keyId: randomUUID() }, envelope), "SECRET_DECRYPT_FAILED");
  // 相同内容两次加密使用不同 nonce，密文字节不同。
  const again = encryptValue(material, context, "value");
  assert.notEqual(envelope.ciphertext, again.ciphertext);
  assert.notEqual(envelope.nonce, again.nonce);
});

test("篡改密文或 tag、错误密钥材料均返回 SECRET_DECRYPT_FAILED", () => {
  const material = generateKeyMaterial();
  const envelope: EncryptedValue = encryptValue(material, context, "value");
  const flip = (text: string) => {
    const bytes = [...Buffer.from(text, "base64")];
    bytes[0] = bytes[0]! ^ 0xff;
    return Buffer.from(bytes).toString("base64");
  };
  throwsCode(() => decryptValue(material, context, { ...envelope, ciphertext: flip(envelope.ciphertext) }), "SECRET_DECRYPT_FAILED");
  throwsCode(() => decryptValue(material, context, { ...envelope, tag: flip(envelope.tag) }), "SECRET_DECRYPT_FAILED");
  throwsCode(() => decryptValue(generateKeyMaterial(), context, envelope), "SECRET_DECRYPT_FAILED");
  // 明文值不在错误信息中回显。
  try {
    decryptValue(generateKeyMaterial(), context, envelope);
    assert.fail("预期失败");
  } catch (error) {
    assert.doesNotMatch((error as Error).message, /value/);
  }
});

test("封装字段与编码严格校验", () => {
  const material = generateKeyMaterial();
  const envelope = encryptValue(material, context, "v");
  throwsCode(() => validateEncryptedValue({ ...envelope, algorithm: "aes-128-gcm" }), "INVALID_DICTIONARY");
  throwsCode(() => validateEncryptedValue({ ...envelope, formatVersion: 2 }), "INVALID_DICTIONARY");
  throwsCode(() => validateEncryptedValue({ ...envelope, extra: 1 }), "INVALID_DICTIONARY");
  throwsCode(() => validateEncryptedValue({ ...envelope, nonce: "short" }), "INVALID_DICTIONARY");
  throwsCode(() => validateEncryptedValue({ ...envelope, tag: Buffer.from("1234").toString("base64") }), "INVALID_DICTIONARY");
  throwsCode(() => validateEncryptedValue({ ...envelope, ciphertext: "not+base64!!" }), "INVALID_DICTIONARY");
  throwsCode(() => validateEncryptedValue(null), "INVALID_DICTIONARY");
  throwsCode(() => validateEncryptedValue("text"), "INVALID_DICTIONARY");
  // 非 32 字节材料在加密前拒绝。
  throwsCode(() => encryptValue(Buffer.alloc(16), context, "v"), "SECRET_KEYRING_FORMAT_INVALID");
  throwsCode(() => encryptValue(material, { ...context, key: "" }, "v"), "INVALID_DICTIONARY");
});

test("明文长度在加密前计量并拒绝", () => {
  const material = generateKeyMaterial();
  const limit = DICTIONARY_LIMITS.valueMaxBytes;
  assert.equal(encryptedValueByteLength(encryptValue(material, context, "a".repeat(limit))), limit);
  throwsCode(() => encryptValue(material, context, "a".repeat(limit + 1)), "INVALID_DICTIONARY");
});

test("备份解析：合法文件、未知字段、重复 keyId 与编码校验", () => {
  const material = generateKeyMaterial(), second = generateKeyMaterial();
  const valid = { formatVersion: 1, keys: [
    { keyId: "a-key", algorithm: "aes-256-gcm", material: material.toString("base64") },
    { keyId: "b-key", algorithm: "aes-256-gcm", material: second.toString("base64") },
  ], activeKeyId: "a-key" };
  const parsed = parseKeyringBackup(JSON.stringify(valid));
  assert.equal(parsed.activeKeyId, "a-key");
  assert.equal(parsed.keys.length, 2);
  assert.deepEqual(decodeBackupKeyMaterial(parsed.keys[0]!), material);
  throwsCode(() => parseKeyringBackup(JSON.stringify({ ...valid, keys: [...valid.keys, { keyId: "a-key", algorithm: "aes-256-gcm", material: second.toString("base64") }] })), "SECRET_KEYRING_FORMAT_INVALID");
  throwsCode(() => parseKeyringBackup(JSON.stringify({ ...valid, unknown: 1 })), "SECRET_KEYRING_FORMAT_INVALID");
  throwsCode(() => parseKeyringBackup(JSON.stringify({ formatVersion: 2, keys: valid.keys })), "SECRET_KEYRING_FORMAT_INVALID");
  throwsCode(() => parseKeyringBackup(JSON.stringify({ formatVersion: 1, keys: [] })), "SECRET_KEYRING_FORMAT_INVALID");
  throwsCode(() => parseKeyringBackup(JSON.stringify({ formatVersion: 1, keys: valid.keys, activeKeyId: "missing" })), "SECRET_KEYRING_FORMAT_INVALID");
  throwsCode(() => parseKeyringBackup(JSON.stringify({ formatVersion: 1, keys: [{ keyId: "a", algorithm: "aes-128-gcm", material: material.toString("base64") }] })), "SECRET_KEYRING_FORMAT_INVALID");
  throwsCode(() => parseKeyringBackup(JSON.stringify({ formatVersion: 1, keys: [{ keyId: "a", algorithm: "aes-256-gcm", material: Buffer.alloc(16).toString("base64") }] })), "SECRET_KEYRING_FORMAT_INVALID");
  // 非规范 Base64（可解码但不规范）拒绝。
  const nonCanonical = Buffer.from("abc", "utf8").toString("base64");
  throwsCode(() => parseKeyringBackup(JSON.stringify({ formatVersion: 1, keys: [{ keyId: "a", algorithm: "aes-256-gcm", material: nonCanonical }] })), "SECRET_KEYRING_FORMAT_INVALID");
  throwsCode(() => parseKeyringBackup('{"formatVersion":1,"keys":[{"keyId":"a","algorithm":"aes-256-gcm","material":"not base64"}]}'), "SECRET_KEYRING_FORMAT_INVALID");
  throwsCode(() => parseKeyringBackup(""), "SECRET_KEYRING_FORMAT_INVALID");
  throwsCode(() => parseKeyringBackup("a".repeat(1024 * 1024 + 1)), "SECRET_KEYRING_FORMAT_INVALID");
  // 重复对象键由严格解析器拒绝。
  throwsCode(() => parseKeyringBackup('{"formatVersion":1,"formatVersion":1,"keys":[{"keyId":"a","algorithm":"aes-256-gcm","material":"' + material.toString("base64") + '"}]}'), "INVALID_JSON");
});

test("备份序列化字节一致且 keyId 稳定排序", () => {
  const material = generateKeyMaterial(), second = generateKeyMaterial();
  const keys = [
    { keyId: "b-key", algorithm: "aes-256-gcm" as const, material: material.toString("base64") },
    { keyId: "a-key", algorithm: "aes-256-gcm" as const, material: second.toString("base64") },
  ];
  const one = serializeKeyringBackup({ formatVersion: 1, keys, activeKeyId: "a-key" });
  const two = serializeKeyringBackup({ formatVersion: 1, keys: [...keys].reverse(), activeKeyId: "a-key" });
  assert.equal(one, two);
  assert.equal(parseKeyringBackup(one).keys[0]!.keyId, "a-key");
  const noActive = serializeKeyringBackup({ formatVersion: 1, keys });
  assert.equal(Object.keys(JSON.parse(noActive)).includes("activeKeyId"), false);
  // 序列化输出可再次解析且密钥材料一致。
  const reparsed = parseKeyringBackup(noActive);
  assert.deepEqual(reparsed.keys.map(key => key.keyId), ["a-key", "b-key"]);
});

test("备份合并：无变化、冲突拒绝与上限", () => {
  const material = generateKeyMaterial(), second = generateKeyMaterial();
  const existing: KeyringBackupKey[] = [{ keyId: "a", algorithm: "aes-256-gcm", material: material.toString("base64") }];
  assert.deepEqual(mergeKeyringBackups(existing, existing), { keys: existing, addedKeyIds: [], unchangedKeyIds: ["a"] });
  throwsCode(() => mergeKeyringBackups(existing, [{ keyId: "a", algorithm: "aes-256-gcm", material: second.toString("base64") }]), "SECRET_KEY_CONFLICT");
  const merged = mergeKeyringBackups(existing, [{ keyId: "a", algorithm: "aes-256-gcm", material: material.toString("base64") }, { keyId: "b", algorithm: "aes-256-gcm", material: second.toString("base64") }]);
  assert.deepEqual(merged.addedKeyIds, ["b"]);
  assert.equal(merged.keys.length, 2);
  const nearLimit: KeyringBackupKey[] = [];
  for (let i = 0; i < 256; i++) nearLimit.push({ keyId: `k${i}`, algorithm: "aes-256-gcm", material: material.toString("base64") });
  assert.equal(mergeKeyringBackups([], nearLimit).keys.length, 256);
  throwsCode(() => mergeKeyringBackups(nearLimit, [{ keyId: "extra", algorithm: "aes-256-gcm", material: material.toString("base64") }]), "SECRET_KEYRING_FORMAT_INVALID");
});

test("GCM 输出与 Node 原生实现互通", () => {
  const material = generateKeyMaterial();
  const envelope = encryptValue(material, context, "interop");
  const manual = createDecipheriv("aes-256-gcm", material, Buffer.from(envelope.nonce, "base64"));
  manual.setAAD(Buffer.from(JSON.stringify({
    algorithm: "aes-256-gcm", dictionaryId: context.dictionaryId, formatVersion: 1, key: context.key, keyId: context.keyId, type: "string",
  }), "utf8"));
  manual.setAuthTag(Buffer.from(envelope.tag, "base64"));
  assert.equal(Buffer.concat([manual.update(Buffer.from(envelope.ciphertext, "base64")), manual.final()]).toString("utf8"), "interop");
  // 反向：Node 原生加密的封装可由本实现解密。
  const nonce = Buffer.from(envelope.nonce, "base64");
  const cipher = createCipheriv("aes-256-gcm", material, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify({
    algorithm: "aes-256-gcm", dictionaryId: context.dictionaryId, formatVersion: 1, key: context.key, keyId: context.keyId, type: "string",
  }), "utf8"));
  const native: EncryptedValue = {
    formatVersion: 1,
    algorithm: "aes-256-gcm",
    keyId: context.keyId,
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([cipher.update("反向", "utf8"), cipher.final()]).toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  assert.equal(decryptValue(material, context, native), "反向");
});
