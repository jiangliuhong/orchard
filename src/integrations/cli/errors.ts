export type CliErrorCode =
  | "TOOL_NOT_FOUND"
  | "INVALID_TOOL_ID"
  | "DUPLICATE_TOOL"
  | "INVALID_INPUT"
  | "INVALID_OUTPUT"
  | "PROCESS_START_FAILED"
  | "PROCESS_FAILED"
  | "PROCESS_TIMEOUT"
  | "PROCESS_CANCELLED"
  | "OUTPUT_LIMIT_EXCEEDED";

export interface CliErrorDetails {
  readonly toolId?: string;
  readonly executable?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs?: number;
  readonly [key: string]: unknown;
}

export class CliExecutionError extends Error {
  readonly code: CliErrorCode;
  readonly details: CliErrorDetails;

  constructor(code: CliErrorCode, message: string, details: CliErrorDetails = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliExecutionError";
    this.code = code;
    this.details = details;
  }
}
