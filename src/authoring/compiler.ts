import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { build } from "esbuild";

export interface WorkflowBuildResult {
  readonly contentHash: string;
  readonly sourcePath: string;
  readonly bundlePath: string;
  readonly manifest: { readonly entry: string; readonly files: readonly string[]; readonly contentHash: string; readonly format: "esm" };
}

function inside(root: string, target: string): boolean {
  const path = resolve(target);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path === root || path.startsWith(prefix);
}

export async function compileWorkflow(options: { rootDir: string; entry: string; outputDir: string }): Promise<WorkflowBuildResult> {
  const root = await realpath(resolve(options.rootDir));
  const entry = resolve(root, options.entry);
  if (!inside(root, entry) || !entry.endsWith(".ts")) throw new Error("Workflow entry must be a TypeScript file inside its workspace");
  const source = await readFile(entry);
  const contentHash = createHash("sha256").update(source).digest("hex");
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const bundlePath = resolve(outputDir, `${contentHash}.mjs`);
  if (!inside(outputDir, bundlePath)) throw new Error("Workflow output escaped its output directory");
  await build({
    entryPoints: [entry],
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: false,
    external: ["@jiangliuhong/orchard", "@jiangliuhong/orchard/*"],
    logLevel: "silent",
  });
  return {
    contentHash,
    sourcePath: entry,
    bundlePath,
    manifest: { entry: relative(root, entry), files: [relative(root, entry)], contentHash, format: "esm" },
  };
}
