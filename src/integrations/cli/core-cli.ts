import { CliExecutionError } from "./errors.js";
import { ProcessController } from "./process-controller.js";
import { CliToolRegistry } from "./registry.js";
import {
  DEFAULT_CLI_KILL_GRACE_MS,
  DEFAULT_CLI_MAX_OUTPUT_BYTES,
  DEFAULT_CLI_TIMEOUT_MS,
  type CliProcessCommand,
  type CliToolExecutionContext,
  type CoreCliConfig,
  type CoreCliExecution,
} from "./types.js";
import type { CliToolDefinition } from "./types.js";

function positiveLimit(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliExecutionError("INVALID_INPUT", `${label} must be a positive finite number.`);
  }
  return Math.floor(value);
}

function effectiveLimit(requested: number | undefined, configured: number | undefined, fallback: number, label: string): number {
  const requestedLimit = positiveLimit(requested, label);
  const configuredLimit = positiveLimit(configured, label);
  return Math.min(requestedLimit ?? configuredLimit ?? fallback, configuredLimit ?? fallback);
}

function validateArgs(toolId: string, args: readonly string[]): readonly string[] {
  for (const arg of args) {
    if (typeof arg !== "string" || arg.includes("\u0000")) {
      throw new CliExecutionError("INVALID_INPUT", `CLI tool "${toolId}" produced an invalid argument.`, { toolId });
    }
  }
  return args;
}

export class CoreCliExecutor {
  readonly type = "core.cli" as const;
  readonly version = "1" as const;

  constructor(
    private readonly registry: CliToolRegistry,
    private readonly processController = new ProcessController(),
  ) {}

  async execute<Input, Output>(
    context: CliToolExecutionContext,
    config: CoreCliConfig,
    input: Input,
  ): Promise<CoreCliExecution<Output>> {
    if (!config || typeof config.toolId !== "string" || config.toolId.length === 0) {
      throw new CliExecutionError("INVALID_INPUT", "core.cli requires a registered toolId.");
    }

    const tool = this.registry.get<Input, Output>(config.toolId);
    try {
      tool.validateInput?.(input);
    } catch (error) {
      throw new CliExecutionError("INVALID_INPUT", `Input validation failed for CLI tool "${tool.id}".`, {
        toolId: tool.id,
        cause: error,
      });
    }

    let args: readonly string[];
    try {
      args = validateArgs(tool.id, tool.buildArgs(input));
    } catch (error) {
      if (error instanceof CliExecutionError) throw error;
      throw new CliExecutionError("INVALID_INPUT", `Could not build arguments for CLI tool "${tool.id}".`, {
        toolId: tool.id,
        cause: error,
      });
    }

    const command: CliProcessCommand = {
      executable: tool.executable,
      args,
      timeoutMs: effectiveLimit(config.timeoutMs, tool.timeoutMs, DEFAULT_CLI_TIMEOUT_MS, "timeoutMs"),
      maxOutputBytes: effectiveLimit(
        config.maxOutputBytes,
        tool.maxOutputBytes,
        DEFAULT_CLI_MAX_OUTPUT_BYTES,
        "maxOutputBytes",
      ),
      killGraceMs: positiveLimit(tool.killGraceMs, "killGraceMs") ?? DEFAULT_CLI_KILL_GRACE_MS,
      ...(tool.cwd === undefined ? {} : { cwd: tool.cwd }),
      ...(tool.env === undefined ? {} : { env: tool.env }),
    };

    const processResult = await this.processController.execute(command, context);
    if (processResult.exitCode !== 0) {
      throw new CliExecutionError(
        "PROCESS_FAILED",
        `CLI tool "${tool.id}" exited unsuccessfully${processResult.exitCode === null ? "" : ` with code ${processResult.exitCode}`}.`,
        {
          toolId: tool.id,
          ...processResult,
        },
      );
    }

    let output: Output;
    try {
      output = tool.parseOutput
        ? await tool.parseOutput(processResult, input)
        : ({
            stdout: processResult.stdout,
            stderr: processResult.stderr,
            exitCode: processResult.exitCode,
            signal: processResult.signal,
          } as Output);
      tool.validateOutput?.(output);
    } catch (error) {
      if (error instanceof CliExecutionError) throw error;
      throw new CliExecutionError("INVALID_OUTPUT", `Output validation failed for CLI tool "${tool.id}".`, {
        toolId: tool.id,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
        cause: error,
      });
    }

    return {
      output,
      process: processResult,
      toolId: tool.id,
      toolVersion: tool.version,
    };
  }
}
