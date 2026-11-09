import { randomUUID } from "node:crypto";
import { configCoordinator } from "../config-git/coordinator.js";
import { AppError, check } from "../domain/errors.js";
import { decryptValue, generateKeyMaterial } from "./aead.js";
import { parseKeyringBackup, serializeKeyringBackup, mergeKeyringBackups, decodeBackupKeyMaterial, MAX_KEYRING_KEYS, type KeyringBackup } from "./backup.js";
import { sensitiveRequestDigest, type CommandHmac } from "./command-hmac.js";
import { validateKeyId } from "./keys.js";
import type { KeyringFile, KeyringStore } from "./keyring.js";
import type { Store } from "../persistence/store.js";
import type { DictionaryEntries, EncryptedEntry } from "../dictionaries/model.js";

/**
 * 密钥设置服务（设计 §6.3）：状态查询、生成、导入、备份、验证与切换活动密钥。
 * 生成、导入和切换要求 expectedGeneration 与 requestId；并发变更返回冲突；
 * 同 requestId 重试先核对原请求摘要并返回原操作元数据，不先因代次变化而拒绝。
 * 常规查询、生成成功响应及切换密钥响应均只返回安全元数据；密钥材料仅出现在
 * 用户主动发起的专用备份下载中。密钥环写入经同一协调器 withWrite 串行执行。
 */

export interface SecretsStatusView {
  configured: boolean;
  generation: number;
  activeKeyId: string | null;
  readOnly: boolean;
  keys: { keyId: string; createdAt: number; active: boolean }[];
  encryptedDictionaries: number;
  missingKeyIds: string[];
}

export type DictionaryReadiness = "ready" | "missing-key" | "authentication-failed" | "keyring-unavailable";
export interface DictionaryAvailability {
  readiness: DictionaryReadiness;
  missingKeyIds: string[];
}

export interface VerificationEntry {
  dictionaryId: string;
  versionId: string;
  entries: number;
  verified: number;
  missingKeyIds: string[];
  failedKeys: string[];
}

export interface VerificationView {
  generation: number;
  keyFingerprint: string | null;
  dictionaries: VerificationEntry[];
  verified: boolean;
  message: string;
}

interface EnvelopeRow {
  dictionary_id: string;
  version_id: string;
  name: string;
  entries_json: string;
  content_hash: string;
}

/** 当前指针所在加密字典版本与其条目封装；供状态与验证扫描。 */
function encryptedEnvelopeRows(store: Store): EnvelopeRow[] {
  return store.all<EnvelopeRow>(
    `SELECT v.dictionary_id, v.id AS version_id, v.name, v.entries_json, v.content_hash
     FROM dictionary_versions v JOIN dictionaries d ON d.id = v.dictionary_id
     WHERE d.kind = 'encrypted' AND d.current_version_id = v.id ORDER BY v.dictionary_id`,
  );
}

export class SecretsService {
  readonly coordinator: ReturnType<typeof configCoordinator>;

  constructor(readonly store: Store, readonly keyring: KeyringStore, readonly hmac: CommandHmac) {
    this.coordinator = configCoordinator(store);
  }

  /** 当前活动密钥材料与 keyId；无活动密钥时拒绝。 */
  requireActiveKey(): { keyId: string; material: Buffer } {
    const ring = this.keyring.load();
    const key = ring?.keys.find(candidate => candidate.keyId === ring.activeKeyId);
    check(key, "SECRET_KEY_MISSING", "尚未配置活动密钥，无法写入加密值", 422);
    return { keyId: key.keyId, material: Buffer.from(key.material, "base64") };
  }

  /** 某组加密封装引用的 keyId 中，密钥环缺失的部分。 */
  missingKeyIds(entriesText: string): string[] {
    const keyring = this.keyring.load();
    const entries = JSON.parse(entriesText) as Record<string, { encryptedValue?: { keyId?: string } }>;
    const used = new Set<string>();
    for (const entry of Object.values(entries)) {
      const keyId = entry.encryptedValue?.keyId;
      if (typeof keyId === "string") used.add(keyId);
    }
    return [...used].filter(keyId => !keyring?.keys.some(key => key.keyId === keyId)).sort();
  }

  /** 每次查询只加载一份完整密钥快照；字典视图仅返回安全状态，不返回解密结果或原始错误。 */
  dictionaryAvailability(dictionaryId: string, entries: DictionaryEntries): DictionaryAvailability {
    let materials: Map<string, Buffer>;
    try { materials = this.keyMaterials(); }
    catch { return { readiness: "keyring-unavailable", missingKeyIds: [] }; }
    const missingKeyIds = new Set<string>();
    let authenticationFailed = false;
    for (const [key, entry] of Object.entries(entries)) {
      const envelope = (entry as EncryptedEntry).encryptedValue;
      const material = materials.get(envelope.keyId);
      if (!material) { missingKeyIds.add(envelope.keyId); continue; }
      try { decryptValue(material, { keyId: envelope.keyId, dictionaryId, key }, envelope); }
      catch { authenticationFailed = true; }
    }
    return {
      readiness: authenticationFailed ? "authentication-failed" : missingKeyIds.size > 0 ? "missing-key" : "ready",
      missingKeyIds: [...missingKeyIds].sort(),
    };
  }

  encryptedDictionaryCount(): number {
    return Number(this.store.one("SELECT count(*) AS n FROM dictionaries WHERE kind='encrypted'")!.n);
  }

  status(): SecretsStatusView {
    const view = this.keyring.status();
    const rows = encryptedEnvelopeRows(this.store);
    const missing = new Set<string>();
    for (const row of rows) for (const keyId of this.missingKeyIds(row.entries_json)) missing.add(keyId);
    return { ...view, encryptedDictionaries: rows.length, missingKeyIds: [...missing].sort() };
  }

  /** 敏感写公共入口：withWrite 内先确保本机 HMAC 密钥，再以 HMAC 摘要走敏感命令或密钥环写入。 */
  sensitiveDigest(scope: string, request: unknown): string {
    return sensitiveRequestDigest(this.hmac.ensure(), scope, request);
  }

  generate(input: { requestId: string; expectedGeneration: number; makeActive?: boolean }): { keyId: string; generation: number } {
    return this.coordinator.withWrite(() => {
      const request = { makeActive: input.makeActive === true };
      const requestHmac = this.sensitiveDigest("secrets:generate", request);
      return this.keyring.write("secrets:generate", input.requestId, requestHmac, input.expectedGeneration, keyring => {
        const keyId = randomUUID();
        const createdAt = Date.now();
        const activeKeyId = keyring.keys.length === 0 ? keyId : input.makeActive === true ? keyId : keyring.activeKeyId;
        keyring.keys.push({ keyId, algorithm: "aes-256-gcm", material: generateKeyMaterial().toString("base64"), createdAt });
        check(keyring.keys.length <= MAX_KEYRING_KEYS, "SECRET_KEYRING_FORMAT_INVALID", "密钥数量超过上限");
        if (activeKeyId !== undefined) keyring.activeKeyId = activeKeyId;
        return { result: { keyId, generation: keyring.generation + 1 }, changed: true };
      });
    });
  }

  import(input: { requestId: string; expectedGeneration: number; backupText: string; activeKeyId?: string }): { generation: number; added: number; unchanged: number } {
    const backup: KeyringBackup = parseKeyringBackup(input.backupText);
    if (input.activeKeyId !== undefined) validateKeyId(input.activeKeyId);
    return this.coordinator.withWrite(() => {
      const requestHmac = this.sensitiveDigest("secrets:import", { activeKeyId: input.activeKeyId ?? null, backup });
      return this.keyring.write("secrets:import", input.requestId, requestHmac, input.expectedGeneration, keyring => {
        const merged = mergeKeyringBackups(keyring.keys, backup.keys);
        check(merged.keys.length <= MAX_KEYRING_KEYS, "SECRET_KEYRING_FORMAT_INVALID", "合并后密钥数量超过上限");
        let activeKeyId = keyring.activeKeyId;
        if (input.activeKeyId !== undefined) {
          check(merged.keys.some(key => key.keyId === input.activeKeyId), "SECRET_KEY_MISSING", "指定的活动密钥不在导入结果中", 422);
          activeKeyId = input.activeKeyId;
        } else if (keyring.keys.length === 0) {
          throw new AppError("SECRET_ACTIVE_KEY_REQUIRED", "空密钥环导入必须明确指定活动密钥", 422);
        }
        const changed = merged.addedKeyIds.length > 0 || (activeKeyId !== undefined && activeKeyId !== keyring.activeKeyId);
        const now = Date.now();
        // 备份格式不含 createdAt：已有密钥保留原值，新导入密钥记为本次导入时间。
        keyring.keys = merged.keys.map(key => keyring.keys.find(candidate => candidate.keyId === key.keyId) ?? { ...key, createdAt: now });
        if (activeKeyId !== undefined) keyring.activeKeyId = activeKeyId;
        return { result: { generation: keyring.generation + (changed ? 1 : 0), added: merged.addedKeyIds.length, unchanged: merged.unchangedKeyIds.length }, changed };
      });
    });
  }

  /** 用户主动发起的专用备份下载；密钥材料只经此路径返回，不进入回执或日志。 */
  exportBackup(input: { expectedGeneration: number; keyIds?: string[] }): { filename: string; body: string } {
    const keyring = this.requireConfigured(input.expectedGeneration);
    const selected = input.keyIds === undefined ? keyring.keys : input.keyIds.map(keyId => {
      const key = keyring.keys.find(candidate => candidate.keyId === keyId);
      check(key, "SECRET_KEY_MISSING", "备份范围内包含未知 keyId", 422);
      return key;
    });
    check(selected.length > 0, "SECRET_KEY_MISSING", "备份范围不能为空", 422);
    const activeKeyId = keyring.activeKeyId;
    const backup: KeyringBackup = {
      formatVersion: 1,
      keys: selected.map(key => ({ keyId: key.keyId, algorithm: key.algorithm, material: key.material })),
      ...(activeKeyId !== undefined && selected.some(key => key.keyId === activeKeyId) ? { activeKeyId } : {}),
    };
    return { filename: `orchard-dictionary-keys-${new Date().toISOString().slice(0, 10)}.json`, body: serializeKeyringBackup(backup) };
  }

  activate(input: { requestId: string; expectedGeneration: number; keyId: string }): { generation: number; activeKeyId: string } {
    validateKeyId(input.keyId);
    return this.coordinator.withWrite(() => {
      const requestHmac = this.sensitiveDigest("secrets:activate", { keyId: input.keyId });
      return this.keyring.write("secrets:activate", input.requestId, requestHmac, input.expectedGeneration, keyring => {
        check(keyring.keys.some(key => key.keyId === input.keyId), "SECRET_KEY_MISSING", "要启用的密钥不存在", 404);
        const changed = keyring.activeKeyId !== input.keyId;
        keyring.activeKeyId = input.keyId;
        return { result: { generation: keyring.generation + (changed ? 1 : 0), activeKeyId: input.keyId }, changed };
      });
    });
  }

  /**
   * 对指定范围当前加密字典逐条认证解密；只返回成功数量、缺失 keyId 与失败位置。
   * 结果绑定密钥代次与字典摘要，验证期间变更则结果过期（PREVIEW_EXPIRED）。
   */
  verify(input: { expectedGeneration: number; dictionaryIds?: string[] }): VerificationView {
    const keyring = this.requireConfigured(input.expectedGeneration);
    const rows = encryptedEnvelopeRows(this.store).filter(row => input.dictionaryIds === undefined || input.dictionaryIds.includes(row.dictionary_id));
    const startHashes = new Map(rows.map(row => [row.dictionary_id, row.content_hash] as const));
    const startFingerprint = this.keyring.fingerprint();
    const dictionaries = rows.map(row => {
      const entries = JSON.parse(row.entries_json) as Record<string, { encryptedValue?: { keyId?: string; nonce?: string; ciphertext?: string; tag?: string; algorithm?: string; formatVersion?: number } }>;
      const missingKeyIds = new Set<string>();
      const failedKeys: string[] = [];
      const keys = Object.keys(entries).sort();
      let verified = 0;
      for (const key of keys) {
        const envelope = entries[key]!.encryptedValue;
        if (!envelope?.keyId) { failedKeys.push(key); continue; }
        if (!keyring.keys.some(candidate => candidate.keyId === envelope.keyId)) { missingKeyIds.add(envelope.keyId); continue; }
        try {
          decryptValue(Buffer.from(keyring.keys.find(candidate => candidate.keyId === envelope.keyId)!.material, "base64"), { keyId: envelope.keyId, dictionaryId: row.dictionary_id, key }, envelope);
          verified += 1;
        } catch {
          failedKeys.push(key);
        }
      }
      return { dictionaryId: row.dictionary_id, versionId: row.version_id, entries: keys.length, verified, missingKeyIds: [...missingKeyIds].sort(), failedKeys: [...failedKeys].sort() };
    });
    // 验证期间字典内容或密钥环变化则结果过期。
    const afterRows = encryptedEnvelopeRows(this.store).filter(row => input.dictionaryIds === undefined || input.dictionaryIds.includes(row.dictionary_id));
    const unchanged = afterRows.length === rows.length && afterRows.every(row => startHashes.get(row.dictionary_id) === row.content_hash);
    check(unchanged && this.keyring.fingerprint() === startFingerprint, "PREVIEW_EXPIRED", "验证期间字典或密钥已变化，结果过期", 409);
    const totalEntries = dictionaries.reduce((sum, entry) => sum + entry.entries, 0);
    return {
      generation: keyring.generation,
      keyFingerprint: startFingerprint,
      dictionaries,
      verified: totalEntries > 0 && dictionaries.every(entry => entry.missingKeyIds.length === 0 && entry.failedKeys.length === 0),
      message: totalEntries === 0 ? "密钥格式有效，尚未验证解密" : "验证完成",
    };
  }

  /** 备份/验证等只读操作要求密钥环已配置且代次匹配。 */
  private requireConfigured(expectedGeneration: number): KeyringFile {
    const keyring = this.keyring.load();
    check(keyring, "SECRET_KEY_MISSING", "尚未配置密钥环", 422);
    check(keyring!.generation === expectedGeneration, "SECRET_KEYRING_GENERATION_CONFLICT", "密钥环代次已变化，请刷新后重试", 409);
    return keyring!;
  }

  /** 供字典服务读取合并后的密钥材料。 */
  keyMaterials(): Map<string, Buffer> {
    const materials = new Map<string, Buffer>();
    const keyring = this.keyring.load();
    if (keyring) for (const key of keyring.keys) materials.set(key.keyId, decodeBackupKeyMaterial(key));
    return materials;
  }
}
