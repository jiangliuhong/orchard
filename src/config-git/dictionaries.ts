import { pointer } from "../domain/validation.js";
import { check } from "../domain/errors.js";
import { normalizeDictionaryBindings, type DictionaryRequirement } from "../domain/dictionaries.js";
import { portableContentHash, validateDictionaryName, validateDictionaryDescription, validateEntries } from "../dictionaries/model.js";
import { KeyringStore, resolveKeyringPath } from "../secrets/keyring.js";
import { decryptValue } from "../secrets/aead.js";
import type { Store } from "../persistence/store.js";
import type { PortableDictionary, PortableSnapshot, PortableScript, PortableWorkflow, SnapshotDependency } from "./snapshot-types.js";
import { object, array, string, bool, encodeSnapshotId, parseSnapshotJson } from "./snapshot-primitives.js";

type Row = Record<string, any>;
export function exportDictionaries(store: Store): PortableDictionary[] {
  return store.all<Row>("SELECT * FROM dictionaries ORDER BY id").map(d => {
    const v = store.one<Row>("SELECT * FROM dictionary_versions WHERE dictionary_id=? AND id=?", d.id, d.current_version_id)!;
    return { id: d.id, kind: d.kind, currentVersionId: v.id, versions: [{ id: v.id, dictionaryId: d.id, name: v.name, description: v.description, kind: v.kind, enabled: !!v.enabled, entries: JSON.parse(v.entries_json) }] };
  });
}
export function validateDictionaries(snapshot: PortableSnapshot) {
  array(snapshot.dictionaries); const names = new Set<string>();
  for (const d of snapshot.dictionaries!) {
    object(d, ["id", "kind", "currentVersionId", "versions"]); string(d.id); encodeSnapshotId(d.id); check(/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(d.id), "INVALID_ID", "字典 ID 必须为 UUID"); string(d.currentVersionId); array(d.versions);
    check(d.kind === "plain" || d.kind === "encrypted", "INVALID_DICTIONARY", "字典类型无效");
    for (const v of d.versions) {
      object(v, ["id", "dictionaryId", "name", "description", "enabled", "kind", "entries"]); string(v.id); encodeSnapshotId(v.id);
      check(v.dictionaryId === d.id && v.kind === d.kind, "IDENTITY_CONFLICT", "字典版本归属或类型冲突", 409);
      validateDictionaryName(v.name); validateDictionaryDescription(v.description); bool(v.enabled); validateEntries(v.kind, v.entries);
    }
    const current = d.versions.find(v => v.id === d.currentVersionId); check(current, "DEPENDENCY_MISSING", "字典当前版本缺失", 422);
    const name = current.name.toLowerCase(); check(!names.has(name), "IDENTITY_CONFLICT", "字典名称冲突", 409); names.add(name);
  }
}
export function requirements(snapshot: PortableSnapshot, obj: PortableScript | PortableWorkflow): DictionaryRequirement[] {
  const found = new Map<string, DictionaryRequirement>();
  const add = (d: DictionaryRequirement) => { const previous = found.get(d.dictionaryId); check(!previous || previous.kind === d.kind, "DICTIONARY_KIND_MISMATCH", "字典依赖类型冲突", 422); found.set(d.dictionaryId, { ...d, keys: [...new Set([...(previous?.keys ?? []), ...d.keys])].sort() }); };
  const declarations = (raw: unknown) => Object.values(normalizeDictionaryBindings(raw) ?? {}).forEach(add);
  const walk = (raw: any) => {
    if (!raw || typeof raw !== "object") return;
    if (raw.source === "dictionary") add({ dictionaryId: raw.dictionaryId, kind: "plain", keys: [raw.key] });
    if (raw.source === "array") raw.items.forEach(walk);
    if (raw.source === "object") Object.values(raw.properties).forEach(walk);
  };
  // Historical definitions remain immutable, but do not require removed keys to exist today.
  // A current workflow still resolves every exact script version it calls below.
  if ("runtime" in obj) for (const d of [...obj.versions.filter(v => v.id === obj.currentPublishedVersionId).map(v => v.definition), ...(obj.draft ? [obj.draft] : [])]) declarations(d.dictionaryBindings);
  else for (const source of [...obj.versions.filter(v => v.id === obj.currentPublishedVersionId), ...(obj.draft ? [obj.draft] : [])]) {
    const w = parseSnapshotJson(source.files["workflow.json"]!) as any; walk(w.result); (w.nodes ?? []).forEach((n: any) => walk(n.input));
    for (const n of w.nodes ?? []) {
      declarations(n.config?.dictionaryBindings);
      if (n.type === "script") {
        const d = snapshot.scripts.find(s => s.id === n.config?.scriptId)?.versions.find(v => v.id === n.config?.scriptVersionId)?.definition;
        check(d, "DEPENDENCY_MISSING", "缺少固定脚本版本", 422); declarations(d.dictionaryBindings);
      }
    }
  }
  return [...found.values()].sort((a,b) => a.dictionaryId.localeCompare(b.dictionaryId));
}
export function dictionaryDependencies(snapshot: PortableSnapshot, obj: PortableScript | PortableWorkflow): SnapshotDependency[] {
  if (snapshot.dictionaries === undefined) return [];
  return requirements(snapshot, obj).map(r => {
    const d = snapshot.dictionaries!.find(d => d.id === r.dictionaryId), v = d?.versions.find(v => v.id === d.currentVersionId);
    check(v && v.enabled, "DEPENDENCY_MISSING", "缺少启用的字典依赖", 422);
    check(v.kind === r.kind, "DICTIONARY_KIND_MISMATCH", "字典依赖类型不符", 422);
    check(r.keys.every(key => Object.hasOwn(v.entries, key)), "DICTIONARY_KEY_MISSING", "字典依赖键缺失", 422);
    return { category: "dictionaries", id: r.dictionaryId, kind: r.kind, keys: r.keys };
  });
}
export function authenticateDictionary(store: Store, d: PortableDictionary) {
  if (d.kind !== "encrypted") return;
  const keyring = new KeyringStore(resolveKeyringPath(store.files.root)).load();
  for (const v of d.versions) for (const [key, entry] of Object.entries(v.entries)) {
    check("encryptedValue" in entry, "INVALID_DICTIONARY", "加密条目无效");
    const envelope = entry.encryptedValue, material = keyring?.keys.find(k => k.keyId === envelope.keyId)?.material;
    check(material, "SECRET_KEY_MISSING", "恢复加密字典前须导入匹配的密钥", 422);
    decryptValue(Buffer.from(material, "base64"), { keyId: envelope.keyId, dictionaryId: d.id, key }, envelope);
  }
}
export function dictionaryFingerprint(store: Store) {
  const keyring = new KeyringStore(resolveKeyringPath(store.files.root));
  try { return keyring.fingerprint(); } catch { return "unavailable"; }
}
export function dictionaryChanged(store: Store, d: PortableDictionary) {
  const previous = store.one<Row>("SELECT * FROM dictionaries WHERE id=?", d.id);
  return !previous || previous.current_version_id !== d.currentVersionId || previous.name !== d.versions.find(v => v.id === d.currentVersionId)!.name || d.versions.some(v => !store.one("SELECT id FROM dictionary_versions WHERE id=?", v.id));
}
export function prepareDictionaries(store: Store, dictionaries: PortableDictionary[]) {
  for (const d of dictionaries) {
    const previous = store.one<Row>("SELECT * FROM dictionaries WHERE id=?", d.id);
    check(!previous || previous.kind === d.kind, "DICTIONARY_KIND_MISMATCH", "字典类型不可变", 409);
    check(!store.one("SELECT id FROM scripts WHERE id=?", d.id) && !store.one("SELECT id FROM workflows WHERE id=?", d.id) && !store.one("SELECT id FROM provider_settings WHERE id=?", d.id) && !store.one("SELECT id FROM agent_model_configs WHERE id=?", d.id), "IDENTITY_CONFLICT", "字典对象身份冲突", 409);
    const current = d.versions.find(v => v.id === d.currentVersionId)!;
    check(!store.one("SELECT id FROM dictionaries WHERE name=? COLLATE NOCASE AND id<>?", current.name, d.id), "IDENTITY_CONFLICT", "字典名称已存在", 409);
    for (const v of d.versions) {
      const old = store.one<Row>("SELECT * FROM dictionary_versions WHERE id=?", v.id);
      check(!store.one("SELECT id FROM script_versions WHERE id=?", v.id) && !store.one("SELECT id FROM workflow_versions WHERE id=?", v.id) && !store.one("SELECT id FROM drafts WHERE id=?", v.id), "VERSION_ID_CONFLICT", "版本身份冲突", 409);
      check(!old || old.dictionary_id === d.id && old.content_hash === portableContentHash(v), "VERSION_ID_CONFLICT", "不可变字典版本内容冲突", 409);
    }
    authenticateDictionary(store, d);
  }
}
export function importDictionaries(store: Store, dictionaries: PortableDictionary[]) {
  const now = Date.now();
  for (const d of dictionaries) {
    const changed = dictionaryChanged(store, d), current = d.versions.find(v => v.id === d.currentVersionId)!;
    const previous = store.one("SELECT id FROM dictionaries WHERE id=?", d.id);
    if (!previous) store.exec("INSERT INTO dictionaries(id,name,kind,current_version_id,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?)", d.id, current.name, d.kind, d.currentVersionId, now, now);
    for (const v of d.versions) if (!store.one("SELECT id FROM dictionary_versions WHERE id=?", v.id)) {
      const number = Number(store.one("SELECT COALESCE(MAX(version_no),0)+1 n FROM dictionary_versions WHERE dictionary_id=?", d.id)!.n);
      store.exec("INSERT INTO dictionary_versions(id,dictionary_id,version_no,name,description,kind,enabled,entries_json,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", v.id, d.id, number, v.name, v.description, v.kind, v.enabled ? 1 : 0, JSON.stringify(v.entries), portableContentHash(v), now);
    }
    if (previous && changed) store.exec("UPDATE dictionaries SET name=?,current_version_id=?,revision=revision+1,updated_at=? WHERE id=?", current.name, d.currentVersionId, now, d.id);
  }
}

export function validateDictionaryPointers(snapshot: PortableSnapshot, workflow: PortableWorkflow, dictionaries: PortableDictionary[]) {
  for (const source of [...workflow.versions.filter(v => v.id === workflow.currentPublishedVersionId), ...(workflow.draft ? [workflow.draft] : [])]) {
    const definition = parseSnapshotJson(source.files["workflow.json"]!) as any;
    const walk = (binding: any) => {
      if (!binding || typeof binding !== "object") return;
      if (binding.source === "dictionary") {
        const d = dictionaries.find(d => d.id === binding.dictionaryId), v = d?.versions.find(v => v.id === d.currentVersionId), entry = v?.entries[binding.key];
        check(entry && "value" in entry, "DEPENDENCY_MISSING", "普通字典绑定不可用", 422);
        try { pointer(entry.value, binding.pointer); } catch { check(false, "DICTIONARY_POINTER_INVALID", "字典绑定的 JSON Pointer 无效", 422); }
      }
      if (binding.source === "object") Object.values(binding.properties).forEach(walk);
      if (binding.source === "array") binding.items.forEach(walk);
    };
    (definition.nodes ?? []).forEach((n: any) => walk(n.input)); walk(definition.result);
  }
}
