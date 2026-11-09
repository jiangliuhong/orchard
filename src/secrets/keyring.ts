import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { checkSecretPath, secretStorageReadOnly } from "./files.js";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { AppError, check } from "../domain/errors.js";
import { parseStrictJson } from "../dictionaries/canonical.js";
import { durable } from "../migrations/journal.js";
import { checkCanonicalBase64, KEY_MATERIAL_BYTES, validateKeyId } from "./keys.js";
import type { KeyringBackupKey } from "./backup.js";

/**
 * 密钥环文件存储（设计 §6.2/§6.3/§7.4）。
 * 默认位于 <data-dir>/secrets/keyring.json，目录 0700、文件 0600，拒绝符号链接与宽松权限；
 * 部署可通过 ORCHARD_SECRET_KEYRING_FILE 指定 Git 目录之外的绝对路径。
 * 密钥环包含独立 keyId、密钥材料与活动写入密钥 ID、代次计数与本机操作记录；
 * 密钥材料不进入业务数据库、Git 导出、普通设置 DTO 或操作回执。
 */

export const KEYRING_FORMAT_VERSION = 1;
const SCOPE_PATTERN = /^(dictionary-secret|secrets):[a-z][a-z-]*$/;

export interface KeyringKeyRecord extends KeyringBackupKey {
  createdAt: number;
}

export interface KeyringOperationRecord {
  scope: string;
  requestId: string;
  requestHmac: string;
  result: Record<string, string | number | boolean | null>;
  recordedAt: number;
}

export interface KeyringFile {
  formatVersion: 1;
  generation: number;
  activeKeyId?: string;
  keys: KeyringKeyRecord[];
  operations: KeyringOperationRecord[];
}

export interface KeyringStatus {
  configured: boolean;
  generation: number;
  activeKeyId: string | null;
  readOnly: boolean;
  keys: { keyId: string; createdAt: number; active: boolean }[];
}

export const emptyKeyring = (): KeyringFile => ({ formatVersion: KEYRING_FORMAT_VERSION, generation: 0, keys: [], operations: [] });

/** 解析密钥环路径：绝对路径覆盖必须存在且不得落在数据目录的 config/（Git 工作树）之内。 */
export function resolveKeyringPath(dataDir: string): string {
  const override = process.env.ORCHARD_SECRET_KEYRING_FILE;
  if (override === undefined || override === "") return resolve(dataDir, "secrets", "keyring.json");
  check(isAbsolute(override), "SECRET_KEYRING_FORMAT_INVALID", "ORCHARD_SECRET_KEYRING_FILE 必须是绝对路径");
  const resolved = resolve(override);
  const forbidden = [resolve(dataDir, "config"), resolve(dataDir, "config-git")];
  check(!forbidden.some(directory => resolved === directory || resolved.startsWith(directory + sep)), "SECRET_KEYRING_FORMAT_INVALID", "密钥环文件不能位于配置 Git 目录之内");
  return resolved;
}

function assertSafeFile(path: string): void {
  // lstat 判断：存在但非普通文件（含坏符号链接）一律拒绝。
  const info = lstatSync(path, { throwIfNoEntry: false });
  check(!info || info.isFile() && !info.isSymbolicLink(), "SECRET_KEYRING_FORMAT_INVALID", "密钥环路径不能是符号链接");
}

function assertPermissions(path: string): void {
  if (!existsSync(path)) return;
  checkSecretPath(path);
}

const KEY_FIELDS = ["algorithm", "createdAt", "keyId", "material"] as const;
const OPERATION_FIELDS = ["recordedAt", "requestHmac", "requestId", "result", "scope"] as const;

function parseKeyring(text: string): KeyringFile {
  const value = parseStrictJson(text, { maxDepth: 32 });
  check(value !== null && typeof value === "object" && !Array.isArray(value), "SECRET_KEYRING_FORMAT_INVALID", "密钥环文件格式无效");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["activeKeyId", "formatVersion", "generation", "keys", "operations"]);
  for (const field of Object.keys(record)) check(allowed.has(field), "SECRET_KEYRING_FORMAT_INVALID", `密钥环文件包含未知字段 ${field}`);
  check(record.formatVersion === KEYRING_FORMAT_VERSION, "SECRET_KEYRING_FORMAT_INVALID", "不支持的密钥环格式版本");
  check(typeof record.generation === "number" && Number.isInteger(record.generation) && record.generation >= 0, "SECRET_KEYRING_FORMAT_INVALID", "密钥环代次无效");
  check(Array.isArray(record.keys) && Array.isArray(record.operations), "SECRET_KEYRING_FORMAT_INVALID", "密钥环文件集合无效");
  const keys = record.keys.map(entry => {
    check(entry !== null && typeof entry === "object" && !Array.isArray(entry), "SECRET_KEYRING_FORMAT_INVALID", "密钥条目无效");
    const key = entry as Record<string, unknown>;
    const fields = Object.keys(key).sort();
    check(fields.length === KEY_FIELDS.length && fields.every((field, index) => field === KEY_FIELDS[index]), "SECRET_KEYRING_FORMAT_INVALID", "密钥条目字段不符合规范");
    const keyId = validateKeyId(key.keyId);
    check(key.algorithm === "aes-256-gcm", "SECRET_KEYRING_FORMAT_INVALID", "密钥算法不支持");
    const material = checkCanonicalBase64(key.material, KEY_MATERIAL_BYTES, "SECRET_KEYRING_FORMAT_INVALID", "密钥材料编码无效").toString("base64");
    check(typeof key.createdAt === "number" && Number.isInteger(key.createdAt) && key.createdAt > 0, "SECRET_KEYRING_FORMAT_INVALID", "密钥创建时间无效");
    return { keyId, algorithm: "aes-256-gcm" as const, material, createdAt: key.createdAt };
  });
  check(keys.length <= 256 && new Set(keys.map(key => key.keyId)).size === keys.length, "SECRET_KEYRING_FORMAT_INVALID", "密钥列表重复或超限", 422);
  const operations = record.operations.map(entry => {
    check(entry !== null && typeof entry === "object" && !Array.isArray(entry), "SECRET_KEYRING_FORMAT_INVALID", "操作记录无效");
    const operation = entry as Record<string, unknown>;
    const fields = Object.keys(operation).sort();
    check(fields.length === OPERATION_FIELDS.length && fields.every((field, index) => field === OPERATION_FIELDS[index]), "SECRET_KEYRING_FORMAT_INVALID", "操作记录字段不符合规范");
    check(typeof operation.scope === "string" && SCOPE_PATTERN.test(operation.scope), "SECRET_KEYRING_FORMAT_INVALID", "操作记录 scope 无效");
    check(typeof operation.requestId === "string" && operation.requestId.length >= 1 && operation.requestId.length <= 200, "SECRET_KEYRING_FORMAT_INVALID", "操作记录 requestId 无效");
    check(typeof operation.requestHmac === "string" && /^[0-9a-f]{64}$/.test(operation.requestHmac), "SECRET_KEYRING_FORMAT_INVALID", "操作记录摘要无效");
    check(typeof operation.recordedAt === "number" && Number.isInteger(operation.recordedAt) && operation.recordedAt > 0, "SECRET_KEYRING_FORMAT_INVALID", "操作记录时间无效");
    const result = operation.result;
    check(result !== null && typeof result === "object" && !Array.isArray(result), "SECRET_KEYRING_FORMAT_INVALID", "操作记录结果无效");
    for (const [field, fieldValue] of Object.entries(result)) {
      check(fieldValue === null || ["string", "number", "boolean"].includes(typeof fieldValue), "SECRET_KEYRING_FORMAT_INVALID", "操作记录结果只允许安全元数据");
      check(/^[A-Za-z][A-Za-z0-9_]*$/.test(field), "SECRET_KEYRING_FORMAT_INVALID", "操作记录结果字段名无效");
    }
    return { scope: operation.scope, requestId: operation.requestId, requestHmac: operation.requestHmac, result: result as KeyringOperationRecord["result"], recordedAt: operation.recordedAt };
  });
  const keyring: KeyringFile = { formatVersion: KEYRING_FORMAT_VERSION, generation: record.generation, keys, operations };
  if (record.activeKeyId !== undefined) {
    check(typeof record.activeKeyId === "string" && keys.some(key => key.keyId === record.activeKeyId), "SECRET_KEYRING_FORMAT_INVALID", "活动密钥不在密钥列表中");
    keyring.activeKeyId = record.activeKeyId;
  }
  return keyring;
}

export class KeyringStore {
  /** probe 仅供测试注入只读探测；生产路径使用文件系统 accessSync。 */
  constructor(readonly path: string, private readonly probe?: () => boolean) {}


  exists(): boolean {
    checkSecretPath(this.path);
    assertSafeFile(this.path);
    return existsSync(this.path);
  }

  /** 读取完整密钥环；不存在返回 null，损坏或权限异常直接拒绝。 */
  load(): KeyringFile | null {
    if (!this.exists()) return null;
    assertPermissions(this.path);
    return parseKeyring(readFileSync(this.path, "utf8"));
  }

  fingerprint(): string | null {
    if (!this.exists()) return null;
    return createHash("sha256").update(readFileSync(this.path)).digest("hex");
  }

  /** 原子保存：临时文件 fsync 后 rename，并 fsync 父目录；目录 0700、文件 0600。落盘前先过严格解析自检。 */
  save(next: KeyringFile): void {
    checkSecretPath(this.path);
    check(!this.isReadOnly(), "SECRET_KEYRING_READ_ONLY", "密钥环存储只读，不能写入", 422);
    const body = JSON.stringify(next, null, 2);
    parseKeyring(body);
    try {
      durable(this.path, body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EROFS") {
        throw new AppError("SECRET_KEYRING_READ_ONLY", "密钥环存储只读，不能写入", 422);
      }
      throw error;
    }
    assertPermissions(this.path);
  }

  /** 探测存储可写性；目标目录不存在时向上找最近的已存在祖先。 */
  isReadOnly(): boolean {
    if (this.probe) return this.probe();
    return secretStorageReadOnly(this.path);
  }

  material(keyId: string): Buffer {
    const keyring = this.load();
    const key = keyring?.keys.find(candidate => candidate.keyId === keyId);
    check(key, "SECRET_KEY_MISSING", "缺少密钥材料", 422);
    return Buffer.from(key!.material, "base64");
  }

  activeKeyId(): string | null {
    return this.load()?.activeKeyId ?? null;
  }

  status(): KeyringStatus {
    const keyring = this.load();
    if (!keyring) return { configured: false, generation: 0, activeKeyId: null, readOnly: this.isReadOnly(), keys: [] };
    return {
      configured: true,
      generation: keyring.generation,
      activeKeyId: keyring.activeKeyId ?? null,
      readOnly: this.isReadOnly(),
      keys: keyring.keys.map(key => ({ keyId: key.keyId, createdAt: key.createdAt, active: key.keyId === keyring.activeKeyId })),
    };
  }

  /**
   * 幂等键环写入：先核对 (scope, requestId) 操作记录并返回原结果；
   * 未命中才检查只读与 expectedGeneration，执行变更并连同操作记录一次原子替换。
   * 无变化请求不递增 generation，但仍持久化首次成功回执。
   */
  write<T extends Record<string, string | number | boolean | null>>(
    scope: string,
    requestId: string,
    requestHmac: string,
    expectedGeneration: number,
    mutate: (keyring: KeyringFile) => { result: T; changed: boolean },
  ): T {
    check(typeof requestId === "string" && requestId.length > 0 && requestId.length <= 200, "INVALID_REQUEST_ID", "缺少有效 requestId");
    check(SCOPE_PATTERN.test(scope), "INVALID_SCOPE", "密钥环操作 scope 无效");
    const current = this.load() ?? emptyKeyring();
    const prior = current.operations.find(record => record.scope === scope && record.requestId === requestId);
    if (prior) {
      check(prior.requestHmac === requestHmac, "REQUEST_CONFLICT", "同一请求标识已用于不同内容", 409);
      return prior.result as T;
    }
    if (this.isReadOnly()) throw new AppError("SECRET_KEYRING_READ_ONLY", "密钥环存储只读，不能写入", 422);
    check(current.generation === expectedGeneration, "SECRET_KEYRING_GENERATION_CONFLICT", "密钥环代次已变化，请刷新后重试", 409);
    const draft: KeyringFile = { ...current, keys: [...current.keys] };
    const { result, changed } = mutate(draft);
    const next: KeyringFile = {
      ...draft,
      generation: current.generation + (changed ? 1 : 0),
      operations: [...current.operations, { scope, requestId, requestHmac, result, recordedAt: Date.now() }],
    };
    this.save(next);
    return result;
  }
}
