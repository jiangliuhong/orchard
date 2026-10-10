import type { JsonSchema, WorkflowDefinition, WorkflowContext, StepRequest, WorkflowExecutionPolicy, WorkflowTrigger } from "../core/contracts.js";
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
  RunCommand,
  WorkflowExecutionPolicy,
  WorkflowRetryPolicy,
  WorkflowTrigger,
} from "../core/contracts.js";
export { NodeRegistry, ToolRegistry, TriggerRegistry } from "../core/registry.js";
export { assertValidJson, validateJson } from "../core/validation.js";

export interface WorkflowDefinitionOptions<Input, Output> {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly triggers?: readonly WorkflowTrigger[];
  readonly policy?: WorkflowExecutionPolicy;
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
  if (options.triggers !== undefined) {
    const triggerTypes = new Set(["event", "cron", "manual", "invoke"]);
    const seen = new Set<string>();
    for (const trigger of options.triggers) {
      if (!triggerTypes.has(trigger.type)) throw new Error(`Unsupported workflow trigger: ${trigger.type}`);
      if (seen.has(trigger.type)) throw new Error(`Duplicate workflow trigger: ${trigger.type}`);
      seen.add(trigger.type);
    }
  }
  const policy = options.policy;
  if (policy?.timeoutMs !== undefined && (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 1)) throw new Error("Workflow timeoutMs must be a positive integer");
  if (policy?.retry !== undefined && (!Number.isInteger(policy.retry.maxAttempts) || policy.retry.maxAttempts < 1)) throw new Error("Workflow retry maxAttempts must be a positive integer");
  if (policy?.retry?.initialDelayMs !== undefined && policy.retry.initialDelayMs < 0) throw new Error("Workflow retry initialDelayMs cannot be negative");
  if (policy?.retry?.maxDelayMs !== undefined && policy.retry.maxDelayMs < 0) throw new Error("Workflow retry maxDelayMs cannot be negative");
  if (policy?.rateLimit !== undefined && (!Number.isInteger(policy.rateLimit.limit) || policy.rateLimit.limit < 1 || !Number.isInteger(policy.rateLimit.periodMs) || policy.rateLimit.periodMs < 1)) throw new Error("Workflow rateLimit must use positive integers");
  if (policy?.throttle !== undefined && (!Number.isInteger(policy.throttle.limit) || policy.throttle.limit < 1 || !Number.isInteger(policy.throttle.periodMs) || policy.throttle.periodMs < 1)) throw new Error("Workflow throttle must use positive integers");
  if (policy?.concurrencyKey !== undefined && (!policy.concurrencyKey.trim() || policy.concurrencyKey.length > 200)) throw new Error("Workflow concurrencyKey must be a non-empty string");
  if (policy?.debounceMs !== undefined && (!Number.isInteger(policy.debounceMs) || policy.debounceMs < 1)) throw new Error("Workflow debounceMs must be a positive integer");
  if (policy?.singleton !== undefined && (!policy.singleton.key.trim() || !["skip", "cancel"].includes(policy.singleton.mode))) throw new Error("Invalid workflow singleton policy");
  if (policy?.cancelOn !== undefined) {
    if (!Array.isArray(policy.cancelOn) || policy.cancelOn.some((condition) => !condition || typeof condition.event !== "string" || !condition.event.trim() || (condition.field !== undefined && !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z0-9_$]+)*$/.test(condition.field)))) throw new Error("Invalid workflow cancelOn condition");
  }
  if (policy?.batching !== undefined) throw new Error("Workflow batching is not supported until durable batch storage is approved");
  return Object.freeze({ ...options, ...(policy === undefined ? {} : { policy: Object.freeze({ ...policy, ...(policy.retry === undefined ? {} : { retry: Object.freeze({ ...policy.retry }) }) }) }) });
}

/** Creates a step context for runtime adapters and enforces unique step ids per run. */
export interface WorkflowContextOperations {
  readonly sleep?: (durationOrId: number | string, durationMs?: number) => Promise<void>;
  readonly sleepUntil?: (atOrId: Date | number | string, at?: Date | number) => Promise<void>;
  readonly waitForEvent?: <T>(eventName: string, options?: { id?: string; timeoutMs?: number; key?: string }) => Promise<T>;
  readonly sendEvent?: (eventName: string, data: unknown, options?: { id?: string }) => Promise<string>;
  readonly invokeWorkflow?: <T>(workflowId: string, input: unknown, options?: { id?: string; idempotencyKey?: string }) => Promise<T>;
}

export function createWorkflowContext(runId: string, signal: AbortSignal, execute: <T>(stepId: string, request: StepRequest) => Promise<T>, operations: WorkflowContextOperations = {}): WorkflowContext {
  const occurrences = new Map<string, number>();
  const unavailable = (name: string): never => { throw new Error(`${name} is not available outside a durable runtime`); };
  const run = async <T>(stepId: string, request: StepRequest): Promise<T> => {
    signal.throwIfAborted();
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(stepId)) throw new Error(`Invalid step id: ${stepId}`);
    const occurrence = occurrences.get(stepId) ?? 0;
    occurrences.set(stepId, occurrence + 1);
    const stableStepId = occurrence === 0 ? stepId : `${stepId}:${occurrence}`;
    return execute<T>(stableStepId, request);
  };
  return {
    runId,
    signal,
    step: {
      execute: run,
      run,
      sleep: operations.sleep ?? (async (durationOrId, maybeDuration) => { const durationMs = typeof durationOrId === "string" ? maybeDuration : durationOrId; if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) throw new Error("Sleep duration must be non-negative"); await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, durationMs); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); }); }),
      sleepUntil: operations.sleepUntil ?? (async (atOrId, maybeAt) => { const at = typeof atOrId === "string" ? maybeAt : atOrId; if (at === undefined) throw new Error("Sleep deadline is required"); const target = typeof at === "number" ? at : at instanceof Date ? at.getTime() : NaN; await (operations.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(Math.max(0, target - Date.now())); }),
      waitForEvent: operations.waitForEvent ?? (async () => unavailable("waitForEvent")),
      sendEvent: operations.sendEvent ?? (async () => unavailable("sendEvent")),
      invokeWorkflow: operations.invokeWorkflow ?? (async () => unavailable("invokeWorkflow")),
    },
  };
}

export function validateWorkflowInput<Input>(workflow: WorkflowDefinition<Input, unknown>, input: unknown): asserts input is Input {
  assertValidJson(input, workflow.inputSchema, `Workflow ${workflow.id} input`);
}
