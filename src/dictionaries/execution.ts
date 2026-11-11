import { AppError, check, failure } from "../domain/errors.js";
import { normalizeDictionaryBindings, type DictionaryBindings, type DictionaryDeclaration, type DictionaryRequirement } from "../domain/dictionaries.js";
import { assertSchema, resolveBinding, pointer, walkBindings } from "../domain/validation.js";
import type { Binding, Workflow } from "../domain/types.js";
import type { Store } from "../persistence/store.js";
import { KeyringStore, resolveKeyringPath } from "../secrets/keyring.js";
import { decryptValue } from "../secrets/aead.js";
import { parseStrictJson } from "./canonical.js";
import { portableContentHash, validateEntries, type DictionaryEntries, type DictionaryKind, type EncryptedEntry, type PlainEntry } from "./model.js";

export const REDACTED = Object.freeze({ orchardRedacted: true as const });
export function isRedacted(value: unknown): boolean { return !!value && typeof value === "object" && (value as { orchardRedacted?: unknown }).orchardRedacted === true; }
const safeMessages: Record<string, string> = {
  CANCELLED: "执行已取消", INTERRUPTED: "服务重启，敏感运行参数需要重新填写", TIMEOUT: "执行超过超时时间", OUTPUT_LIMIT: "执行输出超过限制",
  PROCESS_START_FAILED: "无法启动执行进程", PROCESS_FAILED: "执行进程失败", INVALID_SCRIPT_OUTPUT: "脚本输出格式无效",
  SCHEMA_MISMATCH: "敏感执行的数据不符合 Schema", EXECUTION_FAILED: "敏感执行失败，详细信息未保存",
  DICTIONARY_NOT_FOUND: "字典不存在", DICTIONARY_DISABLED: "字典已禁用", DICTIONARY_KIND_MISMATCH: "字典类型不符",
  DICTIONARY_KEY_MISSING: "字典缺少声明的键", DICTIONARY_ACCESS_DENIED: "字典访问被拒绝", SECRET_BINDING_FORBIDDEN: "加密字典不能用于输入绑定",
  SECRET_KEY_MISSING: "缺少解密密钥，请独立导入密钥", SECRET_DECRYPT_FAILED: "字典值认证失败",
  SECRET_KEYRING_FORMAT_INVALID: "密钥环不可用", SECRET_KEYRING_GENERATION_CONFLICT: "密钥环已变化，请重试",
  DICTIONARY_BINDING_INVALID: "字典运行绑定损坏或缺失", ARTIFACT_MISMATCH: "不可变执行定义损坏",
};
export function safeExecutionFailure(error: unknown, sensitive: boolean) {
  if (!sensitive) return failure(error);
  const code = error instanceof AppError && Object.hasOwn(safeMessages, error.code) ? error.code : "EXECUTION_FAILED";
  return { code, message: safeMessages[code]! };
}
interface VersionRow {
  dictionary_id: string; id: string; kind: DictionaryKind; enabled: number; name: string; description: string; entries_json: string; content_hash: string;
}
export interface FixedDictionary {
  dictionaryId: string; versionId: string; kind: DictionaryKind; name: string; keys: string[];
}
interface KeySnapshot { fingerprint: string | null; materials: Map<string, Buffer> }
export interface DictionaryContext {
  dictionaries: Record<string, Record<string, unknown>>;
  secrets: Record<string, Record<string, string>>;
}
export function scriptDictionaryRequirements(bindings: DictionaryBindings | undefined): DictionaryRequirement[] {
  const result = new Map<string, DictionaryRequirement>();
  for (const declaration of Object.values(normalizeDictionaryBindings(bindings) ?? {})) {
    const prior = result.get(declaration.dictionaryId);
    check(!prior || prior.kind === declaration.kind, "DICTIONARY_KIND_MISMATCH", "同一字典类型声明不一致", 422);
    result.set(declaration.dictionaryId, { ...declaration, keys: [...new Set([...(prior?.keys ?? []), ...declaration.keys])].sort() });
  }
  return [...result.values()].sort((a, b) => a.dictionaryId.localeCompare(b.dictionaryId));
}

/** A synchronous admission snapshot. Plaintext values are never returned in a DTO or saved as a reference. */
export class DictionaryExecution {
  constructor(readonly store: Store) {}
  get keyring() { return new KeyringStore(resolveKeyringPath(this.store.root)); }
  private keys(required: boolean): KeySnapshot {
    if (!required) return { fingerprint: null, materials: new Map() };
    const before = this.keyring.fingerprint(), ring = this.keyring.load();
    const after = this.keyring.fingerprint();
    check(before === after, "SECRET_KEYRING_GENERATION_CONFLICT", "密钥环读取期间变化", 409);
    return { fingerprint: after, materials: new Map((ring?.keys ?? []).map(k => [k.keyId, Buffer.from(k.material, "base64")])) };
  }
  private entries(row: VersionRow): DictionaryEntries {
    const entries = validateEntries(row.kind, parseStrictJson(row.entries_json));
    check(portableContentHash({ name: row.name, description: row.description, enabled: !!row.enabled, kind: row.kind, entries }) === row.content_hash,
      "DICTIONARY_BINDING_INVALID", "字典版本摘要不符", 422);
    return entries;
  }
  private values(row: VersionRow, keys: string[], materials: Map<string, Buffer>): Map<string, unknown> {
    const entries = this.entries(row), result = new Map<string, unknown>();
    for (const key of keys) {
      check(Object.hasOwn(entries, key), "DICTIONARY_KEY_MISSING", "字典缺少声明的键", 422);
      const entry = entries[key]!;
      if (row.kind === "plain") result.set(key, structuredClone((entry as PlainEntry).value));
      else {
        const envelope = (entry as EncryptedEntry).encryptedValue, material = materials.get(envelope.keyId);
        check(material, "SECRET_KEY_MISSING", "缺少解密密钥，请独立导入密钥", 422);
        result.set(key, decryptValue(material, { dictionaryId: row.dictionary_id, key, keyId: envelope.keyId }, envelope));
      }
    }
    return result;
  }
  /** Caller uses the coordinator admission/write window. All checks are synchronous. */
  validate(requirements: readonly DictionaryDeclaration[]): { bindings: FixedDictionary[]; fingerprint: string | null } {
    const keys = this.keys(requirements.some(r => r.kind === "encrypted")), bindings: FixedDictionary[] = [];
    for (const requirement of requirements) {
      const row = this.store.one<VersionRow>("SELECT v.* FROM dictionaries d JOIN dictionary_versions v ON v.dictionary_id=d.id AND v.id=d.current_version_id WHERE d.id=?", requirement.dictionaryId);
      check(row, "DICTIONARY_NOT_FOUND", "字典不存在", 422);
      check(row.kind === requirement.kind, "DICTIONARY_KIND_MISMATCH", "字典类型与声明不符", 422);
      check(row.enabled === 1, "DICTIONARY_DISABLED", "字典已禁用", 422);
      this.values(row, requirement.keys, keys.materials);
      bindings.push({ dictionaryId: row.dictionary_id, versionId: row.id, kind: row.kind, name: row.name, keys: [...requirement.keys] });
    }
    this.assertFingerprint(keys.fingerprint, requirements.some(r => r.kind === "encrypted"));
    return { bindings, fingerprint: keys.fingerprint };
  }
  assertFingerprint(fingerprint: string | null, required: boolean) {
    if (required) check(this.keyring.fingerprint() === fingerprint, "SECRET_KEYRING_GENERATION_CONFLICT", "密钥环已变化，请重试", 409);
  }
  save(owner: "run" | "test", id: string, bindings: readonly FixedDictionary[]) {
    const table = owner === "run" ? "run_dictionary_bindings" : "script_test_dictionary_bindings", column = owner === "run" ? "run_id" : "test_id";
    for (const binding of bindings) this.store.exec(`INSERT INTO ${table}(${column},dictionary_id,dictionary_version_id,keys_json,created_at) VALUES(?,?,?,?,?)`, id, binding.dictionaryId, binding.versionId, JSON.stringify(binding.keys), Date.now());
  }
  metadata(owner: "run" | "test", id: string): FixedDictionary[] {
    const table = owner === "run" ? "run_dictionary_bindings" : "script_test_dictionary_bindings", column = owner === "run" ? "run_id" : "test_id";
    return this.store.all<{ dictionary_id: string; dictionary_version_id: string; keys_json: string; kind: DictionaryKind; name: string }>(`SELECT b.*,v.kind,v.name FROM ${table} b JOIN dictionary_versions v ON v.dictionary_id=b.dictionary_id AND v.id=b.dictionary_version_id WHERE b.${column}=? ORDER BY b.dictionary_id`, id).map(row => ({ dictionaryId: row.dictionary_id, versionId: row.dictionary_version_id, kind: row.kind, name: row.name, keys: JSON.parse(row.keys_json) }));
  }
  load(owner: "run" | "test", id: string, requirements: readonly DictionaryDeclaration[]) {
    const bindings = this.metadata(owner, id), required = requirements.some(r => r.kind === "encrypted");
    check(bindings.length === requirements.length, "DICTIONARY_BINDING_INVALID", "字典运行绑定缺失或多余", 422);
    const keys = this.keys(required), values = new Map<string, Map<string, unknown>>();
    for (const requirement of requirements) {
      const binding = bindings.find(b => b.dictionaryId === requirement.dictionaryId);
      check(binding && binding.kind === requirement.kind && JSON.stringify([...binding.keys].sort()) === JSON.stringify([...requirement.keys].sort()), "DICTIONARY_BINDING_INVALID", "字典运行绑定不符合定义", 422);
      const row = this.store.one<VersionRow>("SELECT * FROM dictionary_versions WHERE dictionary_id=? AND id=?", binding.dictionaryId, binding.versionId);
      check(row && row.kind === requirement.kind, "DICTIONARY_BINDING_INVALID", "字典运行绑定版本无效", 422);
      // Historical bindings remain usable after disabling or editing the current dictionary.
      values.set(binding.dictionaryId, this.values(row, requirement.keys, keys.materials));
    }
    this.assertFingerprint(keys.fingerprint, required);
    const get = (dictionaryId: string, key: string, kind: DictionaryKind) => {
      check(bindings.some(b => b.dictionaryId === dictionaryId && b.kind === kind && b.keys.includes(key)) && values.get(dictionaryId)?.has(key), "DICTIONARY_ACCESS_DENIED", "字典访问超出声明范围", 422);
      return structuredClone(values.get(dictionaryId)!.get(key));
    };
    return {
      bindings,
      value: (dictionaryId: string, key: string) => { const binding = bindings.find(b => b.dictionaryId === dictionaryId); check(binding, "DICTIONARY_ACCESS_DENIED", "字典访问被拒绝", 422); return get(dictionaryId, key, binding.kind); },
      plain: (dictionaryId: string, key: string) => get(dictionaryId, key, "plain"),
      context: (declarations: DictionaryBindings | undefined): DictionaryContext => {
        const dictionaries: DictionaryContext["dictionaries"] = Object.create(null), secrets: DictionaryContext["secrets"] = Object.create(null);
        for (const [alias, declaration] of Object.entries(normalizeDictionaryBindings(declarations) ?? {})) {
          const entries = Object.fromEntries(declaration.keys.map(key => [key, get(declaration.dictionaryId, key, declaration.kind)]));
          if (declaration.kind === "plain") dictionaries[alias] = entries;
          else secrets[alias] = entries as Record<string, string>;
        }
        return { dictionaries, secrets };
      },
    };
  }
  /** Validate pointers without evaluating a node or upstream data. */
  validatePointers(workflow: Workflow, bindings: readonly FixedDictionary[], input?: unknown) {
    if (!bindings.length) return;
    const values = new Map<string, DictionaryEntries>();
    for (const binding of bindings.filter(b => b.kind === "plain")) {
      const row = this.store.one<VersionRow>("SELECT * FROM dictionary_versions WHERE dictionary_id=? AND id=?", binding.dictionaryId, binding.versionId)!;
      values.set(binding.dictionaryId, this.entries(row));
    }
    const inspect = (binding: Binding) => walkBindings(binding, b => {
      if (b.source === "dictionary") {
        const entry = values.get(b.dictionaryId)?.[b.key];
        check(entry && "value" in entry, "SECRET_BINDING_FORBIDDEN", "加密字典不能用于输入绑定", 422);
        pointer(entry.value, b.pointer);
      }
    });
    const get = (id: string, key: string) => (values.get(id)?.[key] as PlainEntry).value;
    for (const node of workflow.nodes) {
      inspect(node.input);
      let upstream = false;
      walkBindings(node.input, b => { if (b.source === "node") upstream = true; });
      if (!upstream) {
        const value = resolveBinding(node.input, input, new Map(), get);
        assertSchema(value, node.inputSchema ?? true, "节点输入");
        if (node.type === "script") assertSchema(value, this.store.scriptVersion(node.config.scriptVersionId!).inputSchema, "脚本输入");
      }
    }
    inspect(workflow.result);
  }
}
