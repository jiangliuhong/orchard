import { mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { executeProcess } from "./process.js";
import { AppError, check } from "../domain/errors.js";
import { validateScript, type ScriptRuntime } from "../domain/scripts.js";
import type { SourceFiles } from "../domain/types.js";
import { compileScripts, json } from "../persistence/files.js";

export async function checkScriptSource(options: { runtime: ScriptRuntime; entryFile: string; files: SourceFiles }) {
  validateScript({ runtime: options.runtime, entryFile: options.entryFile, files: options.files, id: "source-check", name: "Source check", description: "", inputSchema: true, outputSchema: true });
  const files = Object.fromEntries(Object.entries(options.files).map(([name, source]) => [`scripts/${name}`, source]));
  try { return await compileScripts(files, {
    formatVersion: 1, id: "source-check", name: "Source check", inputSchema: true, outputSchema: true,
    entryNodeId: "entry", result: { source: "node", nodeId: "entry" }, edges: [],
    nodes: [{ id: "entry", name: "Entry", type: options.runtime === "nodejs" ? "code.nodejs" : "shell", input: { source: "workflow" }, outputSchema: true, config: { script: `scripts/${options.entryFile}` } }],
  }, { requireDefaultExport: true }); } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_SCRIPT", error instanceof Error ? error.message : "脚本源码校验失败");
  }
}

export interface ScriptExecution {
  output: unknown;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export class ScriptExecutionError extends AppError {
  constructor(error: unknown, readonly execution: Omit<ScriptExecution, "output">) {
    super(error instanceof AppError ? error.code : "EXECUTION_FAILED", error instanceof Error ? error.message : String(error));
  }
}

export interface ScriptExecutionOptions {
  runtime: ScriptRuntime; entryFile: string; files: SourceFiles; input: unknown; cwd: string;
  timeoutMs?: number; signal?: AbortSignal; maxBytes?: number; resultMode?: "process" | "json";
}
export async function executeScript(options: ScriptExecutionOptions): Promise<ScriptExecution> {
  const compiled = await checkScriptSource(options);
  const directory = join(options.cwd, `script-test-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { return await executeInDirectory(options, compiled, directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
async function executeInDirectory(options: ScriptExecutionOptions, compiled: Record<string, string>, directory: string): Promise<ScriptExecution> {
  for (const [name, source] of Object.entries(options.files)) {
    const target = join(directory, name); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, source, { mode: 0o600 });
  }
  const resultFile = join(directory, "result.json");
  let executable: string, args: string[];
  if (options.runtime === "nodejs") {
    const moduleFile = join(directory, "bundle.mjs"); writeFileSync(moduleFile, compiled.entry, { mode: 0o600 });
    const wrapper = `import {writeFileSync} from 'node:fs'; let text=''; for await (const chunk of process.stdin) text+=chunk; const module=await import(${json(pathToFileURL(moduleFile).href)}); if(typeof module.default!=='function') throw new Error('Node.js script must export default function'); const result=await module.default(JSON.parse(text)); writeFileSync(process.env.ORCHARD_RESULT_FILE, JSON.stringify(result ?? null));`;
    const wrapperFile = join(directory, "entry.mjs"); writeFileSync(wrapperFile, wrapper, { mode: 0o600 });
    executable = process.execPath; args = [wrapperFile];
  } else {
    executable = "/bin/bash"; args = [join(directory, options.entryFile)];
  }
  const started = Date.now();
  let stdout = "", stderr = "", processResult: Awaited<ReturnType<typeof executeProcess>>;
  try {
    processResult = await executeProcess({ executable, args, cwd: directory, input: json(options.input), signal: options.signal, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes ?? 8 * 1024 * 1024, inheritEnv: false, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: directory, TMPDIR: directory, ORCHARD_RESULT_FILE: resultFile }, onLog(stream, chunk) { if (stream === "stdout") stdout += chunk; else stderr += chunk; } });
  } catch (error) {
    throw new ScriptExecutionError(error, { stdout: stdout.replaceAll(directory, "[script]"), stderr: stderr.replaceAll(directory, "[script]"), exitCode: null, durationMs: Date.now() - started });
  }
  processResult.stdout = processResult.stdout.replaceAll(directory, "[script]");
  processResult.stderr = processResult.stderr.replaceAll(directory, "[script]");
  if (processResult.exitCode !== 0) throw new ScriptExecutionError(new AppError("PROCESS_FAILED", `脚本退出码 ${processResult.exitCode}`), processResult);
  let output: unknown = options.runtime === "shell" ? { stdout: processResult.stdout, stderr: processResult.stderr, exitCode: processResult.exitCode } : undefined;
  try { if (options.runtime === "nodejs" || options.resultMode === "json") {
    let info; try { info = lstatSync(resultFile); } catch { check(false, "INVALID_SCRIPT_OUTPUT", "脚本没有生成 JSON 结果文件"); }
    check(!info!.isSymbolicLink() && info!.isFile() && info!.size <= (options.maxBytes ?? 8 * 1024 * 1024), "OUTPUT_LIMIT", "脚本结果文件无效或超限");
    try { output = JSON.parse(readFileSync(resultFile, "utf8")); } catch { check(false, "INVALID_SCRIPT_OUTPUT", "脚本未生成合法 JSON 结果文件"); }
  } } catch (error) { throw new ScriptExecutionError(error, processResult); }
  return { output, stdout: processResult.stdout, stderr: processResult.stderr, exitCode: processResult.exitCode, durationMs: processResult.durationMs };
}
