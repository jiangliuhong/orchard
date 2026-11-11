import type { JsonSchema } from "../../domain/types.js";
import { AppError } from "../../domain/errors.js";
import { assertSchema } from "../../domain/validation.js";
import { parseStrictJson } from "../../dictionaries/canonical.js";

export type SchemaObject = Record<string, unknown>;
export const schemaTypes = ["object", "array", "string", "number", "integer", "boolean", "null"] as const;
const common = ["type", "title", "description", "default", "x-history"];
const keywords: Record<string, string[]> = {
  object: ["properties", "required", "additionalProperties"], array: ["items", "minItems", "maxItems", "uniqueItems"],
  string: ["enum", "minLength", "maxLength", "pattern", "x-ui"], number: ["enum", "minimum", "maximum"], integer: ["enum", "minimum", "maximum"], boolean: [], null: [],
};
export function validateEditorSchema(schema: JsonSchema) {
  try { assertSchema(null, schema, "Schema"); } catch (error) { if (!(error instanceof AppError && error.code === "SCHEMA_MISMATCH")) throw error; }
  const visit = (node: JsonSchema) => {
    if (typeof node === "boolean") return;
    for (const [min, max] of [["minLength", "maxLength"], ["minItems", "maxItems"], ["minimum", "maximum"]]) {
      if (typeof node[min!] === "number" && typeof node[max!] === "number" && Number(node[min!]) > Number(node[max!])) throw new Error(`${min} 不能大于 ${max}`);
    }
    if (Object.hasOwn(node, "default")) assertSchema(node.default, node, "默认值");
    if (typeof node.type === "string" && Array.isArray(node.enum)) for (const item of node.enum) assertSchema(item, { type: node.type }, "枚举值类型");
    if (node.properties && typeof node.properties === "object") Object.values(node.properties).forEach(v => visit(v as JsonSchema));
    if (node.items && !Array.isArray(node.items)) visit(node.items as JsonSchema);
  };
  visit(schema);
}
export function parseEditorSchema(text: string): JsonSchema {
  const schema = parseStrictJson(text, { maxDepth: 100 }) as JsonSchema;
  validateEditorSchema(schema);
  return schema;
}
/** Conservative: never rebuild a complex schema from just the subset the UI knows. */
export function schemaEditorReason(schema: JsonSchema, path = "根", depth = 0): string | undefined {
  if (typeof schema === "boolean") return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `${path}：不是 Schema`;
  if (depth > 12) return `${path}：嵌套超过字段视图展示深度，请使用 JSON`;
  if (typeof schema.type !== "string" || !keywords[schema.type]) return `${path}：需要明确的单一 type`;
  const unsupported = Object.keys(schema).find(k => ![...common, ...keywords[schema.type as string]!].includes(k));
  if (unsupported) return `${path}：${unsupported} 请使用 JSON 编辑`;
  if (schema.type === "object") {
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return `${path}：复杂 additionalProperties 请使用 JSON`;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    if (Object.keys(properties).includes("") || (schema.required as string[] | undefined)?.some(k => !Object.hasOwn(properties, k))) return `${path}：空属性名或未声明的必填属性请使用 JSON`;
    for (const [key, child] of Object.entries(properties)) { const reason = schemaEditorReason(child, `${path}/${key}`, depth + 1); if (reason) return reason; }
  }
  if (schema.type === "array" && schema.items !== undefined) {
    if (Array.isArray(schema.items)) return `${path}：元组数组请使用 JSON`;
    return schemaEditorReason(schema.items as JsonSchema, `${path}/元素`, depth + 1);
  }
}
export function renameSchemaProperty(schema: SchemaObject, from: string, to: string): SchemaObject {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  if (!to || (to !== from && Object.hasOwn(properties, to))) throw new Error("字段名不能为空或与同级字段重复");
  if (from === to) return schema;
  return { ...schema, properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key === from ? to : key, value])), ...(schema.required === undefined ? {} : { required: (schema.required as string[]).map(key => key === from ? to : key) }) };
}
export function deleteSchemaProperty(schema: SchemaObject, name: string): SchemaObject {
  return { ...schema, properties: Object.fromEntries(Object.entries((schema.properties ?? {}) as SchemaObject).filter(([key]) => key !== name)), ...(schema.required === undefined ? {} : { required: (schema.required as string[]).filter(key => key !== name) }) };
}
export function changeSchemaType(schema: JsonSchema, type: string): JsonSchema {
  if (type === "true") return true;
  if (type === "false") return false;
  const next: SchemaObject = { type };
  if (typeof schema === "object") {
    for (const key of [...common.filter(k => k !== "type"), ...(keywords[type] ?? [])]) if (Object.hasOwn(schema, key)) Object.defineProperty(next, key, { value: schema[key], enumerable: true, configurable: true, writable: true });
  }
  return next;
}
export const processOutputSchema: JsonSchema = { type: "object", properties: { stdout: { type: "string" }, stderr: { type: "string" }, exitCode: { type: "integer" } }, required: ["stdout", "stderr", "exitCode"], additionalProperties: false };
