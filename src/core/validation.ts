import { Ajv, type ErrorObject } from "ajv";
import type { JsonSchema } from "./contracts.js";

// No coercion, defaults or removal of properties: validation must not alter inputs.
const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true, ownProperties: true, addUsedSchema: false });

function jsonError(value: unknown, path: string, ancestors = new Set<object>()): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") return `${path} must be a JSON value`;
  if (ancestors.has(value)) return `${path} must not contain circular references`;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return `${path} must be a plain JSON object`;
  }
  if (Object.getOwnPropertySymbols(value).length) return `${path} must not contain symbol properties`;
  ancestors.add(value);
  try {
    const keys = Array.isArray(value) ? Array.from({ length: value.length }, (_, i) => String(i)) : Object.keys(value);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return `${path}.${key} must be a JSON data property`;
      const error = jsonError(descriptor.value, `${path}.${key}`, ancestors);
      if (error) return error;
    }
  } finally {
    ancestors.delete(value);
  }
}

function describe(error: ErrorObject, path: string): string {
  const location = path + error.instancePath.split("/").slice(1).map((part) => `.${part.replaceAll("~1", "/").replaceAll("~0", "~")}`).join("");
  if (error.keyword === "required") return `${location}.${error.params.missingProperty} is required`;
  return `${location} ${error.message ?? "is invalid"}`;
}

/** Schemas are trusted code. Compile only in authorized workers, not from HTTP input. */
export function validateJson(value: unknown, schema: JsonSchema, path = "$"): readonly string[] {
  if (typeof schema === "object" && schema !== null && schema.$async) throw new Error("Async schemas are not supported");
  const validate = ajv.compile(schema);
  const error = jsonError(value, path);
  if (error) return [error];
  return validate(value) ? [] : (validate.errors ?? []).map((entry) => describe(entry, path));
}

export function assertValidJson(value: unknown, schema: JsonSchema, label: string): void {
  const errors = validateJson(value, schema);
  if (errors.length > 0) throw new Error(`${label} validation failed: ${errors.join("; ")}`);
}
