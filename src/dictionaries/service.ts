import { createHash, randomUUID } from "node:crypto";
import { AppError, check } from "../domain/errors.js";
import { DictionaryReferenceScanner } from "./references.js";
import { canonicalJson, parseStrictJson } from "./canonical.js";
import { portableContentHash, validateDictionaryDescription, validateDictionaryKey, validateDictionaryName, validateDictionaryKind, validateEntries, type DictionaryEntries, type DictionaryEntry, type DictionaryKind, type PlainEntryType } from "./model.js";
import { encryptValue, decryptValue, type EncryptedValue } from "../secrets/aead.js";
import { configCoordinator, type ConfigWriteCoordinator } from "../config-git/coordinator.js";
import type { DictionaryReadiness, SecretsService } from "../secrets/service.js";
import type { Store } from "../persistence/store.js";

/**
 * 字典管理服务（设计 §3/§6.4/§10.2）。
 * 每次有效保存产生不可变新修订；完全相同的保存返回无变化，不产生修订；
 * 更新必须携带 expectedRevision，并发冲突返回 409。
 * 普通字典写入使用 Store.command 原协议；加密字典写入经本机 HMAC 的敏感命令入口，
 * 明文只存在于请求内存与加密函数中，回执仅保存 HMAC 与安全 DTO。
 * 换钥先预览，token 绑定内容摘要、配置与密钥代次；全部值认证成功才产生新修订。
 */

export type DictionaryOperation =
  | { op: "set"; key: string; type: PlainEntryType; value: unknown }
  | { op: "remove"; key: string };

export interface DictionaryWriteResult {
  dictionaryId: string;
  versionId: string;
  revision: number;
  changed: boolean;
}

export interface DictionaryReferences {
  /** 按对象去重的键引用计数。 */
  scan?(dictionaryId: string): import("./references.js").ReferenceScan;
  keyReferences(dictionaryId: string, keys: string[]): { key: string; workflows: number; scripts: number }[];
}


interface DictionaryRow {
  id: string;
  name: string;
  kind: DictionaryKind;
  current_version_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface VersionRow {
  id: string;
  dictionary_id: string;
  version_no: number;
  name: string;
  description: string;
  kind: DictionaryKind;
  enabled: number;
  entries_json: string;
  content_hash: string;
  created_at: number;
}

export interface DictionaryListView {
  id: string;
  name: string;
  description: string;
  kind: DictionaryKind;
  enabled: boolean;
  revision: number;
  currentVersionId: string;
  createdAt: number;
  updatedAt: number;
  keyCount: number;
  readiness: DictionaryReadiness;
  missingKeyIds: string[];
  deletedAt: number | null;
}

export interface DictionaryDetailView extends DictionaryListView {
  versionNo: number;
  keys: Record<string, { type: PlainEntryType; value?: unknown } | { type: "string"; set: true; keyId: string }>;
}

export interface DictionaryVersionSummary {
  id: string;
  versionNo: number;
  name: string;
  description: string;
  enabled: boolean;
  createdAt: number;
}

export interface DictionaryVersionDetail extends DictionaryVersionSummary {
  id: string;
  dictionaryId: string;
  kind: DictionaryKind;
  keys: DictionaryDetailView["keys"];
}

export interface ReEncryptionPreviewView {
  token: string;
  expiresAt: number;
  targetKeyId: string;
  entriesTotal: number;
  willReEncrypt: number;
  alreadyMatched: number;
}

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const PAGE_DEFAULT_LIMIT = 50;
const PAGE_MAX_LIMIT = 100;

function validateOperations(value: unknown, options: { allowRemove: boolean }): DictionaryOperation[] {
  check(Array.isArray(value), "INVALID_DICTIONARY", "operations 必须是操作数组", 422);
  return value.map(entry => {
    check(entry !== null && typeof entry === "object" && !Array.isArray(entry), "INVALID_DICTIONARY", "操作必须是对象", 422);
    const record = entry as Record<string, unknown>;
    const op = record.op;
    if (op === "set") {
      const fields = Object.keys(record).sort();
      check(fields.length === 4 && fields[0] === "key" && fields[1] === "op" && fields[2] === "type" && fields[3] === "value", "INVALID_DICTIONARY", "set 操作字段必须是 op、key、type、value", 422);
      const type = record.type;
      check(type === "string" || type === "number" || type === "boolean" || type === "json", "INVALID_DICTIONARY", "set 操作类型必须是 string、number、boolean 或 json", 422);
      return { op: "set" as const, key: validateDictionaryKey(record.key), type, value: record.value };
    }
    if (op === "remove") {
      check(options.allowRemove, "INVALID_DICTIONARY", "创建字典不支持 remove 操作", 422);
      const fields = Object.keys(record).sort();
      check(fields.length === 2 && fields[0] === "key" && fields[1] === "op", "INVALID_DICTIONARY", "remove 操作字段必须是 op、key", 422);
      return { op: "remove" as const, key: validateDictionaryKey(record.key) };
    }
    throw new AppError("INVALID_DICTIONARY", "操作类型必须是 set 或 remove", 422);
  });
}

function parseEntries(kind: DictionaryKind, text: string): DictionaryEntries {
  return validateEntries(kind, parseStrictJson(text, { maxDepth: 40 }));
}

function decodeCursor(text: string): Record<string, unknown> {
  try {
    if (text.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error();
    const value = parseStrictJson(Buffer.from(text, "base64").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new AppError("INVALID_CURSOR", "分页游标无效", 400); }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class DictionaryService {
  readonly coordinator: ConfigWriteCoordinator;
  references: DictionaryReferences;
  private confirmations = new Map<string, { dictionaryId: string; requestDigest: string; targetRevision: number; referencesDigest: string; expiresAt: number }>();
  private reEncryptPreviews = new Map<string, { dictionaryId: string; expectedRevision: number; currentVersionId: string; contentHash: string; targetKeyId: string; configGeneration: number; keyGeneration: number; keyFingerprint: string | null; expiresAt: number }>();

  constructor(readonly store: Store, readonly secrets: SecretsService) {
    this.coordinator = secrets.coordinator;
    this.references = new DictionaryReferenceScanner(store);
  }

  referenceList(id: string, input: { view?: "current" | "history" | "all"; limit?: number; cursor?: string } = {}) {
    this.requireDictionary(id);
    return new DictionaryReferenceScanner(this.store).list(id, input);
  }

  /** 删除命令不含条目值，无需解密或访问密钥环。 */
  remove(id: string, input: { requestId: string; expectedRevision: number; permanent?: boolean; confirmationName?: string }) {
    check(Number.isInteger(input.expectedRevision) && input.expectedRevision > 0, "INVALID_DICTIONARY", "expectedRevision 必须是正整数", 422);
    const permanent = input.permanent === true;
    const request = { dictionaryId: id, expectedRevision: input.expectedRevision, permanent, confirmationName: input.confirmationName ?? null };
    return this.coordinator.withWrite(() => this.store.command("dictionaries:delete", input.requestId, request, () => {
      const row = this.requireDictionary(id);
      check(row.revision === input.expectedRevision, "REVISION_CONFLICT", "字典已被修改，请刷新后重试", 409);
      check(permanent ? row.deleted_at !== null : row.deleted_at === null, "DICTIONARY_DELETE_STATE", permanent ? "请先将字典移入已删除列表" : "字典已删除", 409);
      if (permanent) check(input.confirmationName === row.name, "CONFIRMATION_REQUIRED", "请输入完整字典名称以确认彻底删除", 409);
      const scan = new DictionaryReferenceScanner(this.store).scan(id);
      check(scan.complete, "REFERENCE_SCAN_INCOMPLETE", "引用扫描不完整，请修复不可读取的工作流或脚本后重试", 409);
      check(!scan.items.some(item => permanent || item.state !== "history"), "DICTIONARY_REFERENCED",
        permanent ? "仍有当前或历史工作流、脚本引用，无法彻底删除" : "仍有当前工作流、草稿或脚本引用，请先移除引用", 409);
      if (permanent) {
        check(!this.store.one("SELECT 1 FROM run_dictionary_bindings WHERE dictionary_id=? LIMIT 1", id)
          && !this.store.one("SELECT 1 FROM script_test_dictionary_bindings WHERE dictionary_id=? LIMIT 1", id),
          "DICTIONARY_BOUND", "仍有运行或测试记录绑定，无法彻底删除", 409);
        // 双向外键仅在本事务内延迟检查；不关闭外键或移除保护触发器。
        this.store.exec("PRAGMA defer_foreign_keys = ON");
        this.store.exec("DELETE FROM dictionary_versions WHERE dictionary_id=?", id);
        this.store.exec("DELETE FROM dictionaries WHERE id=?", id);
      } else {
        const now = Date.now();
        this.store.exec("UPDATE dictionaries SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?", now, now, id);
      }
      return { dictionaryId: id, permanent, deleted: true };
    }));
  }

  private requireActiveDictionary(id: string): DictionaryRow {
    const row = this.requireDictionary(id);
    check(row.deleted_at === null, "DICTIONARY_DELETED", "字典已删除，不能修改或新增引用", 409);
    return row;
  }

  // ---- 写入 ----

  create(input: { requestId: string; name: string; description: string; kind: DictionaryKind; enabled: boolean; operations: unknown }): DictionaryWriteResult {
    const name = validateDictionaryName(input.name);
    const description = validateDictionaryDescription(input.description);
    const kind = validateDictionaryKind(input.kind);
    check(typeof input.enabled === "boolean", "INVALID_DICTIONARY", "enabled 必须是布尔值", 422);
    const operations = validateOperations(input.operations, { allowRemove: false });
    const request = { name, description, kind, enabled: input.enabled, operations };
    return this.write(kind, "create", input.requestId, request, () => {
      check(!this.store.one("SELECT id FROM dictionaries WHERE name = ? COLLATE NOCASE", name), "INVALID_DICTIONARY", "同名字典已存在", 409);
      const dictionaryId = randomUUID(), versionId = randomUUID(), now = Date.now();
      const entries = this.buildEntries(kind, dictionaryId, {}, operations);
      const contentHash = portableContentHash({ name, description, enabled: input.enabled, kind, entries });
      this.store.exec("INSERT INTO dictionaries(id,name,kind,current_version_id,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?)", dictionaryId, name, kind, versionId, now, now);
      this.store.exec("INSERT INTO dictionary_versions(id,dictionary_id,version_no,name,description,kind,enabled,entries_json,content_hash,created_at) VALUES(?,?,1,?,?,?,?,?,?,?)", versionId, dictionaryId, name, description, kind, input.enabled ? 1 : 0, canonicalJson(entries), contentHash, now);
      return { dictionaryId, versionId, revision: 1, changed: true };
    });
  }

  update(id: string, input: { requestId: string; expectedRevision: number; name?: string; description?: string; enabled?: boolean; operations: unknown; confirmationToken?: string }): DictionaryWriteResult {
    const row = this.requireActiveDictionary(id);
    check(Number.isInteger(input.expectedRevision) && input.expectedRevision > 0, "INVALID_DICTIONARY", "expectedRevision 必须是正整数", 422);
    if (input.name !== undefined) validateDictionaryName(input.name);
    if (input.description !== undefined) validateDictionaryDescription(input.description);
    if (input.enabled !== undefined) check(typeof input.enabled === "boolean", "INVALID_DICTIONARY", "enabled 必须是布尔值", 422);
    if (input.confirmationToken !== undefined) check(typeof input.confirmationToken === "string" && input.confirmationToken.length >= 8, "INVALID_DICTIONARY", "确认令牌无效", 422);
    const operations = validateOperations(input.operations, { allowRemove: true });
    const request = { dictionaryId: id, expectedRevision: input.expectedRevision, name: input.name ?? null, description: input.description ?? null, enabled: input.enabled ?? null, operations };
    return this.write(row.kind, "update", input.requestId, request, () => this.applyUpdate(id, input, operations));
  }

  private applyUpdate(id: string, input: { requestId: string; expectedRevision: number; name?: string; description?: string; enabled?: boolean; operations: unknown; confirmationToken?: string }, operations: DictionaryOperation[]): DictionaryWriteResult {
    const row = this.requireActiveDictionary(id);
    check(row.revision === input.expectedRevision, "REVISION_CONFLICT", "字典已被并发修改，请刷新后重试", 409);
    const version = this.requireVersion(id, row.current_version_id);
    const entries = this.buildEntries(row.kind, id, parseEntries(row.kind, version.entries_json), operations);
    const name = input.name === undefined ? version.name : validateDictionaryName(input.name);
    const description = input.description === undefined ? version.description : validateDictionaryDescription(input.description);
    const enabled = input.enabled === undefined ? version.enabled === 1 : input.enabled;
    const contentHash = portableContentHash({ name, description, enabled, kind: row.kind, entries });
    // 完全相同的保存返回无变化，不产生修订（回执仍由命令层记录）。
    if (contentHash === version.content_hash) return { dictionaryId: id, versionId: version.id, revision: row.revision, changed: false };
    this.requireRemovalConfirmation(id, input, row.revision, operations);
    const versionId = randomUUID(), now = Date.now();
    const versionNo = Number(this.store.one("SELECT coalesce(max(version_no),0)+1 AS n FROM dictionary_versions WHERE dictionary_id=?", id)!.n);
    this.store.exec("INSERT INTO dictionary_versions(id,dictionary_id,version_no,name,description,kind,enabled,entries_json,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", versionId, id, versionNo, name, description, row.kind, enabled ? 1 : 0, canonicalJson(entries), contentHash, now);
    this.store.exec("UPDATE dictionaries SET name=?, current_version_id=?, revision=?, updated_at=? WHERE id=?", name, versionId, row.revision + 1, now, id);
    return { dictionaryId: id, versionId, revision: row.revision + 1, changed: true };
  }

  /** 应用显式操作数组；重复操作同一键拒绝，remove 不存在的键拒绝。 */
  private buildEntries(kind: DictionaryKind, dictionaryId: string, current: DictionaryEntries, operations: DictionaryOperation[]): DictionaryEntries {
    const entries: DictionaryEntries = { ...current };
    const seen = new Set<string>();
    const active = kind === "encrypted" && operations.some(operation => operation.op === "set") ? this.secrets.requireActiveKey() : null;
    for (const operation of operations) {
      check(!seen.has(operation.key), "INVALID_DICTIONARY", `键 ${operation.key} 重复操作`, 422);
      seen.add(operation.key);
      if (operation.op === "remove") {
        check(Object.hasOwn(entries, operation.key), "DICTIONARY_KEY_MISSING", `字典缺少键 ${operation.key}`, 422);
        delete entries[operation.key];
        continue;
      }
      if (kind === "encrypted") {
        check(operation.type === "string" && typeof operation.value === "string", "INVALID_DICTIONARY", "加密条目仅支持字符串值", 422);
        entries[operation.key] = { type: "string", encryptedValue: encryptValue(active!.material, { keyId: active!.keyId, dictionaryId, key: operation.key }, operation.value) };
        continue;
      }
      const validated = validateEntries("plain", { [operation.key]: { type: operation.type, value: operation.value } });
      entries[operation.key] = validated[operation.key]!;
    }
    return validateEntries(kind, entries);
  }

  /** 普通字典走 SHA-256 命令回执；加密字典走本机 HMAC 敏感命令回执；写入经协调器 withWrite 串行。 */
  private write(kind: DictionaryKind, action: "create" | "update", requestId: string, request: unknown, operation: () => DictionaryWriteResult): DictionaryWriteResult {
    return this.coordinator.withWrite(() => {
      if (kind === "plain") return this.store.command(`dictionaries:${action}`, requestId, request, operation);
      const requestHmac = this.secrets.sensitiveDigest(`dictionary-secret:${action}`, request);
      return this.store.sensitiveCommand(`dictionary-secret:${action}`, requestId, requestHmac, operation);
    });
  }

  /** 移除正在被引用的键需先确认影响；token 绑定原请求摘要、目标 revision 与引用摘要，10 分钟有效。 */
  private requireRemovalConfirmation(id: string, input: { confirmationToken?: string; expectedRevision: number; name?: string; description?: string; enabled?: boolean; operations: unknown }, targetRevision: number, operations: DictionaryOperation[]): void {
    const removedKeys = operations.filter(operation => operation.op === "remove").map(operation => operation.key);
    if (removedKeys.length === 0) return;
    const impacts = this.references.keyReferences(id, removedKeys).filter(impact => impact.workflows > 0 || impact.scripts > 0);
    const scan = this.references.scan?.(id);
    if (impacts.length === 0 && (!scan || scan.complete)) return;
    const business = { dictionaryId: id, expectedRevision: input.expectedRevision, name: input.name ?? null, description: input.description ?? null, enabled: input.enabled ?? null, operations: input.operations };
    const requestDigest = this.requireDictionary(id).kind === "encrypted"
      ? this.secrets.sensitiveDigest("dictionary-secret:update", business) : sha256(canonicalJson(business));
    const referencesDigest = sha256(canonicalJson({ impacts, scan: scan ?? null }));
    if (input.confirmationToken !== undefined) {
      const entry = this.confirmations.get(input.confirmationToken);
      check(entry && entry.dictionaryId === id && entry.requestDigest === requestDigest && entry.targetRevision === targetRevision && entry.referencesDigest === referencesDigest && entry.expiresAt > Date.now(), "PREVIEW_EXPIRED", "确认令牌无效或已过期，请重新确认影响", 409);
      this.confirmations.delete(input.confirmationToken);
      return;
    }
    const token = randomUUID().replaceAll("-", "");
    const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
    this.confirmations.set(token, { dictionaryId: id, requestDigest, targetRevision, referencesDigest, expiresAt });
    const error = new AppError("CONFIRMATION_REQUIRED", "移除正在被引用的键需要确认影响", 409);
    (error as AppError & { details?: unknown }).details = { impacts, complete: scan?.complete ?? true, issues: scan?.issues ?? [], confirmationToken: token, expiresAt };
    throw error;
  }

  // ---- 换钥（§6.4）----

  reEncryptionPreview(id: string, input: { expectedRevision: number }): ReEncryptionPreviewView {
    // 只读预览：不进入 withWrite，避免自身递增配置代次导致 token 自失效；
    // token 绑定读取时的基线，预览后任何配置写入或密钥变化都会使执行侧校验失败。
    const row = this.requireActiveDictionary(id);
    check(row.kind === "encrypted", "DICTIONARY_KIND_MISMATCH", "仅加密字典支持重新加密", 422);
    check(row.revision === input.expectedRevision, "REVISION_CONFLICT", "字典已被并发修改，请刷新后重试", 409);
    const version = this.requireVersion(id, row.current_version_id);
    const active = this.secrets.requireActiveKey();
    const entries = parseEntries(row.kind, version.entries_json);
    const materials = this.secrets.keyMaterials();
    let willReEncrypt = 0, alreadyMatched = 0;
    for (const [key, entry] of Object.entries(entries)) {
      const envelope = (entry as EncryptedEntryView).encryptedValue;
      const material = materials.get(envelope.keyId);
      check(material, "SECRET_KEY_MISSING", `缺少解密密钥 ${envelope.keyId}`, 422);
      // 预览阶段只认证解密，不返回或保存明文。
      decryptValue(material!, { keyId: envelope.keyId, dictionaryId: id, key }, envelope);
      if (envelope.keyId === active.keyId) alreadyMatched += 1; else willReEncrypt += 1;
    }
    const token = randomUUID().replaceAll("-", "");
    const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
    this.reEncryptPreviews.set(token, {
      dictionaryId: id, expectedRevision: input.expectedRevision, currentVersionId: version.id, contentHash: version.content_hash,
      targetKeyId: active.keyId, configGeneration: this.coordinator.generation, keyGeneration: this.secrets.keyring.load()!.generation,
      keyFingerprint: this.secrets.keyring.fingerprint(), expiresAt,
    });
    return { token, expiresAt, targetKeyId: active.keyId, entriesTotal: Object.keys(entries).length, willReEncrypt, alreadyMatched };
  }

  reEncrypt(id: string, input: { requestId: string; token: string; expectedRevision: number }): DictionaryWriteResult & { reEncrypted: number; reused: number } {
    return this.coordinator.withWrite(() => {
      const requestHmac = this.secrets.sensitiveDigest("dictionary-secret:re-encrypt", { dictionaryId: id, expectedRevision: input.expectedRevision, token: input.token });
      return this.store.sensitiveCommand("dictionary-secret:re-encrypt", input.requestId, requestHmac, () => {
        const row = this.requireActiveDictionary(id);
        check(row.kind === "encrypted", "DICTIONARY_KIND_MISMATCH", "仅加密字典支持重新加密", 422);
        check(row.revision === input.expectedRevision, "REVISION_CONFLICT", "字典已被并发修改，请刷新后重试", 409);
        const version = this.requireVersion(id, row.current_version_id);
        const active = this.secrets.requireActiveKey();
        const preview = this.reEncryptPreviews.get(input.token);
        const keyring = this.secrets.keyring.load()!;
        check(preview && preview.dictionaryId === id && preview.expectedRevision === input.expectedRevision
          && preview.currentVersionId === version.id && preview.contentHash === version.content_hash
          && preview.targetKeyId === active.keyId && preview.configGeneration === this.coordinator.generation
          && preview.keyGeneration === keyring.generation && preview.keyFingerprint === this.secrets.keyring.fingerprint()
          && preview.expiresAt > Date.now(), "PREVIEW_EXPIRED", "重新加密预览已过期或基线已变化，请重新预览", 409);
        this.reEncryptPreviews.delete(input.token);
        const entries = parseEntries(row.kind, version.entries_json);
        const materials = this.secrets.keyMaterials();
        const nextEntries: DictionaryEntries = {};
        let reEncrypted = 0, reused = 0;
        for (const [key, entry] of Object.entries(entries)) {
          const envelope = (entry as EncryptedEntryView).encryptedValue;
          if (envelope.keyId === active.keyId) { nextEntries[key] = entry; reused += 1; continue; }
          const material = materials.get(envelope.keyId);
          check(material, "SECRET_KEY_MISSING", `缺少解密密钥 ${envelope.keyId}`, 422);
          const plaintext = decryptValue(material!, { keyId: envelope.keyId, dictionaryId: id, key }, envelope);
          nextEntries[key] = { type: "string", encryptedValue: encryptValue(active.material, { keyId: active.keyId, dictionaryId: id, key }, plaintext) };
          reEncrypted += 1;
        }
        // 全部已匹配时返回无变化，不产生新修订。
        if (reEncrypted === 0) return { dictionaryId: id, versionId: version.id, revision: row.revision, changed: false, reEncrypted: 0, reused };
        const contentHash = portableContentHash({ name: version.name, description: version.description, enabled: version.enabled === 1, kind: row.kind, entries: nextEntries });
        const versionId = randomUUID(), now = Date.now();
        const versionNo = Number(this.store.one("SELECT coalesce(max(version_no),0)+1 AS n FROM dictionary_versions WHERE dictionary_id=?", id)!.n);
        this.store.exec("INSERT INTO dictionary_versions(id,dictionary_id,version_no,name,description,kind,enabled,entries_json,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", versionId, id, versionNo, version.name, version.description, row.kind, version.enabled, canonicalJson(nextEntries), contentHash, now);
        this.store.exec("UPDATE dictionaries SET current_version_id=?, revision=?, updated_at=? WHERE id=?", versionId, row.revision + 1, now, id);
        return { dictionaryId: id, versionId, revision: row.revision + 1, changed: true, reEncrypted, reused };
      });
    });
  }

  // ---- 读取与视图 ----

  list(input: { deleted?: boolean; kind?: DictionaryKind; enabled?: boolean; readiness?: DictionaryReadiness; limit?: number; cursor?: string } = {}): { items: DictionaryListView[]; nextCursor: string | null } {
    const limit = input.limit === undefined ? PAGE_DEFAULT_LIMIT : input.limit;
    check(Number.isInteger(limit) && limit >= 1 && limit <= PAGE_MAX_LIMIT, "INVALID_DICTIONARY", "limit 必须在 1 到 100 之间", 422);
    let cursor: { updatedAt: number; id: string } | null = null;
    if (input.cursor !== undefined && input.cursor !== "") {
      const decoded = decodeCursor(input.cursor);
      check(Number.isSafeInteger(decoded.updatedAt) && typeof decoded.id === "string", "INVALID_CURSOR", "分页游标无效", 400);
      cursor = { updatedAt: decoded.updatedAt as number, id: decoded.id };
    }
    const conditions: string[] = [input.deleted ? "d.deleted_at IS NOT NULL" : "d.deleted_at IS NULL"];
    const params: (string | number)[] = [];
    if (input.kind !== undefined) { conditions.push("d.kind = ?"); params.push(validateDictionaryKind(input.kind)); }
    if (input.enabled !== undefined) { conditions.push("v.enabled = ?"); params.push(input.enabled ? 1 : 0); }
    const rows = this.store.all<DictionaryRow>(
      `SELECT d.* FROM dictionaries d JOIN dictionary_versions v ON v.dictionary_id = d.id AND v.id = d.current_version_id
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY d.updated_at, d.id`,
      ...params,
    );
    const items: DictionaryListView[] = [];
    let nextCursor: string | null = null;
    let collecting = cursor === null;
    for (const row of rows) {
      const view = this.listView(row);
      if (input.readiness !== undefined && view.readiness !== input.readiness) continue;
      if (!collecting) {
        if (view.updatedAt > cursor!.updatedAt || (view.updatedAt === cursor!.updatedAt && view.id > cursor!.id)) collecting = true;
        else continue;
      }
      if (items.length === limit) { const last = items.at(-1)!; nextCursor = Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id }), "utf8").toString("base64"); break; }
      items.push(view);
    }
    return { items, nextCursor };
  }

  get(id: string): DictionaryDetailView | null {
    const row = this.store.one<DictionaryRow>("SELECT * FROM dictionaries WHERE id=?", id);
    return row ? this.detailView(row) : null;
  }

  versions(id: string, input: { limit?: number; cursor?: string } = {}): { items: DictionaryVersionSummary[]; nextCursor: string | null } {
    this.requireDictionary(id);
    const limit = input.limit === undefined ? PAGE_DEFAULT_LIMIT : input.limit;
    check(Number.isInteger(limit) && limit >= 1 && limit <= PAGE_MAX_LIMIT, "INVALID_DICTIONARY", "limit 必须在 1 到 100 之间", 422);
    let afterVersionNo = Number.MAX_SAFE_INTEGER;
    if (input.cursor !== undefined && input.cursor !== "") {
      const decoded = decodeCursor(input.cursor);
      check(typeof decoded.versionNo === "number" && Number.isSafeInteger(decoded.versionNo) && decoded.versionNo > 0, "INVALID_CURSOR", "分页游标无效", 400);
      afterVersionNo = decoded.versionNo;
    }
    const rows = this.store.all<VersionRow>(
      "SELECT * FROM dictionary_versions WHERE dictionary_id=? AND version_no<? ORDER BY version_no DESC LIMIT ?",
      id, afterVersionNo, limit + 1,
    );
    const page = rows.slice(0, limit);
    const items = page.map(row => ({ id: row.id, versionNo: row.version_no, name: row.name, description: row.description, enabled: row.enabled === 1, createdAt: row.created_at }));
    return { items, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ versionNo: page.at(-1)!.version_no }), "utf8").toString("base64") : null };
  }

  version(id: string, versionId: string): DictionaryVersionDetail | null {
    this.requireDictionary(id);
    const row = this.store.one<VersionRow>("SELECT * FROM dictionary_versions WHERE dictionary_id=? AND id=?", id, versionId);
    if (!row) return null;
    const entries = parseEntries(row.kind, row.entries_json);
    return {
      id: row.id, dictionaryId: row.dictionary_id, versionNo: row.version_no, name: row.name, description: row.description,
      enabled: row.enabled === 1, kind: row.kind, createdAt: row.created_at, keys: this.entryKeys(row.kind, entries),
    };
  }

  private listView(row: DictionaryRow): DictionaryListView {
    const version = this.requireVersion(row.id, row.current_version_id);
    const entries = parseEntries(row.kind, version.entries_json);
    const availability = row.kind === "encrypted"
      ? this.secrets.dictionaryAvailability(row.id, entries) : { readiness: "ready" as const, missingKeyIds: [] };
    return {
      id: row.id, name: row.name, description: version.description, kind: row.kind, enabled: version.enabled === 1,
      revision: row.revision, currentVersionId: version.id, createdAt: row.created_at, updatedAt: row.updated_at,
      keyCount: Object.keys(entries).length, deletedAt: row.deleted_at, ...availability,
    };
  }

  private detailView(row: DictionaryRow): DictionaryDetailView {
    const version = this.requireVersion(row.id, row.current_version_id);
    const entries = parseEntries(row.kind, version.entries_json);
    return { ...this.listView(row), versionNo: version.version_no, keys: this.entryKeys(row.kind, entries) };
  }

  /** 普通条目返回值；加密条目仅返回键名、类型与封装 keyId，不返回密文或明文。 */
  private entryKeys(kind: DictionaryKind, entries: DictionaryEntries): DictionaryDetailView["keys"] {
    const keys: DictionaryDetailView["keys"] = {};
    for (const key of Object.keys(entries).sort()) {
      const entry: DictionaryEntry = entries[key]!;
      if (kind === "encrypted") keys[key] = { type: "string", set: true, keyId: (entry as EncryptedEntryView).encryptedValue.keyId };
      else keys[key] = { type: (entry as { type: PlainEntryType }).type, value: (entry as { value: unknown }).value };
    }
    return keys;
  }

  private requireDictionary(id: string): DictionaryRow {
    const row = this.store.one<DictionaryRow>("SELECT * FROM dictionaries WHERE id=?", id);
    check(row, "DICTIONARY_NOT_FOUND", "字典不存在", 404);
    return row!;
  }

  private requireVersion(dictionaryId: string, versionId: string): VersionRow {
    const row = this.store.one<VersionRow>("SELECT * FROM dictionary_versions WHERE dictionary_id=? AND id=?", dictionaryId, versionId);
    check(row, "DICTIONARY_VERSION_CONFLICT", "字典当前版本缺失或归属不一致", 422);
    return row!;
  }
}

type EncryptedEntryView = { type: "string"; encryptedValue: EncryptedValue };
