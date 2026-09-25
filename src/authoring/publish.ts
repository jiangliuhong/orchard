import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkflowRepository } from "../storage/repository.js";
import { compileWorkflow } from "./compiler.js";

export interface PublishResult { readonly workflowId: string; readonly versionId: string; readonly contentHash: string; readonly bundlePath: string; }

/** Checks, compiles, and records an immutable version. Callers should perform authorization before invoking. */
export async function publishWorkflow(input: { workflows: WorkflowRepository; workflowId: string; rootDir: string; entry: string; outputDir: string; manifest?: Record<string, unknown>; sdkVersion?: string; }): Promise<PublishResult> {
  const build = await compileWorkflow({ rootDir: input.rootDir, entry: input.entry, outputDir: input.outputDir });
  await mkdir(dirname(build.bundlePath), { recursive: true });
  const manifest = { ...build.manifest, ...(input.manifest ?? {}) };
  const versionId = input.workflows.createVersion({ workflowId: input.workflowId, contentHash: build.contentHash, sourcePath: build.sourcePath, bundlePath: build.bundlePath, manifest, sdkVersion: input.sdkVersion ?? "0.1.0" });
  return { workflowId: input.workflowId, versionId, contentHash: build.contentHash, bundlePath: build.bundlePath };
}

export async function writeDraft(rootDir: string, entry: string, source: string): Promise<string> { const path = `${rootDir.replace(/\/$/, "")}/${entry}`; await mkdir(dirname(path), { recursive: true }); await writeFile(path, source, { encoding: "utf8", flag: "wx", mode: 0o600 }); return path; }
