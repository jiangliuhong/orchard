import { createHash } from "node:crypto";
import { check, AppError } from "../domain/errors.js";
import { canonicalJson, jsonDepth, compareUtf8Keys } from "./canonical.js";
import { validateEncryptedValue, type EncryptedValue } from "../secrets/aead.js";

/**
 * 字典对象与条目模型（设计 §3.1）。
 * kind 在创建后不可切换；普通条目按类型严格校验，不做字符串隐式转换；
 * 加密条目仅支持字符串。限额在写入前拒绝：单值 64 KiB、每字典 500 键、
 * 每修订合计 1 MiB、JSON 嵌套深度 32。
 */

export type DictionaryKind = "plain" | "encrypted";
export type PlainEntryType = "string" | "number" | "boolean" | "json";

export interface PlainEntry { type: PlainEntryType; value: unknown }
export interface EncryptedEntry { type: "string"; encryptedValue: EncryptedValue }
export type DictionaryEntry = PlainEntry | EncryptedEntry;
export type DictionaryEntries = Record<string, DictionaryEntry>;

export interface DictionaryVersionContent {
  name: string;
  description: string;
  enabled: boolean;
  kind: DictionaryKind;
  entries: DictionaryEntries;
}

export const DICTIONARY_LIMITS = {
  nameMinCodePoints: 1,
  nameMaxCodePoints: 100,
  descriptionMaxCodePoints: 2000,
  keyPattern: /^[A-Za-z][A-Za-z0-9_-]{0,99}$/,
  maxKeys: 500,
  valueMaxBytes: 64 * 1024,
  totalMaxBytes: 1024 * 1024,
  jsonMaxDepth: 32,
} as const;

const codePoints = (text: string) => [...text].length;

/** 名称去除首尾空白、长度 1–100（按 Unicode 码点计数）。 */
export function validateDictionaryName(name: unknown): string {
  check(typeof name === "string", "INVALID_DICTIONARY", "字典名称必须是字符串");
  check(name === name.trim(), "INVALID_DICTIONARY", "字典名称不能以空白开头或结尾");
  const length = codePoints(name);
  check(length >= DICTIONARY_LIMITS.nameMinCodePoints && length <= DICTIONARY_LIMITS.nameMaxCodePoints, "INVALID_DICTIONARY", "字典名称长度必须在 1 到 100 个字符之间");
  return name;
}

/** 说明最长 2000 字符；名称、说明和键名不承诺保密。 */
export function validateDictionaryDescription(description: unknown): string {
  check(typeof description === "string", "INVALID_DICTIONARY", "字典说明必须是字符串");
  check(codePoints(description) <= DICTIONARY_LIMITS.descriptionMaxCodePoints, "INVALID_DICTIONARY", "字典说明长度不能超过 2000 个字符");
  return description;
}

/** 键名区分大小写；点不表示层级，JSON 子路径通过 pointer 选择。 */
export function validateDictionaryKey(key: unknown): string {
  check(typeof key === "string" && DICTIONARY_LIMITS.keyPattern.test(key), "INVALID_DICTIONARY", "键名必须以字母开头，仅允许字母、数字、下划线和中划线，长度 1 到 100");
  return key;
}

export function validateDictionaryKind(kind: unknown): DictionaryKind {
  check(kind === "plain" || kind === "encrypted", "INVALID_DICTIONARY", "字典类型必须是 plain 或 encrypted");
  return kind;
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value)), "INVALID_DICTIONARY", "条目集合必须是普通对象");
}

/** 字符串按原字符串 UTF-8 字节计量；其他普通值按规范化 JSON 的 UTF-8 字节计量。 */
export function plainEntryByteLength(entry: PlainEntry): number {
  if (entry.type === "string") {
    check(typeof entry.value === "string", "INVALID_DICTIONARY", "字符串条目的值必须是字符串");
    return Buffer.byteLength(entry.value, "utf8");
  }
  return Buffer.byteLength(canonicalJson(entry.value), "utf8");
}

/** 已有密文按 GCM ciphertext 的解码字节数检查限额，不另存或展示明文长度。 */
export function encryptedEntryByteLength(entry: EncryptedEntry): number {
  return Buffer.byteLength(Buffer.from(entry.encryptedValue.ciphertext, "base64"));
}

export function entryByteLength(entry: DictionaryEntry): number {
  return "encryptedValue" in entry ? encryptedEntryByteLength(entry) : plainEntryByteLength(entry);
}

function validatePlainValue(type: PlainEntryType, value: unknown): void {
  switch (type) {
    case "string": check(typeof value === "string", "INVALID_DICTIONARY", "string 条目的值必须是字符串"); return;
    case "number": check(typeof value === "number" && Number.isFinite(value), "INVALID_DICTIONARY", "number 条目的值必须是有限数字"); return;
    case "boolean": check(typeof value === "boolean", "INVALID_DICTIONARY", "boolean 条目的值必须是布尔值"); return;
    case "json": {
      check(value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value) || typeof value === "object" && value !== null, "INVALID_DICTIONARY", "json 条目的值必须是合法 JSON 值");
      if (typeof value === "number") check(Number.isFinite(value), "INVALID_DICTIONARY", "json 条目的数字必须有限");
      // 规范化同时拒绝非普通对象、稀疏数组与非有限数字；字典条目统一报告 INVALID_DICTIONARY。
      try {
        canonicalJson(value);
      } catch (error) {
        if (error instanceof AppError && error.code === "INVALID_JSON") throw new AppError("INVALID_DICTIONARY", "json 条目的值必须为合法 JSON");
        throw error;
      }
      check(jsonDepth(value) <= DICTIONARY_LIMITS.jsonMaxDepth, "INVALID_DICTIONARY", "JSON 嵌套深度超过 32");
      return;
    }
  }
}

function validateEntry(key: string, value: unknown, kind: DictionaryKind): DictionaryEntry {
  validateDictionaryKey(key);
  assertPlainObject(value);
  if (kind === "plain") {
    check(Object.keys(value).length === 2 && Object.hasOwn(value, "type") && Object.hasOwn(value, "value"), "INVALID_DICTIONARY", `键 ${key} 的普通条目必须恰好包含 type 与 value`);
    const type = value.type;
    check(type === "string" || type === "number" || type === "boolean" || type === "json", "INVALID_DICTIONARY", `键 ${key} 的条目类型必须是 string、number、boolean 或 json`);
    const entry: PlainEntry = { type, value: value.value };
    validatePlainValue(type, entry.value);
    check(plainEntryByteLength(entry) <= DICTIONARY_LIMITS.valueMaxBytes, "INVALID_DICTIONARY", `键 ${key} 的值超过 64 KiB 限制`);
    return entry;
  }
  check(Object.keys(value).length === 2 && value.type === "string" && Object.hasOwn(value, "encryptedValue"), "INVALID_DICTIONARY", `键 ${key} 的加密条目必须恰好包含 type 与 encryptedValue 且类型为 string`);
  const entry: EncryptedEntry = { type: "string", encryptedValue: value.encryptedValue as EncryptedValue };
  validateEncryptedValue(entry.encryptedValue);
  check(encryptedEntryByteLength(entry) <= DICTIONARY_LIMITS.valueMaxBytes, "INVALID_DICTIONARY", `键 ${key} 的密文超过 64 KiB 限制`);
  return entry;
}

/**
 * 校验完整条目集合：键名规则、kind 匹配、单值与合计限额、键数量。
 * 对象键天然去重；重复键由严格 JSON 解析器在文本入口拒绝。
 */
export function validateEntries(kind: DictionaryKind, entries: unknown): DictionaryEntries {
  assertPlainObject(entries);
  const keys = Object.keys(entries);
  check(keys.length <= DICTIONARY_LIMITS.maxKeys, "INVALID_DICTIONARY", "每个字典最多 500 个键");
  const normalized: DictionaryEntries = {};
  let total = 0;
  for (const key of keys.sort(compareUtf8Keys)) {
    const entry = validateEntry(key, entries[key], kind);
    total += entryByteLength(entry);
    check(total <= DICTIONARY_LIMITS.totalMaxBytes, "INVALID_DICTIONARY", "每个修订的值合计超过 1 MiB 限制");
    normalized[key] = entry;
  }
  return normalized;
}

/**
 * 可移植内容摘要：基于规范化定义，排除本机 revision、versionNo 与时间；
 * 加密条目参与摘要的是密文封装。
 */
export function portableContentHash(content: DictionaryVersionContent): string {
  return createHash("sha256").update(canonicalJson({
    name: content.name,
    description: content.description,
    enabled: content.enabled,
    kind: content.kind,
    entries: content.entries,
  }), "utf8").digest("hex");
}

/** 同版本 ID 内容不同是硬冲突；用该比较确定“相同规范化内容”。 */
export function sameVersionContent(left: DictionaryVersionContent, right: DictionaryVersionContent): boolean {
  return portableContentHash(left) === portableContentHash(right);
}

export function dictionaryUnavailableError(reason: "disabled" | "missing" | "kind"): AppError {
  if (reason === "disabled") return new AppError("DICTIONARY_DISABLED", "字典已禁用，不能用于新运行", 422);
  if (reason === "kind") return new AppError("DICTIONARY_KIND_MISMATCH", "字典类型与声明不一致", 422);
  return new AppError("DICTIONARY_NOT_FOUND", "字典不存在", 404);
}

export function dictionaryKeyMissingError(key: string): AppError {
  return new AppError("DICTIONARY_KEY_MISSING", `字典缺少键 ${key}`, 422);
}
