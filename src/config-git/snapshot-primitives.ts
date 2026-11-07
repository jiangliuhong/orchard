import { createHash } from "node:crypto";
import { parseAst } from "rolldown/parseAst";
import { check, AppError } from "../domain/errors.js";

export const snapshotDigest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const compareCodePoints = (a: string, b: string): number => {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!; if (d) return d; }
  return x.length - y.length;
};
export function canonicalSnapshotJson(value: unknown): string {
  const visit = (v: unknown, depth: number): string => {
    check(depth <= 100, "SNAPSHOT_LIMIT", "JSON nesting exceeds 100");
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") { check(Number.isFinite(v), "INVALID_SNAPSHOT", "Non-finite JSON number"); return JSON.stringify(v); }
    if (Array.isArray(v)) { check(Object.keys(v).length === v.length, "INVALID_SNAPSHOT", "Sparse JSON array"); return `[${v.map(x => visit(x, depth + 1)).join(",")}]`; }
    check(v !== null && typeof v === "object" && [null, Object.prototype].includes(Object.getPrototypeOf(v)), "INVALID_SNAPSHOT", "Expected plain JSON data");
    return `{${Object.keys(v).sort(compareCodePoints).map(k => {
      const d = Object.getOwnPropertyDescriptor(v, k)!; check("value" in d, "INVALID_SNAPSHOT", "JSON accessors are forbidden");
      return `${JSON.stringify(k)}:${visit(d.value, depth + 1)}`;
    }).join(",")}}`;
  };
  return visit(value, 0);
}
export function snapshotPath(path: string): string {
  check(typeof path === "string" && path.length > 0 && !/[\\\x00-\x1f\x7f:]/.test(path), "INVALID_PATH", "Invalid snapshot path");
  check(path.split("/").every(p => p && p !== "." && p !== ".." && p.toLowerCase() !== ".git" && Buffer.byteLength(p) <= 255), "INVALID_PATH", "Unsafe snapshot path");
  return path;
}
export function encodeSnapshotId(id: string): string {
  check(typeof id === "string" && id.length > 0 && !/[\x00-\x1f\x7f]/.test(id) && Buffer.from(id, "utf8").toString("utf8") === id, "INVALID_ID", "Invalid stable ID");
  const encoded = Buffer.from(id, "utf8").toString("hex");
  check(encoded.length <= 240, "INVALID_ID", "Stable ID exceeds filesystem component limit"); return encoded;
}
export const localReference = (...segments: string[]) => ({ localRef: segments.map(encodeSnapshotId).join(".") });
export function normalizeSnapshotText(text: string): string {
  check(typeof text === "string" && Buffer.from(text, "utf8").toString("utf8") === text && !text.includes("\0"), "INVALID_SNAPSHOT", "Expected UTF-8 text without NUL");
  return text.replace(/\r\n?/g, "\n");
}

/** Parse only data nodes; no imports, transpilation, dynamic loading or evaluation. */
export function parseDeclarativeConfig(source: string): unknown {
  check(typeof source === "string" && Buffer.byteLength(source) <= 4 * 1024 * 1024, "SNAPSHOT_LIMIT", "Configuration file exceeds limit");
  let ast: ReturnType<typeof parseAst>;
  try { ast = parseAst(source, { preserveParens: true }, "snapshot.config.js"); } catch { throw new AppError("INVALID_CONFIG_SCRIPT", "Invalid declarative configuration syntax"); }
  check(!ast.hashbang && ast.body.length === 1 && ast.body[0]!.type === "ExportDefaultDeclaration", "INVALID_CONFIG_SCRIPT", "Only export default data is permitted");
  type Node = { type: string; [key: string]: unknown };
  const visit = (node: Node | null, depth: number): unknown => {
    check(depth <= 100 && node !== null, "INVALID_CONFIG_SCRIPT", "Invalid or excessively nested data");
    if (node.type === "Literal") {
      check(node.regex === undefined && node.bigint === undefined && (node.value === null || ["string", "boolean", "number"].includes(typeof node.value)), "INVALID_CONFIG_SCRIPT", "Only JSON literals are permitted");
      if (typeof node.value === "number") check(Number.isFinite(node.value), "INVALID_CONFIG_SCRIPT", "Non-finite number");
      return node.value;
    }
    if (node.type === "UnaryExpression") {
      const arg = node.argument as Node;
      check(node.operator === "-" && arg.type === "Literal" && typeof arg.value === "number" && Number.isFinite(arg.value), "INVALID_CONFIG_SCRIPT", "Only negative numeric literals are permitted"); return -arg.value;
    }
    if (node.type === "ArrayExpression") return (node.elements as (Node | null)[]).map(n => visit(n, depth + 1));
    if (node.type === "ObjectExpression") {
      const result: Record<string, unknown> = Object.create(null);
      for (const p of node.properties as Node[]) {
        check(p.type === "Property" && p.kind === "init" && !p.method && !p.shorthand && !p.computed, "INVALID_CONFIG_SCRIPT", "Only explicit data properties are permitted");
        const key = p.key as Node;
        check(key.type === "Identifier" || key.type === "Literal" && typeof key.value === "string", "INVALID_CONFIG_SCRIPT", "Invalid property key");
        const name = (key.type === "Identifier" ? key.name : key.value) as string;
        check(!Object.hasOwn(result, name), "INVALID_CONFIG_SCRIPT", "Duplicate configuration property");
        result[name] = visit(p.value as Node, depth + 1);
      }
      return result;
    }
    throw new AppError("INVALID_CONFIG_SCRIPT", "Executable expressions are forbidden");
  };
  return visit((ast.body[0] as unknown as { declaration: Node }).declaration, 0);
}
export const declarativeConfig = (value: unknown) => `export default ${canonicalSnapshotJson(value)};\n`;
/** JSON also goes through duplicate-key detection; its lexical grammar remains strict JSON. */
export function parseSnapshotJson(source: string): unknown {
  try { JSON.parse(source); } catch { throw new AppError("INVALID_SNAPSHOT", "Invalid JSON"); }
  return parseDeclarativeConfig(`export default ${source};`);
}
export function object(value: unknown, required?: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "INVALID_SNAPSHOT", "Expected configuration object");
  const v = value as Record<string, unknown>;
  if (required) {
    check(required.every(k => Object.hasOwn(v, k)), "INVALID_SNAPSHOT", "Missing required configuration fields");
    for (const k of Object.keys(v)) check(required.includes(k) || optional.includes(k), "INVALID_SNAPSHOT", `Unknown configuration field: ${k}`);
  }
  return v;
}
export function string(value: unknown): asserts value is string { check(typeof value === "string", "INVALID_SNAPSHOT", "Expected string"); }
export function bool(value: unknown): asserts value is boolean { check(typeof value === "boolean", "INVALID_SNAPSHOT", "Expected boolean"); }
export function array(value: unknown): asserts value is unknown[] { check(Array.isArray(value), "INVALID_SNAPSHOT", "Expected array"); }
export function unique<T>(values: T[], key: (v: T) => string) { check(new Set(values.map(key)).size === values.length, "DUPLICATE_ID", "Duplicate stable identity"); }
