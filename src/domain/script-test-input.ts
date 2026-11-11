import type { JsonSchema } from "./types.js";
import { dictionaryIdSchema } from "./dictionaries.js";
import { check } from "./errors.js";
import { captureHistory, pointerPart, pointerParts, type HistorySources } from "../web-bridge/history-policy.js";

export type ScriptInputSources = Record<string, { source: "dictionary"; dictionaryId: string; key: string }>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function scriptInputProperties(schema: JsonSchema): Record<string, JsonSchema> | undefined {
  if (!object(schema) || schema.type !== "object" || ["$ref", "oneOf", "anyOf", "allOf", "if", "dependencies", "patternProperties"].some(key => Object.hasOwn(schema, key))) return undefined;
  return object(schema.properties) ? schema.properties as Record<string, JsonSchema> : {};
}
export function normalizeScriptInputSources(value: unknown, schema: JsonSchema): ScriptInputSources {
  if (value === undefined) return {};
  check(object(value) && Object.keys(value).length <= 256, "INVALID_INPUT_SOURCES", "参数来源必须是对象，最多 256 项");
  const properties = scriptInputProperties(schema);
  const entries = Object.entries(value).map(([path, ref]) => {
    const parts = pointerParts(path);
    check(properties && parts.length === 1 && path === `/${pointerPart(parts[0]!)}` && Object.hasOwn(properties, parts[0]!), "INVALID_INPUT_SOURCES", "字典引用仅支持明确声明的顶层参数");
    check(object(ref) && Object.keys(ref).sort().join(",") === "dictionaryId,key,source" && ref.source === "dictionary" && typeof ref.dictionaryId === "string" && new RegExp(dictionaryIdSchema.pattern).test(ref.dictionaryId) && typeof ref.key === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(ref.key), "INVALID_INPUT_SOURCES", "字典参数来源无效");
    return [path, { source: "dictionary" as const, dictionaryId: ref.dictionaryId, key: ref.key }] as const;
  });
  return Object.fromEntries(entries);
}
export function stripReferencedInput(input: unknown, sources: ScriptInputSources): unknown {
  if (!Object.keys(sources).length) return structuredClone(input);
  check(object(input), "INVALID_INPUT_SOURCES", "引用字典时测试输入必须是对象");
  return Object.fromEntries(Object.entries(input).filter(([key]) => !Object.hasOwn(sources, `/${pointerPart(key)}`)));
}
export function captureScriptInput(input: unknown, schema: JsonSchema, sources: ScriptInputSources) {
  const captured = captureHistory(stripReferencedInput(input, sources), schema, sources);
  return { input: captured.value ?? null, sources: captured.sources, transient: Object.values(captured.sources).some(s => s.source === "omitted") };
}
export function dictionarySources(sources: HistorySources): ScriptInputSources {
  return Object.fromEntries(Object.entries(sources).filter((entry): entry is [string, ScriptInputSources[string]] => entry[1].source === "dictionary"));
}
export function resolveScriptInput(input: unknown, sources: ScriptInputSources, resolve: (id: string, key: string) => unknown) {
  if (!Object.keys(sources).length) return structuredClone(input);
  check(object(input), "INVALID_INPUT_SOURCES", "引用字典时测试输入必须是对象");
  const result = { ...input };
  for (const [path, ref] of Object.entries(sources)) Object.defineProperty(result, pointerParts(path)[0]!, { value: resolve(ref.dictionaryId, ref.key), enumerable: true, writable: true, configurable: true });
  return result;
}
