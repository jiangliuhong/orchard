import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { executeProcess } from "./process.js";
import { check } from "../domain/errors.js";
import type { ScriptRuntime } from "../domain/scripts.js";
import type { SourceFiles } from "../domain/types.js";
import { json } from "../persistence/files.js";

export interface ScriptExecution {
  output: unknown;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export async function executeScript(options: { runtime: ScriptRuntime; entryFile: string; files: SourceFiles; input: unknown; cwd: string; timeoutMs?: number; signal?: AbortSignal; maxBytes?: number }): Promise<ScriptExecution> {
  const directory = join(options.cwd, `script-test-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, source] of Object.entries(options.files)) {
    const target = join(directory, name); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, source, { mode: 0o600 });
  }
  const resultFile = join(directory, "result.json");
  let executable: string, args: string[];
  if (options.runtime === "nodejs") {
    const entry = join(directory, options.entryFile);
    const compiled = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "node", target: "node24", logLevel: "silent" });
    const moduleFile = join(directory, "bundle.mjs"); writeFileSync(moduleFile, compiled.outputFiles[0]!.contents, { mode: 0o600 });
    const wrapper = `import {writeFileSync} from 'node:fs'; let text=''; for await (const chunk of process.stdin) text+=chunk; const module=await import(${json(pathToFileURL(moduleFile).href)}); if(typeof module.default!=='function') throw new Error('Node.js script must export default function'); const result=await module.default(JSON.parse(text)); writeFileSync(process.env.ORCHARD_RESULT_FILE, JSON.stringify(result ?? null));`;
    const wrapperFile = join(directory, "entry.mjs"); writeFileSync(wrapperFile, wrapper, { mode: 0o600 });
    executable = process.execPath; args = [wrapperFile];
  } else {
    executable = "/bin/bash"; args = [join(directory, options.entryFile)];
  }
  const processResult = await executeProcess({ executable, args, cwd: directory, input: json(options.input), signal: options.signal, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes ?? 8 * 1024 * 1024, env: { ORCHARD_RESULT_FILE: resultFile } });
  check(processResult.exitCode === 0, "PROCESS_FAILED", `脚本退出码 ${processResult.exitCode}: ${processResult.stderr.slice(-2000)}`);
  let output: unknown = options.runtime === "shell" ? { stdout: processResult.stdout, stderr: processResult.stderr, exitCode: processResult.exitCode } : undefined;
  if (options.runtime === "nodejs") {
    let info; try { info = lstatSync(resultFile); } catch { check(false, "INVALID_SCRIPT_OUTPUT", "脚本没有生成 JSON 结果文件"); }
    check(!info!.isSymbolicLink() && info!.isFile() && info!.size <= 8 * 1024 * 1024, "OUTPUT_LIMIT", "脚本结果文件无效或超限");
    try { output = JSON.parse(readFileSync(resultFile, "utf8")); } catch { check(false, "INVALID_SCRIPT_OUTPUT", "脚本未生成合法 JSON 结果文件"); }
  }
  return { output, stdout: processResult.stdout, stderr: processResult.stderr, exitCode: processResult.exitCode, durationMs: processResult.durationMs };
}
