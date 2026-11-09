import { check, AppError } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import type { JsonSchema } from "../domain/types.js";
import type { CredentialResolver } from "./execution.js";

export type CredentialBinding = { source: "dictionary"; dictionaryId: string; key: string } | { source: "inline"; value: string };
export type CredentialBindings = Record<string, CredentialBinding>;
export const CREDENTIAL_BINDINGS_SCHEMA: JsonSchema = {
  type: "object", maxProperties: 20, propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
  additionalProperties: { oneOf: [
    { type: "object", additionalProperties: false, required: ["source", "dictionaryId", "key"], properties: {
      source: { const: "dictionary" }, dictionaryId: { type: "string", minLength: 1, maxLength: 100 }, key: { type: "string", minLength: 1, maxLength: 100 },
    } },
    { type: "object", additionalProperties: false, required: ["source", "value"], properties: {
      source: { const: "inline" }, value: { type: "string", minLength: 1, maxLength: 8192 },
    } },
  ] },
};
export const CREDENTIAL_INPUTS_SCHEMA: JsonSchema = {
  type: "array", maxItems: 20, uniqueItems: true,
  items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
};

/** Values are call-local only; never attach bindings to definitions, history or errors. */
export function resolveCredentialInputs(names: string[], defaults: Record<string, { dictionaryId: string; key: string }>, bindings: CredentialBindings = {}, resolve?: CredentialResolver) {
  // Do not expose validator details: they may contain the submitted secret.
  try { assertSchema(bindings, CREDENTIAL_BINDINGS_SCHEMA, "调用凭据"); }
  catch { throw new AppError("INVALID_CREDENTIALS", "调用凭据格式无效"); }
  const declared = new Set([...names, ...Object.keys(defaults)]);
  check(Object.keys(bindings).every(name => declared.has(name)), "INVALID_CREDENTIALS", "调用包含未声明的凭据");
  return Object.fromEntries([...declared].map(name => {
    const binding = Object.hasOwn(bindings, name) ? bindings[name] : undefined;
    if (binding?.source === "inline") return [name, binding.value];
    const reference = binding?.source === "dictionary" ? binding : Object.hasOwn(defaults, name) ? defaults[name] : undefined;
    check(reference && resolve, "CREDENTIAL_UNAVAILABLE", "缺少调用凭据或安全凭据解析器");
    // Resolver errors must never echo caller-controlled data or decrypted values.
    try {
      const value = resolve(reference.dictionaryId, reference.key);
      check(typeof value === "string" && value.length > 0, "CREDENTIAL_UNAVAILABLE", "凭据为空");
      return [name, value];
    } catch { throw new AppError("CREDENTIAL_UNAVAILABLE", "加密凭据不可用，请检查字典、键名及密钥设置"); }
  }));
}
