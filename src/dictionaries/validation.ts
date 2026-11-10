import { check } from "../domain/errors.js";
import { normalizeDictionaryBindings, workflowDictionaryRequirements, workflowDictionarySensitivity, type DictionaryDeclaration } from "../domain/dictionaries.js";
import { pointer, walkBindings } from "../domain/validation.js";
import type { ScriptDefinition } from "../domain/scripts.js";
import type { Workflow } from "../domain/types.js";
import type { Store } from "../persistence/store.js";
import { validateEntries, type DictionaryKind } from "./model.js";

/** Static validation never decrypts, and never includes entry values in errors. */
export function validateDictionaryRequirements(store: Store, requirements: readonly DictionaryDeclaration[]) {
  for (const requirement of requirements) {
    const row = store.one<{ kind: DictionaryKind; enabled: number; entries_json: string }>("SELECT d.kind,v.enabled,v.entries_json FROM dictionaries d JOIN dictionary_versions v ON v.id=d.current_version_id AND v.dictionary_id=d.id WHERE d.id=?", requirement.dictionaryId);
    check(row, "DICTIONARY_NOT_FOUND", "依赖的字典不存在或当前修订不可用", 422);
    check(row!.kind === requirement.kind, requirement.kind === "plain" && row!.kind === "encrypted" ? "SECRET_BINDING_FORBIDDEN" : "DICTIONARY_KIND_MISMATCH", "字典类型与声明不一致", 422);
    check(row!.enabled === 1, "DICTIONARY_DISABLED", "依赖的字典已禁用", 422);
    const entries = validateEntries(row!.kind, JSON.parse(row!.entries_json));
    check(requirement.keys.every(key => Object.hasOwn(entries, key)), "DICTIONARY_KEY_MISSING", "依赖的字典键不存在", 422);
  }
}
export function validateScriptDictionaries(store: Store, definition: ScriptDefinition): void {
  validateDictionaryRequirements(store, Object.values(normalizeDictionaryBindings(definition.dictionaryBindings) ?? {}));
}
export function validateWorkflowDictionaries(store: Store, workflow: Workflow) {
  const resolve = (id: string, versionId: string) => {
    const version = store.scriptVersion(versionId);
    check(version.scriptId === id && version.status === "published", "SCRIPT_VERSION_INVALID", "脚本版本无效或未发布", 422);
    return store.scriptDefinition(id, versionId);
  };
  validateDictionaryRequirements(store, workflowDictionaryRequirements(workflow, resolve));
  const inspect = (binding: Workflow["result"]) => walkBindings(binding, b => {
    if (b.source !== "dictionary") return;
    const row = store.one<{ entries_json: string }>("SELECT v.entries_json FROM dictionaries d JOIN dictionary_versions v ON v.id=d.current_version_id AND v.dictionary_id=d.id WHERE d.id=?", b.dictionaryId)!;
    const entry = validateEntries("plain", JSON.parse(row.entries_json))[b.key]! as { value: unknown };
    try { pointer(entry.value, b.pointer); }
    catch { check(false, "DICTIONARY_POINTER_INVALID", "字典绑定的 JSON Pointer 不存在或无效", 422); }
  });
  workflow.nodes.forEach(n => inspect(n.input)); inspect(workflow.result);
  return workflowDictionarySensitivity(workflow, resolve);
}

/** Safe authoring metadata: no values, ciphertext, key IDs, or key material. */
export function dictionaryDependencyMetadata(store: Store) {
  return store.all<{ id: string; name: string; kind: DictionaryKind; enabled: number; entries_json: string }>("SELECT d.id,d.name,d.kind,v.enabled,v.entries_json FROM dictionaries d JOIN dictionary_versions v ON v.id=d.current_version_id AND v.dictionary_id=d.id ORDER BY d.name,d.id").map(row => {
    const entries = validateEntries(row.kind, JSON.parse(row.entries_json));
    return { id: row.id, name: row.name, kind: row.kind, enabled: row.enabled === 1, keys: Object.keys(entries).sort().map(key => ({ key, type: entries[key]!.type, set: true })) };
  });
}
