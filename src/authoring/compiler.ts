import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { build } from "esbuild";

export interface WorkflowBuildResult {
  readonly contentHash: string;
  readonly sourcePath: string;
  readonly bundlePath: string;
  readonly manifest: {
    readonly entry: string;
    readonly files: readonly string[];
    readonly contentHash: string;
    readonly sourceTreeHash: string;
    readonly bundleHash: string;
    readonly format: "esm";
    readonly compiler: { readonly name: "esbuild"; readonly version: string };
    readonly capabilities: readonly string[];
  };
}

/** Validate and normalize a path relative to a controlled workspace. */
export function normalizeRelativePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "" && path !== "")) {
    throw new Error(`Unsafe relative path: ${path}`);
  }
  const normalized = path.split("/").filter(Boolean).join("/");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) throw new Error(`Unsafe relative path: ${path}`);
  return normalized;
}

function inside(root: string, target: string): boolean {
  const path = resolve(target);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path === root || path.startsWith(prefix);
}

async function collectFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(current, entry.name);
    const rel = normalizeRelativePath(relative(root, absolute));
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Symlink is not allowed in workflow source: ${rel}`);
    if (info.isDirectory()) files.push(...await collectFiles(root, absolute));
    else if (info.isFile()) files.push(rel);
    else throw new Error(`Unsupported workflow source entry: ${rel}`);
  }
  return files.sort();
}

async function digestFilesAsync(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(await readFile(resolve(root, file))).update("\0");
  return hash.digest("hex");
}

export interface WorkflowSourceValidation {
  readonly files: readonly string[];
  readonly sourceTreeHash: string;
  readonly entry: string;
  readonly capabilities: readonly string[];
}

export async function validateWorkflowSource(options: {
  rootDir: string;
  entry: string;
  allowedImports?: readonly string[];
  allowedCapabilities?: readonly string[];
  requireWorkerEntry?: boolean;
  requireWorkflowContract?: boolean;
}): Promise<WorkflowSourceValidation> {
  const root = await realpath(resolve(options.rootDir));
  const entry = normalizeRelativePath(options.entry);
  if (!entry.endsWith(".ts")) throw new Error("Workflow entry must be a TypeScript file");
  if (options.requireWorkerEntry && entry !== "worker.ts") throw new Error("Workflow entry must be worker.ts");
  const files = await collectFiles(root);
  if (!files.includes(entry)) throw new Error(`Workflow entry does not exist: ${entry}`);
  const allowed = new Set(options.allowedImports ?? ["@jiangliuhong/orchard", "@jiangliuhong/orchard/workflow"]);
  const capabilities = new Set<string>();
  const allowedCapabilities = new Set(options.allowedCapabilities ?? ["workflow", "step", "tool", "trigger"]);
  for (const file of files.filter((item) => /\.(ts|tsx|mts)$/.test(item))) {
    const source = await readFile(resolve(root, file), "utf8");
    if (file === entry && !/(defineWorkflow|export\s+default)/.test(source)) throw new Error(`${entry} must export a workflow definition`);
    if (file === entry && options.requireWorkflowContract && /defineWorkflow\s*\(/.test(source) && !/\binputSchema\b/.test(source)) throw new Error(`${entry} must declare inputSchema`);
    if (file === entry && options.requireWorkflowContract && /defineWorkflow\s*\(/.test(source) && !/\boutputSchema\b/.test(source)) throw new Error(`${entry} must declare outputSchema`);
    if (file === entry && options.requireWorkflowContract && /defineWorkflow\s*\(/.test(source) && !/\brun\s*[:(]/.test(source)) throw new Error(`${entry} must declare a run handler`);
    for (const match of source.matchAll(/from\s+["']([^"']+)["']|import\s*[({]?[\s\S]*?from\s*["']([^"']+)["']/g)) {
      const dependency = match[1] ?? match[2];
      if (dependency?.startsWith(".")) continue;
      if (dependency && ![...allowed].some((prefix) => dependency === prefix || dependency.startsWith(`${prefix}/`))) throw new Error(`Workflow dependency is not allowed: ${dependency}`);
    }
    for (const match of source.matchAll(/\b(?:capability|usesCapability)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const capability = match[1];
      if (capability === undefined) continue;
      if (!allowedCapabilities.has(capability)) throw new Error(`Workflow capability is not allowed: ${capability}`);
      capabilities.add(capability);
    }
  }
  return { files, sourceTreeHash: await digestFilesAsync(root, files), entry, capabilities: [...capabilities].sort() };
}

export async function compileWorkflow(options: { rootDir: string; entry: string; outputDir: string; requireWorkerEntry?: boolean; requireWorkflowContract?: boolean; allowedCapabilities?: readonly string[] }): Promise<WorkflowBuildResult> {
  const root = await realpath(resolve(options.rootDir));
  const requestedEntry = resolve(root, options.entry);
  if (!inside(root, requestedEntry) || !requestedEntry.endsWith(".ts")) throw new Error("Workflow entry must be a TypeScript file inside its workspace");
  const entry = resolve(root, normalizeRelativePath(options.entry));
  const validation = await validateWorkflowSource({
    rootDir: root,
    entry: relative(root, entry),
    ...(options.requireWorkerEntry === undefined ? {} : { requireWorkerEntry: options.requireWorkerEntry }),
    ...(options.requireWorkflowContract === undefined ? {} : { requireWorkflowContract: options.requireWorkflowContract }),
    ...(options.allowedCapabilities === undefined ? {} : { allowedCapabilities: options.allowedCapabilities }),
  });
  const source = await readFile(entry);
  const contentHash = createHash("sha256").update(source).digest("hex");
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const bundlePath = resolve(outputDir, `${contentHash}.mjs`);
  if (!inside(outputDir, bundlePath)) throw new Error("Workflow output escaped its output directory");
  await build({ entryPoints: [entry], outfile: bundlePath, bundle: true, format: "esm", platform: "node", target: "node24", sourcemap: false, external: ["@jiangliuhong/orchard", "@jiangliuhong/orchard/*"], logLevel: "silent" });
  const bundle = await readFile(bundlePath);
  return {
    contentHash,
    sourcePath: entry,
    bundlePath,
    manifest: {
      entry: relative(root, entry), files: validation.files, contentHash,
      sourceTreeHash: validation.sourceTreeHash, bundleHash: createHash("sha256").update(bundle).digest("hex"),
      format: "esm", compiler: { name: "esbuild", version: "0.25.12" }, capabilities: validation.capabilities,
    },
  };
}
