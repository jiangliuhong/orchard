import type { JsonSchema } from "../domain/types.js";
import type { BrowserExecution } from "./browser-execution.js";
import type { CredentialBindings } from "./credential-inputs.js";
import { pointerPart } from "./history-policy.js";

export function credentialSchema(execution: BrowserExecution): JsonSchema {
  if (execution.credentialSchema) return execution.credentialSchema;
  const names = [...new Set([...(execution.credentialInputs ?? []), ...Object.keys(execution.preprocess.credentials ?? {})])];
  return { type: "object", properties: Object.fromEntries(names.map(name => [name, { type: "string", minLength: 1, maxLength: 8192, "x-history": { record: false } }])), required: names, additionalProperties: false };
}
export function credentialProperties(execution: BrowserExecution): Record<string, Record<string, unknown>> {
  return (credentialSchema(execution) as Record<string, unknown>).properties as Record<string, Record<string, unknown>> ?? {};
}
export function credentialRequired(execution: BrowserExecution): string[] {
  return (credentialSchema(execution) as { required?: string[] }).required ?? [];
}
export function missingCredentials(execution: BrowserExecution, bindings: CredentialBindings): string[] {
  return credentialRequired(execution).filter(name => {
    const binding = Object.hasOwn(bindings, name) ? bindings[name] : undefined;
    if (binding?.source === "inline") return !binding.value;
    if (binding?.source === "dictionary") return !binding.dictionaryId || !binding.key;
    return !Object.hasOwn(execution.preprocess.credentials ?? {}, name);
  });
}
export function credentialHistoryInput(execution: BrowserExecution, bindings: CredentialBindings = {}) {
  const values: Record<string, string> = {}, sources: Record<string, { source: "dictionary"; dictionaryId: string; key: string }> = {};
  for (const name of Object.keys(credentialProperties(execution))) {
    const binding = bindings && Object.hasOwn(bindings, name) ? bindings[name] : undefined;
    const reference = binding?.source === "dictionary" ? binding : !binding ? execution.preprocess.credentials?.[name] : undefined;
    if (reference && typeof reference.dictionaryId === "string" && typeof reference.key === "string") sources[`/${pointerPart(name)}`] = { source: "dictionary", dictionaryId: reference.dictionaryId, key: reference.key };
    else if (binding?.source === "inline" && typeof binding.value === "string" && binding.value) values[name] = binding.value;
  }
  return { values, sources };
}
