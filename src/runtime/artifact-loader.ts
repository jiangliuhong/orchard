import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export interface RuntimeArtifactManifest {
  readonly entry: string;
  readonly bundleHash: string;
  readonly sourceTreeHash?: string;
  readonly files?: readonly { path: string; hash: string; size: number }[];
  readonly appId?: string;
  readonly workflowId?: string;
  readonly versionId?: string;
}

function inside(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix);
}

function hash(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }

/** Load only a registered bundle beneath the instance artifact root. */
export async function loadRegisteredBundle(input: {
  instanceRoot: string;
  artifactPath: string;
  manifest: RuntimeArtifactManifest;
  appId?: string;
  workflowId?: string;
  versionId?: string;
}): Promise<{ readonly module: Record<string, unknown>; readonly bundlePath: string }> {
  const root = await realpath(resolve(input.instanceRoot, "artifacts"));
  const artifact = resolve(input.instanceRoot, input.artifactPath);
  if (!inside(root, artifact)) throw new Error("Registered artifact path escaped instance root");
  const manifestPath = resolve(artifact, "manifest.json");
  if (!inside(root, manifestPath)) throw new Error("Registered manifest path escaped instance root");
  const onDiskManifest = JSON.parse(await readFile(manifestPath, "utf8")) as RuntimeArtifactManifest;
  for (const [key, expected] of [["appId", input.appId], ["workflowId", input.workflowId], ["versionId", input.versionId]] as const) {
    if (expected !== undefined && onDiskManifest[key] !== undefined && onDiskManifest[key] !== expected) throw new Error(`Artifact ${key} mismatch`);
  }
  if (onDiskManifest.bundleHash !== input.manifest.bundleHash) throw new Error("Artifact manifest mismatch");
  const bundlePath = resolve(artifact, "bundle", "worker.mjs");
  if (!inside(root, bundlePath) || relative(root, bundlePath).includes("..")) throw new Error("Bundle path escaped instance root");
  const bundle = await readFile(bundlePath);
  if (hash(bundle) !== input.manifest.bundleHash) throw new Error("Artifact bundle digest mismatch");
  const loaded = await import(`file://${bundlePath}`) as Record<string, unknown>;
  return { module: loaded, bundlePath };
}
