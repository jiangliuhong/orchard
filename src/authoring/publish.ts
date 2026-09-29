import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { WorkflowRepository } from "../storage/repository.js";
import { ArtifactStore } from "../artifacts/store.js";
import { compileWorkflow } from "./compiler.js";

export interface PublishResult { readonly workflowId: string; readonly versionId: string; readonly contentHash: string; readonly bundlePath: string; }

/**
 * Compile first and activate only after all validation has succeeded. The
 * legacy output-directory mode is retained for callers that do not yet use the
 * controlled artifact store.
 */
export async function publishWorkflow(input: {
  workflows: WorkflowRepository;
  workflowId: string;
  rootDir: string;
  entry: string;
  outputDir: string;
  manifest?: Record<string, unknown>;
  sdkVersion?: string;
  artifactStore?: ArtifactStore;
  appId?: string;
}): Promise<PublishResult> {
  const build = await compileWorkflow({
    rootDir: input.rootDir,
    entry: input.entry,
    outputDir: input.outputDir,
    ...(input.artifactStore === undefined ? {} : { requireWorkerEntry: input.entry === "worker.ts", requireWorkflowContract: input.entry === "worker.ts" }),
  });
  const manifest = { ...build.manifest, ...(input.manifest ?? {}) };
  if (!input.artifactStore || !input.appId) {
    await mkdir(dirname(build.bundlePath), { recursive: true });
    const versionId = input.workflows.createVersion({ workflowId: input.workflowId, contentHash: build.contentHash, sourcePath: build.sourcePath, bundlePath: build.bundlePath, manifest, sdkVersion: input.sdkVersion ?? "0.1.0" });
    return { workflowId: input.workflowId, versionId, contentHash: build.contentHash, bundlePath: build.bundlePath };
  }

  const versionId = uuidv7();
  const artifact = await input.artifactStore.publishWorkflowVersion({
    appId: input.appId,
    workflowId: input.workflowId,
    versionId,
    sourceDir: resolve(input.rootDir),
    bundlePath: build.bundlePath,
    manifest,
  });
  try {
    const relativeSource = `${artifact.relativePath}/source`;
    const relativeBundle = `${artifact.relativePath}/bundle/worker.mjs`;
    input.workflows.createVersion({
      id: versionId,
      workflowId: input.workflowId,
      contentHash: build.contentHash,
      sourcePath: relativeSource,
      bundlePath: relativeBundle,
      manifest: { ...manifest, artifactPath: artifact.relativePath, manifestPath: artifact.manifestPath },
      sdkVersion: input.sdkVersion ?? "0.1.0",
    });
  } catch (error) {
    await input.artifactStore.markOrphanCandidate(artifact.relativePath);
    throw error;
  }
  return { workflowId: input.workflowId, versionId, contentHash: build.contentHash, bundlePath: `${artifact.relativePath}/bundle/worker.mjs` };
}

export async function writeDraft(rootDir: string, entry: string, source: string): Promise<string> {
  const path = `${rootDir.replace(/\/$/, "")}/${entry}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}
