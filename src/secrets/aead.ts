import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError, check } from "../domain/errors.js";
import { canonicalJson } from "../dictionaries/canonical.js";
import { DICTIONARY_LIMITS } from "../dictionaries/model.js";
import { checkCanonicalBase64, encodeCanonicalBase64, validateKeyMaterial, validateKeyId } from "./keys.js";

/**
 * 加密字典值的 AEAD 封装（设计 §6.1）。
 * AES-256-GCM；每次新写入或替换一个值生成随机 12 字节 nonce，保存 16 字节认证 tag。
 * AAD 为规范化 JSON，固定包含 formatVersion、algorithm、keyId、dictionaryId、key 和 type，
 * 避免将密文移到另一个字典或键后仍可解密；不包含本机序号或修订版本 ID。
 */

export const ENVELOPE_FORMAT_VERSION = 1;
export const ENVELOPE_ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedValue {
  formatVersion: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface AeadContext {
  keyId: string;
  dictionaryId: string;
  key: string;
}

const ENVELOPE_FIELDS = ["algorithm", "ciphertext", "formatVersion", "keyId", "nonce", "tag"] as const;

/** 字段名、Base64 长度与未知算法严格校验；认证失败由解密侧直接拒绝。 */
export function validateEncryptedValue(value: unknown): asserts value is EncryptedValue {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "INVALID_DICTIONARY", "加密值封装必须是对象");
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  check(fields.length === ENVELOPE_FIELDS.length && fields.every((field, index) => field === ENVELOPE_FIELDS[index]), "INVALID_DICTIONARY", "加密值封装字段不符合规范");
  check(record.formatVersion === ENVELOPE_FORMAT_VERSION, "INVALID_DICTIONARY", "不支持的加密封装格式版本");
  check(record.algorithm === ENVELOPE_ALGORITHM, "INVALID_DICTIONARY", "不支持的加密算法");
  validateKeyId(record.keyId);
  checkCanonicalBase64(record.nonce, NONCE_BYTES, "INVALID_DICTIONARY", "nonce 编码无效");
  checkCanonicalBase64(record.ciphertext, Buffer.from(record.ciphertext as string, "base64").byteLength, "INVALID_DICTIONARY", "ciphertext 编码无效");
  checkCanonicalBase64(record.tag, TAG_BYTES, "INVALID_DICTIONARY", "tag 编码无效");
}

/** 已有密文按 GCM ciphertext 的解码字节数检查限额。 */
export function encryptedValueByteLength(value: EncryptedValue): number {
  return Buffer.from(value.ciphertext, "base64").byteLength;
}

function buildAad(context: AeadContext): Buffer {
  return Buffer.from(canonicalJson({
    algorithm: ENVELOPE_ALGORITHM,
    dictionaryId: context.dictionaryId,
    formatVersion: ENVELOPE_FORMAT_VERSION,
    key: context.key,
    keyId: context.keyId,
    type: "string",
  }), "utf8");
}

function assertContext(context: AeadContext): void {
  validateKeyId(context.keyId);
  check(typeof context.dictionaryId === "string" && context.dictionaryId.length > 0, "INVALID_DICTIONARY", "dictionaryId 不能为空");
  check(typeof context.key === "string" && context.key.length > 0, "INVALID_DICTIONARY", "加密键名不能为空");
}

/** 明文长度在加密前计量；超限在写入前拒绝，不产生密文。 */
export function encryptValue(material: Uint8Array, context: AeadContext, plaintext: string): EncryptedValue {
  assertContext(context);
  const key = validateKeyMaterial(material);
  check(typeof plaintext === "string", "INVALID_DICTIONARY", "加密值必须是字符串");
  check(Buffer.byteLength(plaintext, "utf8") <= DICTIONARY_LIMITS.valueMaxBytes, "INVALID_DICTIONARY", "加密值超过 64 KiB 限制");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ENVELOPE_ALGORITHM, key, nonce);
  cipher.setAAD(buildAad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    formatVersion: ENVELOPE_FORMAT_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    keyId: context.keyId,
    nonce: encodeCanonicalBase64(nonce),
    ciphertext: encodeCanonicalBase64(ciphertext),
    tag: encodeCanonicalBase64(cipher.getAuthTag()),
  };
}

/** 认证失败、封装损坏或密钥不匹配一律返回 SECRET_DECRYPT_FAILED，不回显细节。 */
export function decryptValue(material: Uint8Array, context: AeadContext, value: unknown): string {
  assertContext(context);
  const key = validateKeyMaterial(material);
  validateEncryptedValue(value);
  try {
    const decipher = createDecipheriv(ENVELOPE_ALGORITHM, key, Buffer.from(value.nonce, "base64"));
    decipher.setAAD(buildAad(context));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("SECRET_DECRYPT_FAILED", "加密值解密失败，密钥缺失或不匹配", 422);
  }
}

/** 服务端生成随机 32 字节密钥材料。 */
export function generateKeyMaterial(): Buffer {
  return randomBytes(32);
}
