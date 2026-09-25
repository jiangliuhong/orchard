export type CliSideEffect = "read_only" | "idempotent" | "non_idempotent" | "unknown";

export interface CliToolExecutionContext {
  readonly signal?: AbortSignal;
  readonly runId?: string;
  readonly stepId?: string;
  readonly attemptId?: string;
  readonly onLog?: (event: CliLogEvent) => void;
}

export interface CliLogEvent {
  readonly stream: "stdout" | "stderr";
  readonly chunk: string;
  readonly at: number;
}

export interface CliToolDefinition<Input = unknown, Output = unknown> {
  /** Stable, namespaced identifier. The executable is intentionally not part of the node input. */
  readonly id: string;
  readonly version: string;
  readonly executable: string;
  readonly sideEffects: CliSideEffect;
  readonly buildArgs: (input: Input) => readonly string[];
  readonly parseOutput?: (result: CliProcessResult, input: Input) => Output | Promise<Output>;
  readonly validateInput?: (input: unknown) => asserts input is Input;
  readonly validateOutput?: (output: unknown) => asserts output is Output;
  /** Trusted, tool-owned process settings. They cannot be supplied by a workflow run. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly killGraceMs?: number;
}

export interface CliProcessCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly killGraceMs: number;
}

export interface CliProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface CoreCliConfig {
  readonly toolId: string;
  /** A run may reduce a tool's limit, but may not increase it. */
  readonly timeoutMs?: number;
  /** A run may reduce a tool's limit, but may not increase it. */
  readonly maxOutputBytes?: number;
}

export interface CoreCliExecution<Output = unknown> {
  readonly output: Output;
  readonly process: CliProcessResult;
  readonly toolId: string;
  readonly toolVersion: string;
}

export const DEFAULT_CLI_TIMEOUT_MS = 60_000;
export const DEFAULT_CLI_MAX_OUTPUT_BYTES = 1_048_576;
export const DEFAULT_CLI_KILL_GRACE_MS = 2_000;
