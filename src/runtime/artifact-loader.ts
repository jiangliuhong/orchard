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
  const artifactCandidate = resolve(input.instanceRoot, input.artifactPath);
  // Resolve every directory before reading it. A path that lexically sits
  // below artifacts can still escape through a symlink.
  const artifact = await realpath(artifactCandidate);
  if (!inside(root, artifact)) throw new Error("Registered artifact path escaped instance root");
  const manifestPath = await realpath(resolve(artifact, "manifest.json"));
  if (!inside(artifact, manifestPath)) throw new Error("Registered manifest path escaped artifact root");
  const onDiskManifest = JSON.parse(await readFile(manifestPath, "utf8")) as RuntimeArtifactManifest;
  for (const [key, expected] of [["appId", input.appId], ["workflowId", input.workflowId], ["versionId", input.versionId]] as const) {
    if (expected !== undefined && onDiskManifest[key] !== undefined && onDiskManifest[key] !== expected) throw new Error(`Artifact ${key} mismatch`);
  }
  const expectedEntry = input.manifest.entry.startsWith("source/") ? input.manifest.entry : `source/${input.manifest.entry}`;
  if ((onDiskManifest.entry !== undefined && onDiskManifest.entry !== expectedEntry) || onDiskManifest.bundleHash !== input.manifest.bundleHash) throw new Error("Artifact manifest mismatch");
  if (input.manifest.sourceTreeHash !== undefined && onDiskManifest.sourceTreeHash !== input.manifest.sourceTreeHash) throw new Error("Artifact source tree mismatch");
  const bundlePath = await realpath(resolve(artifact, "bundle", "worker.mjs"));
  if (!inside(artifact, bundlePath) || !inside(root, bundlePath)) throw new Error("Bundle path escaped instance root");
  const bundle = await readFile(bundlePath);
  if (hash(bundle) !== input.manifest.bundleHash || hash(bundle) !== onDiskManifest.bundleHash) throw new Error("Artifact bundle digest mismatch");
  if (onDiskManifest.files) {
    for (const file of onDiskManifest.files) {
      if (!file.path.startsWith("source/") || file.path.includes("..")) throw new Error("Artifact manifest contains an unsafe source path");
      const sourcePath = await realpath(resolve(artifact, file.path));
      if (!inside(artifact, sourcePath)) throw new Error("Artifact source path escaped artifact root");
      const source = await readFile(sourcePath);
      if (source.byteLength !== file.size || hash(source) !== file.hash) throw new Error(`Artifact source digest mismatch: ${file.path}`);
    }
  }
  const loaded = await import(`file://${bundlePath}`) as Record<string, unknown>;
  return { module: loaded, bundlePath };
}
