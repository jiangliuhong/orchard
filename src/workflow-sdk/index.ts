import type { JsonSchema, WorkflowDefinition, WorkflowContext, StepRequest } from "../core/contracts.js";
import { assertValidJson } from "../core/validation.js";
import type { Static, TSchema } from "@sinclair/typebox";
export { Type } from "@sinclair/typebox";
export type { Static, TSchema } from "@sinclair/typebox";

export type {
  JsonSchema,
  NodeContext,
  NodeExecutor,
  SideEffectClass,
  StepRequest,
  ToolAdapter,
  ToolContext,
  TriggerAdapter,
  TriggerContext,
  WorkflowContext,
  WorkflowDefinition,
} from "../core/contracts.js";
export { NodeRegistry, ToolRegistry, TriggerRegistry } from "../core/registry.js";
export { assertValidJson, validateJson } from "../core/validation.js";

export interface WorkflowDefinitionOptions<Input, Output> {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly concurrency?: number;
  readonly run: (context: WorkflowContext, input: Input) => Promise<Output>;
}

export function defineWorkflow<Input extends TSchema, Output extends TSchema>(
  options: Omit<WorkflowDefinitionOptions<Static<Input>, Static<Output>>, "inputSchema" | "outputSchema"> & {
    readonly inputSchema: Input;
    readonly outputSchema: Output;
  },
): WorkflowDefinition<Static<Input>, Static<Output>>;
export function defineWorkflow<Input, Output>(options: WorkflowDefinitionOptions<Input, Output>): WorkflowDefinition<Input, Output>;
export function defineWorkflow<Input, Output>(options: WorkflowDefinitionOptions<Input, Output>): WorkflowDefinition<Input, Output> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(options.id)) throw new Error(`Invalid workflow id: ${options.id}`);
  if (!options.name.trim()) throw new Error("Workflow name cannot be empty");
  if (options.concurrency !== undefined && (!Number.isInteger(options.concurrency) || options.concurrency < 1)) {
    throw new Error("Workflow concurrency must be a positive integer");
  }
  return Object.freeze({ ...options });
}

/** Creates a step context for runtime adapters and enforces unique step ids per run. */
export function createWorkflowContext(runId: string, signal: AbortSignal, execute: <T>(stepId: string, request: StepRequest) => Promise<T>): WorkflowContext {
  const used = new Set<string>();
  return {
    runId,
    signal,
    step: {
      execute: async <T>(stepId: string, request: StepRequest): Promise<T> => {
        signal.throwIfAborted();
        if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(stepId)) throw new Error(`Invalid step id: ${stepId}`);
        if (used.has(stepId)) throw new Error(`Duplicate step id in run: ${stepId}`);
        used.add(stepId);
        return execute<T>(stepId, request);
      },
    },
  };
}

export function validateWorkflowInput<Input>(workflow: WorkflowDefinition<Input, unknown>, input: unknown): asserts input is Input {
  assertValidJson(input, workflow.inputSchema, `Workflow ${workflow.id} input`);
}
