import type { JsonSchema } from "./types.js";
import { pointerPart } from "../web-bridge/history-policy.js";
export interface SchemaChange { path: string; before: unknown; after: unknown }
export function schemaChanges(before: JsonSchema, after: JsonSchema): SchemaChange[] {
  const result: SchemaChange[] = [];
  const visit = (a: unknown, b: unknown, path: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) visit(Object.hasOwn(left, key) ? left[key] : undefined, Object.hasOwn(right, key) ? right[key] : undefined, `${path}/${pointerPart(key)}`);
    } else result.push({ path: path || "（根）", before: a, after: b });
  };
  visit(before, after, ""); return result;
}
export function historyPolicyRelaxed(before: JsonSchema, after: JsonSchema): boolean {
  const visit = (a: unknown, b: unknown): boolean => {
    if (!a || typeof a !== "object") return false;
    const left = a as Record<string, unknown>, right = b && typeof b === "object" ? b as Record<string, unknown> : {};
    if ((left["x-history"] as { record?: boolean } | undefined)?.record === false && (right["x-history"] as { record?: boolean } | undefined)?.record !== false) return true;
    return Object.keys(left).some(key => visit(left[key], Object.hasOwn(right, key) ? right[key] : undefined));
  };
  return visit(before, after);
}
