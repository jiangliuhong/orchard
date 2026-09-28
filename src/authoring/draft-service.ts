import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ArtifactStore } from "../artifacts/store.js";
import type { WorkflowRepository } from "../storage/repository.js";
import { compileWorkflow, type WorkflowBuildResult } from "./compiler.js";
import { publishWorkflow, type PublishResult } from "./publish.js";

export interface DraftServiceInput {
  readonly workflows: WorkflowRepository;
  readonly workspaceRoot: string;
  readonly artifactStore?: ArtifactStore;
  readonly appId?: string;
}

export class WorkflowDraftService {
  constructor(private readonly input: DraftServiceInput) {}

  create(input: { workspaceId: string; workflowId?: string; baseVersionId?: string }): string {
    const root = join(resolve(this.input.workspaceRoot), "drafts");
    return this.input.workflows.createDraft({ workspaceId: input.workspaceId, ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }), ...(input.baseVersionId === undefined ? {} : { baseVersionId: input.baseVersionId }), rootPath: root });
  }

  async update(input: { draftId: string; revision: number; files: Readonly<Record<string, string>>; contentHash?: string }): Promise<boolean> {
    const root = resolve(this.input.workspaceRoot, "drafts", input.draftId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const [path, content] of Object.entries(input.files)) {
      if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`Unsafe draft path: ${path}`);
      const target = resolve(root, path);
      if (!target.startsWith(`${root}/`)) throw new Error(`Unsafe draft path: ${path}`);
      await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    }
    return this.input.workflows.updateDraft(input.draftId, { revision: input.revision, ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }), status: "draft" });
  }

  async compile(input: { rootDir: string; entry?: string; outputDir: string }): Promise<WorkflowBuildResult> {
    return compileWorkflow({ rootDir: input.rootDir, entry: input.entry ?? "worker.ts", outputDir: input.outputDir, requireWorkerEntry: input.entry === undefined || input.entry === "worker.ts" });
  }

  async publish(input: { workflowId: string; rootDir: string; outputDir: string; entry?: string; sdkVersion?: string }): Promise<PublishResult> {
    return publishWorkflow({ workflows: this.input.workflows, workflowId: input.workflowId, rootDir: input.rootDir, entry: input.entry ?? "worker.ts", outputDir: input.outputDir, ...(input.sdkVersion === undefined ? {} : { sdkVersion: input.sdkVersion }), ...(this.input.artifactStore === undefined ? {} : { artifactStore: this.input.artifactStore }), ...(this.input.appId === undefined ? {} : { appId: this.input.appId }) });
  }

  async readSource(rootDir: string, path = "worker.ts"): Promise<string> { return readFile(resolve(rootDir, path), "utf8"); }
}
