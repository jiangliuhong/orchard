/** Serializable command shared by event, manual, cron, and child-run entry points. */
export interface RunCommand {
  readonly trigger: { readonly type: "event" | "cron" | "manual" | "invoke"; readonly id: string; readonly workflowId: string; readonly workflowVersionId: string };
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly parentRunId?: string;
  readonly event?: { readonly source: string; readonly id: string; readonly name: string; readonly data: unknown };
}

export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "sleeping"
  | "retrying"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "interrupted"
  | "needs_review";

export type StepStatus = "queued" | "running" | "waiting" | "sleeping" | "retrying" | "succeeded" | "failed" | "cancelled" | "needs_review";
export type SideEffectClass = "read_only" | "idempotent" | "non_idempotent" | "unknown";

/** JSON Schema draft-07; runtime validation rejects unsupported keywords. */
export type JsonSchema = boolean | Readonly<Record<string, unknown>>;

export interface NodeContext {
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly signal: AbortSignal;
  readonly log: (message: string, metadata?: Readonly<Record<string, unknown>>) => void;
}

export interface ToolContext extends NodeContext {
  readonly invoke: <Input, Output>(toolId: string, input: Input) => Promise<Output>;
}

export interface TriggerContext {
  readonly workspaceId: string;
  readonly signal: AbortSignal;
}

export interface ToolAdapter<Input = unknown, Output = unknown> {
  readonly type: string;
  readonly version: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly sideEffects: SideEffectClass;
  execute(context: ToolContext, input: Input): Promise<Output>;
}

export interface TriggerAdapter<Config = unknown> {
  readonly type: string;
  readonly configSchema: JsonSchema;
  start(context: TriggerContext, config: Config): Promise<{ stop: () => Promise<void> }>;
}

export interface NodeExecutor<Config = unknown, Input = unknown, Output = unknown> {
  readonly type: string;
  readonly version: string;
  readonly configSchema: JsonSchema;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly sideEffects?: SideEffectClass;
  execute(context: NodeContext, config: Config, input: Input): Promise<Output>;
}

export interface StepRequest {
  /** Human-readable documentation, read statically from workflow source. */
  readonly description?: string;
  readonly type: string;
  readonly config: unknown;
  readonly input: unknown;
}

export interface WorkflowContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly step: {
    execute<T = unknown>(stepId: string, request: StepRequest): Promise<T>;
    run<T = unknown>(stepId: string, request: StepRequest): Promise<T>;
    sleep(durationOrId: number | string, durationMs?: number): Promise<void>;
    sleepUntil(atOrId: Date | number | string, at?: Date | number): Promise<void>;
    waitForEvent<T = unknown>(eventName: string, options?: { id?: string; timeoutMs?: number; key?: string }): Promise<T>;
    sendEvent(eventName: string, data: unknown, options?: { id?: string }): Promise<string>;
    invokeWorkflow<T = unknown>(workflowId: string, input: unknown, options?: { id?: string; idempotencyKey?: string }): Promise<T>;
  };
}

export interface WorkflowTrigger {
  readonly type: "event" | "cron" | "manual" | "invoke";
  readonly config: JsonSchema;
}

export interface WorkflowRetryPolicy {
  readonly maxAttempts: number;
  readonly backoff?: "fixed" | "exponential";
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface WorkflowExecutionPolicy {
  readonly timeoutMs?: number;
  readonly retry?: WorkflowRetryPolicy;
  readonly concurrencyKey?: string;
  readonly rateLimit?: { readonly limit: number; readonly periodMs: number };
  readonly throttle?: { readonly limit: number; readonly periodMs: number; readonly burst?: number };
  readonly debounceMs?: number;
  readonly singleton?: { readonly key: string; readonly mode: "skip" | "cancel" };
  /** Supported cancellation trigger: event name plus optional top-level field equality. */
  readonly cancelOn?: readonly { readonly event: string; readonly field?: string; readonly equals?: string | number | boolean | null }[];
  /** Batching is intentionally not implemented until its durable storage contract is approved. */
  readonly batching?: { readonly key: string; readonly maxSize: number; readonly windowMs: number };
}

export interface WorkflowDefinition<Input = unknown, Output = unknown> {
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

export const RUN_STATUS_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled", "interrupted"],
  running: ["waiting", "sleeping", "retrying", "succeeded", "failed", "cancel_requested", "interrupted", "needs_review"],
  waiting: ["running", "cancel_requested", "failed", "interrupted", "needs_review"],
  sleeping: ["running", "cancel_requested", "failed", "interrupted", "needs_review"],
  retrying: ["running", "cancel_requested", "failed", "interrupted", "needs_review"],
  cancel_requested: ["cancelled", "interrupted", "needs_review"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
  needs_review: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_STATUS_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new Error(`Invalid run status transition: ${from} -> ${to}`);
  }
}
