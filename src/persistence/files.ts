import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync, existsSync, renameSync, rmSync } from "node:fs";
import { resolve, dirname, sep, posix } from "node:path";
import { builtinModules } from "node:module";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { check } from "../domain/errors.js";
import { validateWorkflow } from "../domain/validation.js";
import type { SourceFiles, Layout, Workflow } from "../domain/types.js";
import type { ScriptDefinition } from "../domain/scripts.js";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const json = (value: unknown) => JSON.stringify(value ?? null);
export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)])) : item;
  return json(normalize(JSON.parse(json(value))));
}
export function safeFile(name: string) {
  check(typeof name === "string" && (name === "workflow.json" || name === "layout.json" || /^scripts\/[a-zA-Z0-9_./-]+\.(?:ts|js|mjs|sh)$/.test(name)), "INVALID_PATH", `不支持的文件: ${name}`);
  check(!name.split("/").some(p => p === "." || p === ".." || !p), "INVALID_PATH", `文件路径越界: ${name}`);
  return name;
}
export function checkFiles(files: SourceFiles) {
  check(files && typeof files === "object" && !Array.isArray(files), "INVALID_FILES", "缺少文件集合");
  const entries = Object.entries(files);
  check(entries.length <= 100 && Object.hasOwn(files, "workflow.json"), "INVALID_FILES", "必须包含 workflow.json，最多 100 个文件");
  let total = 0;
  for (const [name, code] of entries) {
    safeFile(name);
    check(typeof code === "string" && Buffer.byteLength(code) <= 1024 * 1024, "INVALID_FILES", "单个文件超过 1 MiB 或不是文本");
    total += Buffer.byteLength(code);
  }
  check(total <= 4 * 1024 * 1024, "INVALID_FILES", "文件总大小超过 4 MiB");
}
export function readDefinition(files: SourceFiles): Workflow { return validateWorkflow(JSON.parse(files["workflow.json"]!)); }
export function readLayout(files: SourceFiles): Layout {
  const value = JSON.parse(files["layout.json"] ?? "{}");
  check(value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(p => {
    const point = p as { x?: unknown; y?: unknown };
    return point && typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y);
  }), "INVALID_LAYOUT", "布局应是节点 ID 到有限坐标的映射");
  return value;
}
export async function compileScripts(files: SourceFiles, workflow: Workflow, options: { requireDefaultExport?: boolean } = {}): Promise<Record<string, string>> {
  const compiled: Record<string, string> = {};
  for (const node of workflow.nodes) {
    if (node.type === "code.nodejs") {
      const script = safeFile(node.config.script!);
      check(Object.hasOwn(files, script) && /\.(?:ts|js|mjs)$/.test(script), "INVALID_SCRIPT", `缺少 Node.js 脚本: ${script}`);
      const result = await build({
        entryPoints: [script], bundle: true, write: false, format: "esm", platform: "node", target: "node24", logLevel: "silent", metafile: true,
        plugins: [{ name: "version-files", setup(builder) {
          builder.onResolve({ filter: /.*/ }, args => {
            if (builtinModules.includes(args.path) || args.path.startsWith("node:") && builtinModules.includes(args.path.slice(5))) return { path: args.path, external: true };
            const target = args.kind === "entry-point" ? args.path : args.path.startsWith(".") ? posix.normalize(posix.join(posix.dirname(args.importer), args.path)) : "";
            check(target.startsWith("scripts/") && Object.hasOwn(files, target), "INVALID_IMPORT", `只允许版本内完整相对路径和 Node 内置模块: ${args.path}`);
            return { path: target, namespace: "version" };
          });
          builder.onLoad({ filter: /.*/, namespace: "version" }, args => ({ contents: files[args.path], loader: args.path.endsWith(".ts") ? "ts" : "js" }));
        } }],
      });
      if (options.requireDefaultExport) check(Object.values(result.metafile.outputs).some(output => output.exports.includes("default")), "INVALID_SCRIPT", "Node.js 入口必须包含默认导出");
      compiled[node.id] = result.outputFiles[0]!.text;
    } else if (node.type === "shell") {
      const script = safeFile(node.config.script!);
      check(Object.hasOwn(files, script) && script.endsWith(".sh"), "INVALID_SCRIPT", `缺少 Shell 脚本: ${script}`);
      const syntax = spawnSync("/bin/bash", ["-n"], { input: files[script], encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 2000, maxBuffer: 65536 });
      check(!syntax.error && syntax.status === 0, "INVALID_SCRIPT", `Shell 语法错误 ${script}: ${syntax.error?.message ?? syntax.stderr}`);
    }
  }
  return compiled;
}
export async function validateFiles(files: SourceFiles) {
  try {
    checkFiles(files);
    const workflow = readDefinition(files); readLayout(files);
    await compileScripts(files, workflow);
    return { valid: true, diagnostics: [] as string[] };
  } catch (error) { return { valid: false, diagnostics: [error instanceof Error ? error.message : String(error)] }; }
}
export class FileStore {
  readonly root: string;
  constructor(root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); this.root = realpathSync(root); }
  path(relative: string) {
    check(typeof relative === "string" && relative !== "" && !relative.includes("\\") && !relative.startsWith("/") && !relative.split("/").some(s => s === ".." || s === "." || s === ""), "INVALID_PATH", "产物路径无效");
    const path = resolve(this.root, relative);
    check(path.startsWith(this.root + sep), "INVALID_PATH", "产物路径越界");
    // Reject symlinks in every existing component, including a missing file's ancestors.
    let current = this.root;
    for (const part of relative.split("/")) {
      current = resolve(current, part);
      const info = lstatSync(current, { throwIfNoEntry: false });
      if (info) check(!info.isSymbolicLink(), "INVALID_PATH", "产物路径含符号链接");
    }
    return path;
  }
  writeBlob(value: unknown) {
    const content = json(value), hash = digest(content), relativePath = `artifacts/blobs/${hash}.json`;
    const path = this.path(relativePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) writeFileSync(path, content, { mode: 0o600, flag: "wx" });
    return { id: hash, relativePath, hash, size: Buffer.byteLength(content) };
  }
  readBlob(path: string, hash: string, size: number) {
    const absolute = this.path(path);
    check(lstatSync(absolute).size === size && size <= 16 * 1024 * 1024, "ARTIFACT_MISMATCH", "产物大小不一致或超限");
    const content = readFileSync(absolute);
    check(digest(content) === hash, "ARTIFACT_MISMATCH", "产物摘要不一致");
    return JSON.parse(content.toString("utf8"));
  }
  saveScriptTree(files: SourceFiles, definition?: Omit<ScriptDefinition, "files">) {
    check(files && typeof files === "object" && !Array.isArray(files), "INVALID_SCRIPT", "缺少脚本文件集合");
    const entries = Object.entries(files);
    check(entries.length > 0 && entries.length <= 100, "INVALID_SCRIPT", "脚本文件数量超出限制");
    let total = 0;
    for (const [name, code] of entries) {
      check(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:ts|js|mjs|sh)$/.test(name) && !name.includes(".."), "INVALID_SCRIPT_PATH", `不支持的脚本文件: ${name}`);
      check(typeof code === "string", "INVALID_SCRIPT", `脚本文件不是文本: ${name}`);
      const bytes = Buffer.byteLength(code, "utf8"); check(bytes <= 1024 * 1024, "SCRIPT_LIMIT", `脚本文件超过 1 MiB: ${name}`); total += bytes;
    }
    check(total <= 4 * 1024 * 1024, "SCRIPT_LIMIT", "脚本源码总大小超过 4 MiB");
    const content = canonicalJson({ files: Object.fromEntries(entries.sort()), ...(definition ? { definition } : {}) });
    check(Buffer.byteLength(content) <= 32 * 1024 * 1024, "SCRIPT_LIMIT", "脚本产物编码后超过 32 MiB");
    const hash = digest(content), relative = `artifacts/scripts/${hash}/tree.json`, target = this.path(relative);
    if (!existsSync(target)) {
      const staging = this.path(`staging/${randomUUID()}`); mkdirSync(staging, { recursive: true, mode: 0o700 });
      writeFileSync(resolve(staging, "tree.json"), content, { mode: 0o600 }); mkdirSync(dirname(dirname(target)), { recursive: true, mode: 0o700 });
      try { renameSync(staging, dirname(target)); } catch (error) { rmSync(staging, { recursive: true, force: true }); if (!existsSync(target)) throw error; }
    }
    return { path: relative, hash };
  }
  readScriptTree(path: string): { files: SourceFiles; definition?: Omit<ScriptDefinition, "files"> } {
    check(/^artifacts\/scripts\/[a-f0-9]{64}\/tree\.json$/.test(path), "INVALID_PATH", "脚本产物引用无效");
    const absolute = this.path(path);
    check(lstatSync(absolute).size <= 32 * 1024 * 1024, "ARTIFACT_MISMATCH", "脚本产物超限");
    const text = readFileSync(absolute, "utf8");
    check(digest(text) === path.split("/")[2], "ARTIFACT_MISMATCH", "脚本产物已发生修改");
    const tree = JSON.parse(text); check(tree && tree.files && typeof tree.files === "object", "ARTIFACT_MISMATCH", "脚本产物无效");
    return tree;
  }
  saveTree(files: SourceFiles, compiled: Record<string, string> = {}) {
    checkFiles(files);
    const content = json({ files: Object.fromEntries(Object.entries(files).sort()), compiled: Object.fromEntries(Object.entries(compiled).sort()) });
    const hash = digest(content), relative = `artifacts/trees/${hash}/tree.json`, target = this.path(relative);
    if (!existsSync(target)) {
      const staging = this.path(`staging/${randomUUID()}`);
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      writeFileSync(resolve(staging, "tree.json"), content, { mode: 0o600 });
      mkdirSync(dirname(dirname(target)), { recursive: true, mode: 0o700 });
      try { renameSync(staging, dirname(target)); } catch (error) { rmSync(staging, { recursive: true, force: true }); if (!existsSync(target)) throw error; }
    }
    return { path: relative, hash };
  }
  readTree(path: string): { files: SourceFiles; compiled: Record<string, string> } {
    check(/^artifacts\/trees\/[a-f0-9]{64}\/tree\.json$/.test(path), "INVALID_PATH", "流程产物引用无效");
    const absolute = this.path(path);
    check(lstatSync(absolute).size <= 16 * 1024 * 1024, "ARTIFACT_MISMATCH", "流程产物超限");
    const text = readFileSync(absolute, "utf8");
    check(digest(text) === path.split("/")[2], "ARTIFACT_MISMATCH", "流程产物已发生修改");
    const tree = JSON.parse(text); checkFiles(tree.files); return tree;
  }
}
