import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { readSourceConfiguration } from "../authoring/source-configuration.js";
import type { SourceConfiguration } from "../authoring/source-configuration.js";
import { describeWorkflowSource } from "../authoring/source-descriptions.js";
import type { WorkflowRecord, WorkflowVersionRecord } from "../storage/repository.js";

export interface WorkflowSourceFile { path: string; code: string; }
export interface WorkflowStepDescription { id: string; type: string; description: string; file: string; line: number; }
export interface WorkflowDetail {
  workflow: Pick<WorkflowRecord, "id" | "name" | "status"> & { description?: string };
  version: { id: string; number: number; createdAt: number } | null;
  entry: string | null;
  files: WorkflowSourceFile[];
  steps: WorkflowStepDescription[];
  definition?: SourceConfiguration;
  sourceWarning?: string;
}

/** Describe source declarations without importing or executing workflow code. */
export function describeWorkflowSteps(file: WorkflowSourceFile): WorkflowStepDescription[] {
  return describeWorkflowSource(file.path, file.code).steps;
}

function inside(root: string, target: string): boolean { return target === root || target.startsWith(root + sep); }
function safePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe source path");
  return path;
}

export async function readWorkflowDetail(instanceRoot: string, workflow: WorkflowRecord, version?: WorkflowVersionRecord): Promise<WorkflowDetail> {
  const detail: WorkflowDetail = { workflow: { id: workflow.id, name: workflow.id, status: workflow.status }, version: version ? { id: version.id, number: version.versionNo, createdAt: version.createdAt } : null, entry: null, files: [], steps: [] };
  if (!version) return detail;
  try {
    const root = await realpath(instanceRoot);
    const source = await realpath(resolve(root, version.sourcePath));
    if (!inside(root, source)) throw new Error("Source outside instance");
    const manifest = version.manifest as { entry?: string; files?: (string | { path: string })[] };
    const entry = safePath((manifest.entry ?? "worker.ts").replace(/^source\//, ""));
    const directory = (await stat(source)).isDirectory();
    const sourceRoot = directory ? source : await realpath(resolve(source, ...entry.split("/").map(() => "..")));
    if (!inside(root, sourceRoot)) throw new Error("Source root outside instance");
    const names = [...new Set([entry, ...(manifest.files ?? []).map(file => typeof file === "string" ? file : file.path)])]
      .filter(name => /\.(?:ts|tsx|mts|js|mjs|md)$/.test(name));
    if (names.length > 100) throw new Error("Too many source files");
    const files: WorkflowSourceFile[] = [];
    let bytes = 0;
    for (const name of names) {
      const path = safePath(name.replace(/^source\//, ""));
      const target = await realpath(resolve(sourceRoot, path));
      if (!inside(sourceRoot, target)) throw new Error("Source escaped root");
      const info = await stat(target);
      bytes += info.size;
      if (!info.isFile() || info.size > 1024 * 1024 || bytes > 4 * 1024 * 1024) throw new Error("Source exceeds limit");
      files.push({ path, code: await readFile(target, "utf8") });
    }
    detail.entry = entry;
    detail.files = files;
    detail.steps = files.filter(file => !file.path.endsWith(".md")).flatMap(describeWorkflowSteps);
    const entryFile = files.find(file => file.path === entry);
    if (entryFile) {
      const config = readSourceConfiguration(entryFile.path, entryFile.code);
      detail.definition = config;
      detail.workflow = { ...detail.workflow, name: config.name ?? workflow.id, ...(config.description === undefined ? {} : { description: config.description }) };
    }
    if (entryFile && /^[a-f0-9]{64}$/.test(version.contentHash) && createHash("sha256").update(entryFile.code).digest("hex") !== version.contentHash) {
      detail.sourceWarning = "源码文件已发生修改，下面展示的代码可能与已发布版本不同。";
    }
  } catch {
    detail.sourceWarning = "当前版本的源码不可用，或不在允许读取的目录内。";
  }
  return detail;
}
