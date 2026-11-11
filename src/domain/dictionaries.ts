import { check } from "./errors.js";
import type { Binding, Workflow } from "./types.js";
import type { ScriptDefinition } from "./scripts.js";

export type DictionaryBindingKind = "plain" | "encrypted";
export interface DictionaryDeclaration {
  dictionaryId: string;
  kind: DictionaryBindingKind;
  keys: string[];
}
export type DictionaryBindings = Record<string, DictionaryDeclaration>;
export interface DictionaryRequirement extends DictionaryDeclaration {}
export type ScriptDefinitionResolver = (scriptId: string, versionId: string) => ScriptDefinition;

const KEY_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,99}$";
const UUID_PATTERN = "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$";
export const dictionaryIdSchema = { type: "string", pattern: UUID_PATTERN };
export const dictionaryKeySchema = { type: "string", pattern: KEY_PATTERN };
export const dictionaryBindingsSchema = {
  type: "object", maxProperties: 32, propertyNames: dictionaryKeySchema,
  additionalProperties: {
    type: "object", required: ["dictionaryId", "kind", "keys"], additionalProperties: false,
    properties: {
      dictionaryId: dictionaryIdSchema, kind: { enum: ["plain", "encrypted"] },
      keys: { type: "array", minItems: 1, maxItems: 256, uniqueItems: true, items: dictionaryKeySchema },
    },
  },
};

/** ASCII aliases/keys have identical lexical and UTF-8 ordering. Never mutate an immutable definition. */
export function normalizeDictionaryBindings(value: unknown): DictionaryBindings | undefined {
  if (value === undefined) return undefined;
  const plainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && [null, Object.prototype].includes(Object.getPrototypeOf(v));
  check(plainObject(value), "INVALID_DICTIONARY_BINDINGS", "字典依赖必须是对象");
  const names = Object.keys(value);
  check(names.length <= 32, "INVALID_DICTIONARY_BINDINGS", "字典依赖最多 32 个别名");
  let total = 0;
  const result: DictionaryBindings = {};
  for (const alias of names.sort()) {
    check(new RegExp(KEY_PATTERN).test(alias), "INVALID_DICTIONARY_BINDINGS", "字典别名无效");
    const descriptor = Object.getOwnPropertyDescriptor(value, alias)!;
    check("value" in descriptor, "INVALID_DICTIONARY_BINDINGS", "字典依赖不允许访问器");
    const declaration: unknown = descriptor.value;
    check(plainObject(declaration), "INVALID_DICTIONARY_BINDINGS", "字典声明必须是对象");
    const fields = Object.keys(declaration).sort();
    check(fields.join(",") === "dictionaryId,keys,kind" && fields.every(key => "value" in Object.getOwnPropertyDescriptor(declaration, key)!), "INVALID_DICTIONARY_BINDINGS", "字典声明字段无效");
    const { dictionaryId, kind, keys } = declaration;
    check(typeof dictionaryId === "string" && new RegExp(UUID_PATTERN).test(dictionaryId), "INVALID_DICTIONARY_BINDINGS", "字典 ID 无效");
    check(kind === "plain" || kind === "encrypted", "INVALID_DICTIONARY_BINDINGS", "字典类型无效");
    check(Array.isArray(keys) && keys.length > 0 && keys.length <= 256 && Object.keys(keys).length === keys.length, "INVALID_DICTIONARY_BINDINGS", "字典键集合无效");
    check(keys.every(key => typeof key === "string" && new RegExp(KEY_PATTERN).test(key)) && new Set(keys).size === keys.length, "INVALID_DICTIONARY_BINDINGS", "字典键无效或重复");
    total += keys.length;
    check(total <= 256, "INVALID_DICTIONARY_BINDINGS", "字典依赖合计最多 256 个键");
    // defineProperty also handles the otherwise special Object.prototype names safely.
    Object.defineProperty(result, alias, { value: { dictionaryId, kind, keys: [...keys].sort() }, enumerable: true, writable: true, configurable: true });
  }
  return names.length ? result : undefined;
}

function visitBindings(binding: Binding, visit: (binding: Binding) => void) {
  visit(binding);
  if (binding.source === "object") Object.values(binding.properties).forEach(child => visitBindings(child, visit));
  if (binding.source === "array") binding.items.forEach(child => visitBindings(child, visit));
}

/** Fixed script versions must be resolved explicitly, never via the current draft or published pointer. */
export function nodeDictionaryBindings(workflow: Workflow, resolveScript?: ScriptDefinitionResolver): Map<string, DictionaryBindings | undefined> {
  return new Map(workflow.nodes.map(node => {
    if (node.type !== "script") return [node.id, normalizeDictionaryBindings(node.config.dictionaryBindings)];
    check(resolveScript, "DEPENDENCY_MISSING", "需要解析固定脚本版本的字典依赖", 422);
    const definition = resolveScript(node.config.scriptId!, node.config.scriptVersionId!);
    check(definition.id === node.config.scriptId, "SCRIPT_VERSION_INVALID", "脚本定义身份与固定引用不符", 422);
    return [node.id, normalizeDictionaryBindings(definition.dictionaryBindings)];
  }));
}

export function workflowDictionaryRequirements(workflow: Workflow, resolveScript?: ScriptDefinitionResolver): DictionaryRequirement[] {
  const requirements = new Map<string, DictionaryRequirement>();
  const add = (declaration: DictionaryDeclaration) => {
    const previous = requirements.get(declaration.dictionaryId);
    check(!previous || previous.kind === declaration.kind, "DICTIONARY_KIND_MISMATCH", "同一字典存在不同类型的依赖声明", 422);
    requirements.set(declaration.dictionaryId, { dictionaryId: declaration.dictionaryId, kind: declaration.kind, keys: [...new Set([...(previous?.keys ?? []), ...declaration.keys])].sort() });
  };
  const collect = (binding: Binding) => visitBindings(binding, b => {
    if (b.source === "dictionary") add({ dictionaryId: b.dictionaryId, kind: "plain", keys: [b.key] });
  });
  workflow.nodes.forEach(node => collect(node.input));
  collect(workflow.result);
  for (const declarations of nodeDictionaryBindings(workflow, resolveScript).values()) for (const declaration of Object.values(declarations ?? {})) add(declaration);
  return [...requirements.values()].sort((a, b) => a.dictionaryId < b.dictionaryId ? -1 : a.dictionaryId > b.dictionaryId ? 1 : 0);
}

export interface DictionarySensitivity { nodes: Set<string>; output: boolean }
export function workflowDictionarySensitivity(workflow: Workflow, resolveScript?: ScriptDefinitionResolver): DictionarySensitivity {
  const nodes = new Set<string>();
  const queue: string[] = [];
  for (const [nodeId, declarations] of nodeDictionaryBindings(workflow, resolveScript)) {
    if (Object.values(declarations ?? {}).some(d => d.kind === "encrypted")) { nodes.add(nodeId); queue.push(nodeId); }
  }
  const successors = new Map<string, string[]>();
  for (const edge of workflow.edges) if (edge.to !== null) successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
  for (let at = 0; at < queue.length; at++) for (const next of successors.get(queue[at]!) ?? []) {
    if (!nodes.has(next)) { nodes.add(next); queue.push(next); }
  }
  for (const node of workflow.nodes) check(!nodes.has(node.id) || node.type !== "agent" && node.type !== "web-bridge", "SECRET_SINK_FORBIDDEN", `敏感执行范围不能包含 Agent 或 Web Bridge: ${node.id}`, 422);
  let output = false;
  visitBindings(workflow.result, binding => { if (binding.source === "node" && nodes.has(binding.nodeId)) output = true; });
  return { nodes, output };
}

/** Git v1 cannot represent dictionary dependencies, including those in incomplete drafts. */
export function assertLegacyWorkflowDictionaries(value: unknown) {
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!object(value)) return;
  const inspect = (binding: unknown) => {
    if (!object(binding)) return;
    check(binding.source !== "dictionary", "FORMAT_UNSUPPORTED", "字典绑定需要 Git 快照 v2", 422);
    if (binding.source === "object" && object(binding.properties)) Object.values(binding.properties).forEach(inspect);
    if (binding.source === "array" && Array.isArray(binding.items)) binding.items.forEach(inspect);
  };
  inspect(value.result);
  if (Array.isArray(value.nodes)) for (const node of value.nodes) if (object(node)) {
    inspect(node.input);
    check(!object(node.config) || !Object.hasOwn(node.config, "credentialBindings"), "FORMAT_UNSUPPORTED", "凭据字典引用需要 Git 快照 v2", 422);
    check(!object(node.config) || !Object.hasOwn(node.config, "dictionaryBindings"), "FORMAT_UNSUPPORTED", "字典声明需要 Git 快照 v2", 422);
  }
}
