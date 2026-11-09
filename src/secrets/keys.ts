import { check } from "../domain/errors.js";

/**
 * 密钥标识与材料的基础校验（设计 §6）。
 * 密钥材料为 32 字节随机数据；禁止把用户短口令直接作为 AES 密钥。
 */

export const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const KEY_MATERIAL_BYTES = 32;

/** 拒绝控制字符与空白边缘的 keyId；生成侧使用 UUID 亦满足本规则。 */
export function validateKeyId(keyId: unknown): string {
  check(typeof keyId === "string" && KEY_ID_PATTERN.test(keyId), "SECRET_KEYRING_FORMAT_INVALID", "keyId 格式无效");
  return keyId;
}

export function validateKeyMaterial(material: Uint8Array | Buffer): Buffer {
  check(material instanceof Uint8Array && material.byteLength === KEY_MATERIAL_BYTES, "SECRET_KEYRING_FORMAT_INVALID", "密钥材料必须是 32 字节");
  return Buffer.from(material);
}

export function encodeCanonicalBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** 标准 Base64 严格校验：字符集、长度与可逆性；解码后再编码必须与输入一致。 */
export function checkCanonicalBase64(text: unknown, byteLength: number, code: string, message: string): Buffer {
  check(typeof text === "string", code, message);
  check(/^[A-Za-z0-9+/]*={0,2}$/.test(text) && text.length % 4 === 0, code, message);
  const decoded = Buffer.from(text, "base64");
  check(decoded.byteLength === byteLength && decoded.toString("base64") === text, code, message);
  return decoded;
}
