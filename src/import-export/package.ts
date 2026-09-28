import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
