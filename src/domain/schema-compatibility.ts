import { assertSchema, pointer } from "./validation.js";
import type { Binding, JsonSchema, Workflow } from "./types.js";

export type Compatibility = "compatible" | "incompatible" | "unknown";
const advanced = ["$ref", "$defs", "definitions", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "dependentSchemas", "dependencies", "contains", "patternProperties"];
const merge = (values: Compatibility[]): Compatibility => values.includes("incompatible") ? "incompatible" : values.includes("unknown") ? "unknown" : "compatible";

export function schemaSubset(source: JsonSchema, target: JsonSchema, depth = 0): Compatibility {
  if (depth > 30) return "unknown";
  if (source === false || target === true || JSON.stringify(source) === JSON.stringify(target)) return "compatible";
  if (target === false) return "incompatible";
  if (source === true) return Object.keys(target).some(key => !["title", "description", "default", "examples", "$schema", "$id"].includes(key)) ? "unknown" : "compatible";
  const choices = Object.hasOwn(source, "const") ? [source.const] : Array.isArray(source.enum) ? source.enum : undefined;
  if (choices) {
    const possible = choices.filter(value => { try { assertSchema(value, source); return true; } catch { return false; } });
    return possible.every(value => { try { assertSchema(value, target); return true; } catch { return false; } }) ? "compatible" : "incompatible";
  }
  if (advanced.some(key => Object.hasOwn(source, key) || Object.hasOwn(target, key))) return "unknown";
  if (Object.hasOwn(target, "const") || target.enum) return "unknown";
  const sourceTypes = typeof source.type === "string" ? [source.type] : Array.isArray(source.type) ? source.type as string[] : [];
  const targetTypes = typeof target.type === "string" ? [target.type] : Array.isArray(target.type) ? target.type as string[] : [];
  const results: Compatibility[] = [];
  if (targetTypes.length) {
    if (!sourceTypes.length) results.push("unknown");
    else if (!sourceTypes.every(type => targetTypes.includes(type) || type === "integer" && targetTypes.includes("number"))) return "incompatible";
  }
  const relevant = (type: string) => !sourceTypes.length || sourceTypes.includes(type);
  for (const key of ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"] as const) {
    if (target[key] !== undefined) results.push(typeof source[key] === "number" && Number(source[key]) >= Number(target[key]) ? "compatible" : "unknown");
  }
  for (const key of ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"] as const) {
    if (target[key] !== undefined) results.push(typeof source[key] === "number" && Number(source[key]) <= Number(target[key]) ? "compatible" : "unknown");
  }
  for (const key of ["pattern", "format", "multipleOf", "uniqueItems"] as const) if (target[key] !== undefined && source[key] !== target[key]) results.push("unknown");
  if (relevant("object") && (target.properties || target.required || target.additionalProperties !== undefined)) {
    const sourceProperties = (source.properties ?? {}) as Record<string, JsonSchema>, targetProperties = (target.properties ?? {}) as Record<string, JsonSchema>;
    const required = Array.isArray(source.required) ? source.required : [];
    if (Array.isArray(target.required)) for (const key of target.required) if (!required.includes(key)) results.push(sourceTypes.includes("object") ? "incompatible" : "unknown");
    for (const [key, schema] of Object.entries(targetProperties)) {
      if (Object.hasOwn(sourceProperties, key)) results.push(schemaSubset(sourceProperties[key]!, schema, depth + 1));
      else if (source.additionalProperties !== false) results.push("unknown");
    }
    if (target.additionalProperties === false) {
      if (Object.entries(sourceProperties).some(([key, schema]) => schema !== false && !Object.hasOwn(targetProperties, key))) results.push("incompatible");
      if (source.additionalProperties !== false) results.push("unknown");
    } else if (target.additionalProperties && typeof target.additionalProperties === "object") {
      for (const [key, schema] of Object.entries(sourceProperties)) if (!Object.hasOwn(targetProperties, key)) results.push(schemaSubset(schema, target.additionalProperties as JsonSchema, depth + 1));
      if (source.additionalProperties !== false) results.push(schemaSubset((source.additionalProperties ?? true) as JsonSchema, target.additionalProperties as JsonSchema, depth + 1));
    }
  }
  if (relevant("array") && source.maxItems !== 0 && target.items !== undefined) {
    if (Array.isArray(source.items) || Array.isArray(target.items)) results.push("unknown");
    else results.push(schemaSubset((source.items ?? true) as JsonSchema, target.items as JsonSchema, depth + 1));
  }
  const handled = new Set(["type", "title", "description", "default", "examples", "$schema", "$id", "properties", "required", "additionalProperties", "items", "minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties", "maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties", "pattern", "format", "multipleOf", "uniqueItems"]);
  if (Object.keys(target).some(key => !handled.has(key))) results.push("unknown");
  return merge(results);
}

export function bindingSchema(binding: Binding, workflow: Workflow): JsonSchema {
  if (binding.source === "literal") return { enum: [binding.value] };
  if (binding.source === "object") return { type: "object", properties: Object.fromEntries(Object.entries(binding.properties).map(([key, value]) => [key, bindingSchema(value, workflow)])), required: Object.keys(binding.properties), additionalProperties: false };
  if (binding.source === "array") return { type: "array", minItems: binding.items.length, maxItems: binding.items.length };
  let schema = binding.source === "workflow" ? workflow.inputSchema : workflow.nodes.find(node => node.id === binding.nodeId)?.outputSchema ?? true;
  if (binding.pointer) {
    if (schema && typeof schema === "object" && Array.isArray(schema.enum) && schema.enum.length === 1) {
      try { return { enum: [pointer(schema.enum[0], binding.pointer)] }; } catch { return false; }
    }
    for (const part of binding.pointer.slice(1).split("/").map(value => value.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      if (!schema || typeof schema !== "object") return true;
      const properties = schema.properties as Record<string, JsonSchema> | undefined;
      if (schema.type === "object" && Array.isArray(schema.required) && schema.required.includes(part) && properties && Object.hasOwn(properties, part)) schema = properties[part]!;
      else if (schema.type === "array" && /^\d+$/.test(part) && Number(schema.minItems ?? 0) > Number(part) && typeof schema.items === "object" && !Array.isArray(schema.items)) schema = schema.items as JsonSchema;
      else return true;
    }
  }
  return schema;
}
