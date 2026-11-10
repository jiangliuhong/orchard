import type { JsonSchema } from "../domain/types.js";
import type { CredentialBindings } from "./credential-inputs.js";

export type HistorySource =
  | { source: "dictionary"; dictionaryId: string; key: string }
  | { source: "omitted"; reason: "schema-policy" | "legacy-unknown" };
export type HistorySources = Record<string, HistorySource>;
export const pointerPart = (name: string) => name.replace(/~/g, "~0").replace(/\//g, "~1");
export const pointerParts = (path: string) => path === "" ? [] : path.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
export function historyValue(value: unknown, path: string): unknown {
  for (const part of pointerParts(path)) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);
/** Conservatively combine branch policies, independent of which branch validates today. */
function expand(schema: unknown, root: JsonSchema, seen = new Set<unknown>()): Schema[] {
  if (!object(schema) || seen.has(schema)) return [];
  seen = new Set(seen).add(schema);
  const result = [schema];
  if (typeof schema.$ref === "string") {
    const target = schema.$ref === "#" ? root : schema.$ref.startsWith("#/") ? historyValue(root, decodeURIComponent(schema.$ref.slice(1))) : undefined;
    if (target === undefined) result.push({ "x-history": { record: false } });
    else result.push(...expand(target, root, seen));
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) if (Array.isArray(schema[key])) for (const branch of schema[key]) result.push(...expand(branch, root, seen));
  for (const key of ["if", "then", "else", "not"]) result.push(...expand(schema[key], root, seen));
  if (object(schema.dependencies)) for (const branch of Object.values(schema.dependencies)) result.push(...expand(branch, root, seen));
  return result;
}

/** Omitted object members are absent; array positions remain null plus authoritative metadata. */
export function captureHistory(value: unknown, schema: JsonSchema, existing: HistorySources = {}, legacy = false) {
  const sources: HistorySources = { ...existing };
  const walk = (value: unknown, schemas: unknown[], path: string): unknown => {
    if (sources[path]?.source === "dictionary") return undefined;
    const nodes = schemas.flatMap(node => expand(node, schema));
    if (sources[path]?.source === "omitted" || nodes.some(node => object(node["x-history"]) && node["x-history"].record === false) || legacy && value === "[已脱敏]") {
      sources[path] = sources[path] ?? { source: "omitted", reason: legacy && value === "[已脱敏]" ? "legacy-unknown" : "schema-policy" };
      // A parent omission supersedes child placeholders, but not dictionary references.
      for (const key of Object.keys(sources)) if (key !== path && key.startsWith(path + "/") && sources[key].source === "omitted") delete sources[key];
      return undefined;
    }
    if (Array.isArray(value)) return value.map((child, index) => walk(child, nodes.map(node => Array.isArray(node.items) ? node.items[index] ?? node.additionalItems : node.items), `${path}/${index}`) ?? null);
    if (object(value)) return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      const childSchemas = nodes.flatMap(node => {
        const properties = object(node.properties) ? node.properties : {};
        const patterns = object(node.patternProperties) ? Object.entries(node.patternProperties).filter(([pattern]) => new RegExp(pattern).test(key)).map(([, item]) => item) : [];
        return [properties[key], ...patterns, ...(!Object.hasOwn(properties, key) && !patterns.length ? [node.additionalProperties] : [])];
      });
      const result = walk(child, childSchemas, `${path}/${pointerPart(key)}`);
      return result === undefined ? [] : [[key, result]];
    }));
    return value;
  };
  return { value: walk(value, [schema], ""), sources };
}

/** Inline history values are reconstructed separately from dictionary sources. */
export function restoredCredentials(values: Record<string, string> = {}, sources: HistorySources = {}): CredentialBindings {
  const bindings: CredentialBindings = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { source: "inline", value }]));
  for (const [path, source] of Object.entries(sources)) {
    const parts = pointerParts(path);
    if (parts.length === 1) Object.defineProperty(bindings, parts[0], { value: source.source === "dictionary" ? source : { source: "inline", value: "" }, enumerable: true, configurable: true, writable: true });
  }
  return bindings;
}
