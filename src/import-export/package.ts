import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeRelativePath } from "../authoring/compiler.js";

export interface WorkflowExportPackage {
  readonly format: "orchard-workflow";
  readonly formatVersion: 1;
  readonly app: { readonly id: string; readonly name?: string };
  readonly workflow: { readonly id: string; readonly name?: string };
  readonly version: { readonly id: string; readonly number: number; readonly manifest: unknown };
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly contentBase64: string }>>;
  readonly dependencies?: readonly string[];
  readonly triggers?: readonly unknown[];
}

function hash(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }

export async function createWorkflowExport(input: {
  app: WorkflowExportPackage["app"];
  workflow: WorkflowExportPackage["workflow"];
  version: WorkflowExportPackage["version"];
  files: Readonly<Record<string, Buffer>>;
  dependencies?: readonly string[];
  triggers?: readonly unknown[];
}): Promise<WorkflowExportPackage> {
  const files: Record<string, { sha256: string; contentBase64: string }> = {};
  for (const [path, content] of Object.entries(input.files)) {
    const normalized = normalizeRelativePath(path);
    files[normalized] = { sha256: hash(content), contentBase64: content.toString("base64") };
  }
  return {
    format: "orchard-workflow", formatVersion: 1, app: input.app, workflow: input.workflow,
    version: input.version, files,
    ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
    ...(input.triggers === undefined ? {} : { triggers: input.triggers }),
  };
}

export function validateWorkflowExport(value: unknown): WorkflowExportPackage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workflow export package");
  const pkg = value as Partial<WorkflowExportPackage>;
  if (pkg.format !== "orchard-workflow" || pkg.formatVersion !== 1 || !pkg.files || typeof pkg.files !== "object" || !pkg.app || !pkg.workflow || !pkg.version) throw new Error("Unsupported workflow export package");
  const checked: Record<string, { sha256: string; contentBase64: string }> = {};
  for (const [path, item] of Object.entries(pkg.files)) {
    const normalized = normalizeRelativePath(path);
    if (normalized !== path || !item || typeof item.sha256 !== "string" || typeof item.contentBase64 !== "string") throw new Error(`Invalid exported file: ${path}`);
    const content = Buffer.from(item.contentBase64, "base64");
    if (hash(content) !== item.sha256) throw new Error(`Export digest mismatch: ${path}`);
    checked[path] = { sha256: item.sha256, contentBase64: item.contentBase64 };
  }
  if (!Object.hasOwn(checked, "source/worker.ts") && !Object.hasOwn(checked, "worker.ts")) throw new Error("Export is missing worker.ts");
  return { ...pkg, files: checked } as WorkflowExportPackage;
}

export async function writeWorkflowExport(path: string, pkg: WorkflowExportPackage): Promise<void> {
  const validated = validateWorkflowExport(pkg);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(validated, null, 2), { mode: 0o600 });
}

export async function readWorkflowExport(path: string): Promise<WorkflowExportPackage> {
  return validateWorkflowExport(JSON.parse(await readFile(path, "utf8")));
}

export async function stageWorkflowExport(root: string, pkg: WorkflowExportPackage): Promise<string> {
  const validated = validateWorkflowExport(pkg);
  const staging = join(resolve(root), "tmp", `import-${validated.version.id}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  for (const [path, item] of Object.entries(validated.files)) {
    const target = resolve(staging, path);
    if (!target.startsWith(`${staging}/`)) throw new Error(`Import path escaped staging root: ${path}`);
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, Buffer.from(item.contentBase64, "base64"), { flag: "wx", mode: 0o600 });
  }
  return staging;
}

/**
 * Atomically publish an already validated import and then persist its database
 * metadata. The callback is expected to use one SQLite transaction; if it
 * fails, the old activation pointer remains untouched and the moved directory
 * is recorded as an orphan candidate for delayed GC.
 */
export async function publishWorkflowImport(input: {
  instanceRoot: string;
  pkg: WorkflowExportPackage;
  persist: (published: { readonly artifactPath: string; readonly sourcePath: string; readonly bundlePath?: string }) => void | Promise<void>;
}): Promise<{ readonly artifactPath: string; readonly sourcePath: string; readonly bundlePath?: string }> {
  const pkg = validateWorkflowExport(input.pkg);
  for (const id of [pkg.app.id, pkg.workflow.id, pkg.version.id]) {
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") throw new Error(`Unsafe import identity: ${id}`);
  }
  const root = resolve(input.instanceRoot);
  const staging = await stageWorkflowExport(root, pkg);
  const artifactPath = `artifacts/${pkg.app.id}/${pkg.workflow.id}/${pkg.version.id}`;
  const destination = resolve(root, artifactPath);
  if (!destination.startsWith(`${resolve(root, "artifacts")}/`)) throw new Error("Import artifact path escaped instance root");
  try {
    await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
    await rename(staging, destination);
    const published = {
      artifactPath,
      sourcePath: `${artifactPath}/source`,
      ...(Object.hasOwn(pkg.files, "bundle/worker.mjs") || Object.hasOwn(pkg.files, "source/bundle/worker.mjs") ? { bundlePath: `${artifactPath}/bundle/worker.mjs` } : {}),
    };
    try {
      await input.persist(published);
    } catch (error) {
      const marker = resolve(root, "tmp", "orphan-candidates.json");
      let candidates: Record<string, number> = {};
      try { candidates = JSON.parse(await readFile(marker, "utf8")) as Record<string, number>; } catch { /* first candidate */ }
      candidates[artifactPath] = Date.now();
      await writeFile(marker, JSON.stringify(candidates), { mode: 0o600 });
      throw error;
    }
    return published;
  } catch (error) {
    // Before rename the staging directory is safe to remove. After rename it
    // must remain available for orphan reconciliation.
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
