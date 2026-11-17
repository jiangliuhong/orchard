import type { JsonSchema } from "./types.js";

export const dictionaryDefaultKeyword = "x-dictionary-default";
export type DictionaryDefault = { dictionaryId: string; key: string };

export function inputDictionaryDefaults(schema: JsonSchema): [string, DictionaryDefault][] {
  if (!schema || typeof schema !== "object" || schema.type !== "object" ||
    !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return [];
  const properties = schema.properties as Record<string, JsonSchema>;
  return Object.entries(properties).flatMap(([name, field]) =>
    field && typeof field === "object" && Object.hasOwn(field, dictionaryDefaultKeyword)
      ? [[name, field[dictionaryDefaultKeyword] as DictionaryDefault]] : []);
}

export function applyInputDefaults(input: unknown, schema: JsonSchema, resolve: (id: string, key: string) => unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const missing = inputDictionaryDefaults(schema).filter(([name]) => !Object.hasOwn(input, name));
  if (!missing.length) return input;
  return { ...input, ...Object.fromEntries(missing.map(([name, ref]) => [name, resolve(ref.dictionaryId, ref.key)])) };
}

/** For forms and admission checks that cannot see the eventual dictionary values. */
export function unresolvedInputSchema(schema: JsonSchema, input: unknown): JsonSchema {
  if (!schema || typeof schema !== "object" || !input || typeof input !== "object" || Array.isArray(input)) return schema;
  const missing = new Set(inputDictionaryDefaults(schema).map(([name]) => name).filter(name => !Object.hasOwn(input, name)));
  if (!missing.size) return schema;
  return {
    ...schema,
    ...(Array.isArray(schema.required) ? { required: schema.required.filter(name => !missing.has(name)) } : {}),
    ...(typeof schema.minProperties === "number" ? { minProperties: Math.max(0, schema.minProperties - missing.size) } : {}),
  };
}
