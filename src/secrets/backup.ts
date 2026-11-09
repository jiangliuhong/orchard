import { AppError, check } from "../domain/errors.js";
import { parseStrictJson } from "../dictionaries/canonical.js";
import { compareUtf8Keys } from "../dictionaries/canonical.js";
import { checkCanonicalBase64, encodeCanonicalBase64, validateKeyId, validateKeyMaterial, KEY_MATERIAL_BYTES } from "./keys.js";

/**
 * 版本化密钥备份格式（设计 §6.3）。
 * 包含 formatVersion: 1、可选 activeKeyId 以及 keys: [{ keyId, algorithm, material }]；
 * algorithm 固定为 aes-256-gcm，material 为 32 字节密钥的规范 Base64。
 * 导入拒绝未知字段、重复 keyId、非法编码和格式版本；文件最多 1 MiB、合并后最多 256 把密钥。
 * 备份不包含字典值、Provider 凭据、运行上下文或本机命令回执 HMAC 密钥。
 */

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_ALGORITHM = "aes-256-gcm";
export const MAX_BACKUP_BYTES = 1024 * 1024;
export const MAX_KEYRING_KEYS = 256;

export interface KeyringBackupKey {
  keyId: string;
  algorithm: "aes-256-gcm";
  material: string;
}

export interface KeyringBackup {
  formatVersion: 1;
  activeKeyId?: string;
  keys: KeyringBackupKey[];
}

const KEY_FIELDS = ["algorithm", "keyId", "material"] as const;

function formatInvalid(message: string): never {
  throw new AppError("SECRET_KEYRING_FORMAT_INVALID", message, 422);
}

function parseBackupKey(value: unknown): KeyringBackupKey {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "SECRET_KEYRING_FORMAT_INVALID", "备份密钥条目必须是对象");
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  check(fields.length === KEY_FIELDS.length && fields.every((field, index) => field === KEY_FIELDS[index]), "SECRET_KEYRING_FORMAT_INVALID", "备份密钥条目字段不符合规范");
  const keyId = validateKeyId(record.keyId);
  check(record.algorithm === BACKUP_ALGORITHM, "SECRET_KEYRING_FORMAT_INVALID", "备份密钥算法不支持");
  const material = checkCanonicalBase64(record.material, KEY_MATERIAL_BYTES, "SECRET_KEYRING_FORMAT_INVALID", "备份密钥材料编码无效").toString("base64");
  return { keyId, algorithm: BACKUP_ALGORITHM, material };
}

/** 解析备份文件或其完整文本；重复对象键由严格解析器拒绝，不使用普通 JSON.parse。 */
export function parseKeyringBackup(text: unknown): KeyringBackup {
  check(typeof text === "string" && text.length > 0, "SECRET_KEYRING_FORMAT_INVALID", "备份内容不能为空");
  check(Buffer.byteLength(text, "utf8") <= MAX_BACKUP_BYTES, "SECRET_KEYRING_FORMAT_INVALID", "备份文件超过 1 MiB 限制");
  const value = parseStrictJson(text, { maxDepth: 32 });
  check(value !== null && typeof value === "object" && !Array.isArray(value), "SECRET_KEYRING_FORMAT_INVALID", "备份必须是 JSON 对象");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["activeKeyId", "formatVersion", "keys"]);
  for (const field of Object.keys(record)) check(allowed.has(field), "SECRET_KEYRING_FORMAT_INVALID", `备份包含未知字段 ${field}`);
  check(record.formatVersion === BACKUP_FORMAT_VERSION, "SECRET_KEYRING_FORMAT_INVALID", "不支持的备份格式版本");
  check(Array.isArray(record.keys) && record.keys.length > 0, "SECRET_KEYRING_FORMAT_INVALID", "备份密钥列表不能为空");
  const keys = record.keys.map(parseBackupKey);
  const ids = new Set<string>();
  for (const key of keys) {
    check(!ids.has(key.keyId), "SECRET_KEYRING_FORMAT_INVALID", `备份中 keyId 重复: ${key.keyId}`);
    ids.add(key.keyId);
  }
  if (record.activeKeyId !== undefined) {
    check(typeof record.activeKeyId === "string" && ids.has(record.activeKeyId), "SECRET_KEYRING_FORMAT_INVALID", "备份 activeKeyId 不在密钥列表中");
  }
  return record.activeKeyId === undefined
    ? { formatVersion: BACKUP_FORMAT_VERSION, keys }
    : { formatVersion: BACKUP_FORMAT_VERSION, activeKeyId: record.activeKeyId, keys };
}

/** 相同内容连续导出必须字节一致；按 UTF-8 字节序输出，不重新加密。 */
export function serializeKeyringBackup(backup: KeyringBackup): string {
  const keys = [...backup.keys].sort((a, b) => compareUtf8Keys(a.keyId, b.keyId))
    .map(key => ({ algorithm: key.algorithm, keyId: key.keyId, material: key.material }));
  const value: Record<string, unknown> = { formatVersion: BACKUP_FORMAT_VERSION, keys };
  if (backup.activeKeyId !== undefined) value.activeKeyId = backup.activeKeyId;
  return JSON.stringify(value);
}

export interface KeyringMergeResult {
  keys: KeyringBackupKey[];
  addedKeyIds: string[];
  unchangedKeyIds: string[];
}

/**
 * 原子合并语义：相同 keyId 且相同材料为无变化，相同 keyId 不同材料拒绝，
 * 不能覆盖以“修复”解密错误；一项冲突则全部不应用。
 */
export function mergeKeyringBackups(existing: readonly KeyringBackupKey[], incoming: readonly KeyringBackupKey[]): KeyringMergeResult {
  const byId = new Map<string, KeyringBackupKey>();
  for (const key of existing) byId.set(key.keyId, key);
  const added: string[] = [];
  const unchanged: string[] = [];
  for (const key of incoming) {
    const prior = byId.get(key.keyId);
    if (!prior) {
      byId.set(key.keyId, key);
      added.push(key.keyId);
    } else {
      check(prior.material === key.material, "SECRET_KEY_CONFLICT", `keyId ${key.keyId} 已存在且密钥材料不同，拒绝覆盖`, 409);
      unchanged.push(key.keyId);
    }
  }
  check(byId.size <= MAX_KEYRING_KEYS, "SECRET_KEYRING_FORMAT_INVALID", "合并后密钥数量超过 256 上限");
  return { keys: [...byId.values()], addedKeyIds: added, unchangedKeyIds: unchanged };
}

/** 备份密钥材料解码；供密钥环写入与验证使用，不落日志。 */
export function decodeBackupKeyMaterial(key: KeyringBackupKey): Buffer {
  return validateKeyMaterial(Buffer.from(key.material, "base64"));
}

export { encodeCanonicalBase64 };
