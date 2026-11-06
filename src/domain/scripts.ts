import { AppError, check } from "./errors.js";
import { assertSchema } from "./validation.js";
import type { JsonSchema, SourceFiles } from "./types.js";

export type ScriptRuntime = "nodejs" | "shell";

export interface ScriptDefinition {
  id: string;
  name: string;
  description: string;
  runtime: ScriptRuntime;
  entryFile: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  timeoutMs?: number;
  resultMode?: "process" | "json";
  files: SourceFiles;
}

const MAX_FILES = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const FILE = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/;
const NODE_FILE = /\.(?:ts|js|mjs)$/;

function validSourceFile(name: string, runtime: ScriptRuntime) {
  return FILE.test(name) && !name.startsWith("/") && !name.includes("..") && (runtime === "shell" ? name.endsWith(".sh") : NODE_FILE.test(name));
}

export function validateScript(value: unknown): ScriptDefinition {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "INVALID_SCRIPT", "脚本定义必须是对象");
  const script = value as Partial<ScriptDefinition>;
  check(typeof script.id === "string" && /^[a-z][a-z0-9-]{0,99}$/.test(script.id), "INVALID_SCRIPT", "脚本 ID 无效");
  check(typeof script.name === "string" && script.name.length > 0 && script.name.length <= 200, "INVALID_SCRIPT", "脚本名称无效");
  check(typeof script.description === "string" && script.description.length <= 4000, "INVALID_SCRIPT", "脚本说明无效");
  check(script.runtime === "nodejs" || script.runtime === "shell", "INVALID_SCRIPT", "脚本运行时不支持");
  check(script.resultMode === undefined || script.resultMode === "json" || script.resultMode === "process", "INVALID_SCRIPT", "脚本输出协议无效");
  check(script.runtime === "shell" || script.resultMode === undefined || script.resultMode === "json", "INVALID_SCRIPT", "Node.js 脚本仅支持 JSON 输出");
  if (script.timeoutMs !== undefined) check(Number.isInteger(script.timeoutMs) && script.timeoutMs >= 1000 && script.timeoutMs <= 300000, "INVALID_SCRIPT", "脚本超时时间无效");
  check(typeof script.entryFile === "string" && validSourceFile(script.entryFile, script.runtime), "INVALID_SCRIPT", "脚本入口文件无效");
  check(script.files !== null && typeof script.files === "object" && !Array.isArray(script.files), "INVALID_SCRIPT", "脚本文件无效");
  const files = script.files as Record<string, unknown>;
  const names = Object.keys(files);
  check(names.length > 0 && names.length <= MAX_FILES, "INVALID_SCRIPT", "脚本文件数量超出限制");
  let total = 0;
  for (const name of names) {
    check(validSourceFile(name, script.runtime), "INVALID_SCRIPT_PATH", `不支持的脚本文件: ${name}`);
    check(typeof files[name] === "string", "INVALID_SCRIPT", `脚本文件不是文本: ${name}`);
    const bytes = Buffer.byteLength(files[name] as string, "utf8");
    check(bytes <= MAX_FILE_BYTES, "SCRIPT_LIMIT", `脚本文件超过 1 MiB: ${name}`);
    total += bytes;
  }
  check(total <= MAX_SOURCE_BYTES, "SCRIPT_LIMIT", "脚本源码总大小超过 4 MiB");
  check(Object.hasOwn(files, script.entryFile), "INVALID_SCRIPT", "脚本入口文件不存在");
  for (const [schema, context] of [[script.inputSchema, "脚本输入"], [script.outputSchema, "脚本输出"]] as const) {
    check(schema !== undefined, "INVALID_SCHEMA", `${context} Schema 必须声明`);
    try { assertSchema(null, schema, context); }
    catch (error) {
      if (!(error instanceof AppError && error.code === "SCHEMA_MISMATCH")) throw error;
    }
  }
  return {
    id: script.id, name: script.name, description: script.description, runtime: script.runtime,
    entryFile: script.entryFile, inputSchema: script.inputSchema!, outputSchema: script.outputSchema!,
    files: script.files as SourceFiles, ...(script.timeoutMs === undefined ? {} : { timeoutMs: script.timeoutMs }),
    ...(script.resultMode === undefined ? {} : { resultMode: script.resultMode }),
  };
}
