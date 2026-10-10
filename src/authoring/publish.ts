import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { WorkflowRepository } from "../storage/repository.js";
import { ArtifactStore } from "../artifacts/store.js";
import { compileWorkflow } from "./compiler.js";
import { readSourceConfiguration, sourceReadOnly } from "./source-configuration.js";

export interface PublishResult { readonly workflowId: string; readonly versionId: string; readonly contentHash: string; readonly bundlePath: string; }

/**
 * Compile first and activate only after validation succeeds. Every publication
 * retains immutable source and bundle copies in the artifact store.
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
  for (const key of ["name", "description", "triggers", "policy", "concurrency", "executionConfig", "definition"]) {
    if (input.manifest && Object.hasOwn(input.manifest, key)) throw sourceReadOnly();
  }
  const build = await compileWorkflow({
    rootDir: input.rootDir,
    entry: input.entry,
    outputDir: input.outputDir,
    ...(input.artifactStore === undefined ? {} : { requireWorkerEntry: input.entry === "worker.ts", requireWorkflowContract: input.entry === "worker.ts" }),
  });
  readSourceConfiguration(input.entry, await readFile(build.sourcePath, "utf8"));
  // Definition and compiler metadata cannot be overridden by manifest callers.
  const manifest = { ...(input.manifest ?? {}), ...build.manifest };
  const artifactStore = input.artifactStore ?? new ArtifactStore(input.workflows.instanceRoot);
  const appId = input.appId ?? "orchard";

  const versionId = uuidv7();
  const artifact = await artifactStore.publishWorkflowVersion({
    appId,
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
      manifest: { ...manifest, sourceTreeHash: artifact.sourceTreeHash, bundleHash: artifact.bundleHash, artifactPath: artifact.relativePath, manifestPath: artifact.manifestPath },
      sdkVersion: input.sdkVersion ?? "0.1.0",
      artifactHash: artifact.bundleHash,
    });
  } catch (error) {
    await artifactStore.markOrphanCandidate(artifact.relativePath);
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
