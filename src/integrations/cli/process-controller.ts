import { spawn, type ChildProcess } from "node:child_process";
import { CliExecutionError } from "./errors.js";
import type {
  CliLogEvent,
  CliProcessCommand,
  CliProcessResult,
  CliToolExecutionContext,
} from "./types.js";

const encoder = new TextEncoder();

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;

  // The controller starts Unix children in their own process group. Killing the
  // group prevents a CLI from leaving grandchildren behind after cancellation.
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the check and kill. Fall back to
      // the direct child so cancellation remains best-effort.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The process already exited.
  }
}

function asText(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString("utf8");
}

export class ProcessController {
  async execute(command: CliProcessCommand, context: CliToolExecutionContext = {}): Promise<CliProcessResult> {
    if (context.signal?.aborted) {
      throw new CliExecutionError("PROCESS_CANCELLED", "CLI execution was cancelled before it started.");
    }

    const startedAt = Date.now();
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let outputBytes = 0;
    let terminationReason: "timeout" | "cancelled" | "output_limit" | undefined;
    let terminationStarted = false;
    let settled = false;
    let killGraceTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess;

    const emitLog = (stream: CliLogEvent["stream"], chunk: string): void => {
      context.onLog?.({ stream, chunk, at: Date.now() });
    };

    const append = (target: Uint8Array[], stream: CliLogEvent["stream"], chunk: Buffer): void => {
      emitLog(stream, chunk.toString("utf8"));
      const remaining = command.maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        terminationReason ??= "output_limit";
        return;
      }

      const captured = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      target.push(captured);
      outputBytes += captured.byteLength;
      if (captured.byteLength !== chunk.byteLength) {
        terminationReason = "output_limit";
      }
    };

    const terminate = (reason: "timeout" | "cancelled" | "output_limit"): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      terminationReason = reason;
      killProcessTree(child, "SIGTERM");
      killGraceTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), command.killGraceMs);
      killGraceTimer.unref();
    };

    try {
      const env = command.env ? { ...process.env, ...command.env } : process.env;
      child = spawn(command.executable, [...command.args], {
        cwd: command.cwd,
        detached: process.platform !== "win32",
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new CliExecutionError(
        "PROCESS_START_FAILED",
        `Failed to start CLI executable "${command.executable}".`,
        { executable: command.executable },
        { cause: error },
      );
    }

    return await new Promise<CliProcessResult>((resolve, reject) => {
      const cleanup = (): void => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killGraceTimer) clearTimeout(killGraceTimer);
        context.signal?.removeEventListener("abort", onAbort);
      };

      const finishError = (error: CliExecutionError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onAbort = (): void => terminate("cancelled");

      child.stdout?.on("data", (chunk: Buffer) => {
        append(stdout, "stdout", chunk);
        if (terminationReason === "output_limit") terminate("output_limit");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        append(stderr, "stderr", chunk);
        if (terminationReason === "output_limit") terminate("output_limit");
      });
      child.once("error", (error) => {
        finishError(
          new CliExecutionError(
            "PROCESS_START_FAILED",
            `Failed to start CLI executable "${command.executable}".`,
            { executable: command.executable },
            { cause: error },
          ),
        );
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        const result: CliProcessResult = {
          exitCode,
          signal,
          stdout: asText(Buffer.concat(stdout)),
          stderr: asText(Buffer.concat(stderr)),
          durationMs: Date.now() - startedAt,
        };

        if (terminationReason === "output_limit") {
          finishError(
            new CliExecutionError(
              "OUTPUT_LIMIT_EXCEEDED",
              `CLI output exceeded the ${command.maxOutputBytes}-byte limit.`,
              { ...result },
            ),
          );
          return;
        }
        if (terminationReason === "timeout") {
          finishError(new CliExecutionError("PROCESS_TIMEOUT", `CLI execution exceeded ${command.timeoutMs} ms.`, { ...result }));
          return;
        }
        if (terminationReason === "cancelled") {
          finishError(new CliExecutionError("PROCESS_CANCELLED", "CLI execution was cancelled.", { ...result }));
          return;
        }

        settled = true;
        cleanup();
        resolve(result);
      });

      timeoutTimer = setTimeout(() => terminate("timeout"), command.timeoutMs);
      timeoutTimer.unref();
      context.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
