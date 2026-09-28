import { loadRegisteredBundle, type RuntimeArtifactManifest } from "./artifact-loader.js";

export interface RegisteredWorkflowContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly step: <T>(stepKey: string, input: unknown) => Promise<T>;
  readonly invokeTool: <T>(toolId: string, input: unknown) => Promise<T>;
}

export interface RegisteredWorkflowExecution {
  readonly appId: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly artifactPath: string;
  readonly manifest: RuntimeArtifactManifest;
  readonly input: unknown;
}

/** Execute only the database-registered compiled worker module. */
export async function executeRegisteredWorkflow<T>(instanceRoot: string, execution: RegisteredWorkflowExecution, context: RegisteredWorkflowContext): Promise<T> {
  const loaded = await loadRegisteredBundle({ instanceRoot, artifactPath: execution.artifactPath, manifest: execution.manifest, appId: execution.appId, workflowId: execution.workflowId, versionId: execution.versionId });
  const candidate = loaded.module.default ?? loaded.module.workflow ?? loaded.module.run;
  if (typeof candidate !== "function") throw new Error("Registered worker bundle does not export a workflow function");
  context.signal.throwIfAborted();
  return await (candidate as (context: RegisteredWorkflowContext, input: unknown) => Promise<T> | T)(context, execution.input);
}
