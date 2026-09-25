export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "interrupted"
  | "needs_review";

export type StepStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "needs_review";
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
  readonly type: string;
  readonly config: unknown;
  readonly input: unknown;
}

export interface WorkflowContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly step: {
    execute<T = unknown>(stepId: string, request: StepRequest): Promise<T>;
  };
}

export interface WorkflowDefinition<Input = unknown, Output = unknown> {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly concurrency?: number;
  readonly run: (context: WorkflowContext, input: Input) => Promise<Output>;
}

export const RUN_STATUS_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled", "interrupted"],
  running: ["waiting", "succeeded", "failed", "cancel_requested", "interrupted", "needs_review"],
  waiting: ["running", "cancel_requested", "failed", "interrupted", "needs_review"],
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
