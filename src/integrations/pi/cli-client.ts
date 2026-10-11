import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiClient, PiRequest, PiResult, PiSession } from "./adapter.js";
import { CODEX_WRITE_SENTINEL, type AgentLauncher, type CodexSandbox, type ThinkingLevel } from "./profile.js";
import type { BackendConfig, CliBackendRegistry } from "./backends.js";
import { ProcessController } from "../cli/process-controller.js";
import { CliExecutionError } from "../cli/errors.js";

/**
 * `PiClient` implementation backed by host CLIs (design D3/D4/D8/D10).
 *
 * Every subprocess goes through `ProcessController` (timeout, cancellation,
 * output caps, process-group kill) with the prompt written to stdin and the
 * working directory locked to the workspace root. Executable paths come only
 * from the trusted backend registry; run requests can never influence them.
 */

export type PiCliErrorCode =
  | "AGENT_BACKEND_NOT_CONFIGURED"
  | "PROCESS_START_FAILED"
  | "CLI_PROCESS_FAILED"
  | "INVALID_PI_OUTPUT";

const STDERR_EXCERPT_LIMIT = 2_048;

export class PiCliError extends Error {
  readonly code: PiCliErrorCode;
  readonly retryable: boolean;
  readonly stderr?: string;
  readonly exitCode?: number | null;

  constructor(code: PiCliErrorCode, message: string, options: { retryable: boolean; stderr?: string; exitCode?: number | null } = { retryable: true }) {
    super(message);
    this.name = "PiCliError";
    this.code = code;
    this.retryable = options.retryable;
    if (options.stderr !== undefined) this.stderr = options.stderr;
    if (options.exitCode !== undefined) this.exitCode = options.exitCode;
  }
}

function excerpt(value: string, limit = STDERR_EXCERPT_LIMIT): string {
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit)}… [truncated]` : text;
}

// ---------------------------------------------------------------- pi-cli ---

export interface PiLaunchOptions {
  readonly model?: string;
  readonly allowedTools?: readonly string[];
  readonly thinkingLevel?: ThinkingLevel;
}

/** Builds the pi invocation (verified against pi 1.1.0 flag surface). */
export function buildPiArgs(options: PiLaunchOptions): string[] {
  const args = ["-p", "--mode", "json", "--no-session", "--no-extensions", "--no-mcp"];
  // No allowlist means no tools at all; an allowlist itself restricts to the
  // listed tools, so the two forms are never combined.
  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push("--tools", options.allowedTools.join(","));
  } else {
    args.push("--no-tools");
  }
  if (options.model && options.model.length > 0) args.push("--model", options.model);
  // Headless workflow steps want deterministic, cheap turns by default.
  args.push("--thinking", options.thinkingLevel ?? "off");
  return args;
}

export interface PiTurnResult {
  readonly text: string;
  readonly provider?: string;
  readonly model?: string;
  readonly usage?: Readonly<Record<string, number>>;
}

interface PiEvent {
  readonly type?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
    readonly provider?: string;
    readonly model?: string;
    readonly usage?: Record<string, unknown>;
  };
  readonly error?: { readonly message?: string } | string;
}

function flattenUsage(usage: Record<string, unknown> | undefined): Readonly<Record<string, number>> | undefined {
  if (!usage) return undefined;
  const flat: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) flat[key] = value;
  }
  const cost = usage.cost;
  if (typeof cost === "object" && cost !== null) {
    const total = (cost as Record<string, unknown>).total;
    if (typeof total === "number" && Number.isFinite(total)) flat.costTotal = total;
  }
  return Object.keys(flat).length > 0 ? flat : undefined;
}

/**
 * Parses pi's `--mode json` JSONL stream. The LAST `turn_end` assistant
 * message wins (tool loops emit several turns). Unknown event types are
 * skipped for forward compatibility.
 */
export function parsePiJsonl(stdout: string): PiTurnResult {
  let last: PiTurnResult | undefined;
  let streamError: string | undefined;
  let malformed: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: PiEvent;
    try {
      event = JSON.parse(trimmed) as PiEvent;
    } catch (error) {
      malformed ??= `line could not be parsed: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }
    if (event.type === "error") {
      streamError = typeof event.error === "string" ? event.error : event.error?.message ?? "pi reported an error event";
      continue;
    }
    if (event.type !== "turn_end" || event.message?.role !== "assistant") continue;
    const text = (event.message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const provider = event.message.provider;
    const model = event.message.model;
    const usage = flattenUsage(event.message.usage);
    last = {
      text,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
    };
  }
  if (streamError) throw new PiCliError("CLI_PROCESS_FAILED", `pi reported an error: ${streamError}`);
  if (!last) {
    throw new PiCliError(
      "INVALID_PI_OUTPUT",
      `pi produced no final assistant message${malformed ? ` (${malformed})` : ""}.`,
    );
  }
  return last;
}

// -------------------------------------------------------------- codex-cli ---

export interface CodexLaunchOptions {
  readonly model?: string;
  readonly sandbox: CodexSandbox;
  readonly outputFile: string;
}

/** Builds the codex invocation. `danger-full-access` is never expressible. */
export function buildCodexArgs(options: CodexLaunchOptions): string[] {
  const args = ["exec", "--json"];
  if (options.model && options.model.length > 0) args.push("-m", options.model);
  args.push("-s", options.sandbox, "-o", options.outputFile);
  return args;
}

export interface CodexMetadata {
  readonly usage?: Readonly<Record<string, number>>;
  readonly model?: string;
}

/** Extracts usage/model from codex's `--json` event stream (final message comes from `-o`). */
export function parseCodexJsonl(stdout: string): CodexMetadata {
  let usage: Readonly<Record<string, number>> | undefined;
  let model: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { readonly type?: string; readonly usage?: Record<string, unknown>; readonly model?: unknown };
    try {
      event = JSON.parse(trimmed) as { readonly type?: string; readonly usage?: Record<string, unknown>; readonly model?: unknown };
    } catch {
      continue;
    }
    if (typeof event.model === "string" && event.model.length > 0) model = event.model;
    if (event.type === "turn.completed" && event.usage) {
      const flat: Record<string, number> = {};
      for (const [key, value] of Object.entries(event.usage)) {
        if (typeof value === "number" && Number.isFinite(value)) flat[key] = value;
      }
      if (Object.keys(flat).length > 0) usage = flat;
    }
  }
  return { ...(usage ? { usage } : {}), ...(model ? { model } : {}) };
}

export function codexSandboxFromTools(allowedTools: readonly string[]): CodexSandbox {
  return allowedTools.includes(CODEX_WRITE_SENTINEL) ? "workspace-write" : "read-only";
}

// ------------------------------------------------------------ the client ---

export interface LauncherProfileOverrides {
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly timeoutMs?: number;
  readonly allowedTools?: readonly string[];
}

export interface CliPiClientOptions {
  readonly registry: CliBackendRegistry;
  readonly workspaceRoot: string;
  readonly controller?: ProcessController;
}

/**
 * Routes `PiClient` calls to host CLI backends. Use {@link forLauncher} to
 * bind a launcher (plus optional profile defaults); the registry entry is
 * read at execution start, so settings hot-swaps only affect later runs.
 */
export class CliPiClient {
  private readonly controller: ProcessController;

  constructor(private readonly options: CliPiClientOptions) {
    this.controller = options.controller ?? new ProcessController();
  }

  forLauncher(launcher: AgentLauncher, overrides: LauncherProfileOverrides = {}): PiClient {
    return {
      createSession: async (session) => ({
        run: (request, signal) => this.run(launcher, overrides, request, signal ?? session.signal),
      }),
    };
  }

  private async run(launcher: AgentLauncher, overrides: LauncherProfileOverrides, request: PiRequest, signal: AbortSignal): Promise<PiResult> {
    signal.throwIfAborted();
    const backend = this.options.registry.get(launcher);
    if (!backend) {
      throw new PiCliError(
        "AGENT_BACKEND_NOT_CONFIGURED",
        `The ${launcher} backend is not available; resolve the CLI executable in the workbench settings.`,
        { retryable: false },
      );
    }
    const allowedTools = request.allowedTools && request.allowedTools.length > 0 ? request.allowedTools : overrides.allowedTools ?? [];
    const model = request.model && request.model.length > 0 ? request.model : overrides.model;
    const timeoutMs = overrides.timeoutMs ?? backend.defaultTimeoutMs;
    if (launcher === "pi-cli") {
      const launch: PiLaunchOptions = {
        allowedTools,
        ...(model ? { model } : {}),
        ...(overrides.thinkingLevel ? { thinkingLevel: overrides.thinkingLevel } : {}),
      };
      return await this.runPi(backend, launch, request, signal, timeoutMs);
    }
    const launch = { sandbox: codexSandboxFromTools(allowedTools), ...(model ? { model } : {}) };
    return await this.runCodex(backend, launch, request, signal, timeoutMs);
  }

  private async runPi(
    backend: BackendConfig,
    launch: PiLaunchOptions,
    request: PiRequest,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<PiResult> {
    const result = await this.executeProcess(backend, buildPiArgs(launch), request.prompt, signal, timeoutMs);
    this.assertExit(backend, result);
    const turn = parsePiJsonl(result.stdout);
    return this.toResult(turn.text, turn.provider ?? "pi", turn.model ?? launch.model ?? "unknown", turn.usage, request);
  }

  private async runCodex(
    backend: BackendConfig,
    launch: Omit<CodexLaunchOptions, "outputFile">,
    request: PiRequest,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<PiResult> {
    const dir = await mkdtemp(join(tmpdir(), "orchard-codex-"));
    try {
      const outputFile = join(dir, "last-message.txt");
      const result = await this.executeProcess(backend, buildCodexArgs({ ...launch, outputFile }), request.prompt, signal, timeoutMs);
      this.assertExit(backend, result);
      let text: string;
      try {
        text = await readFile(outputFile, "utf8");
      } catch (error) {
        throw new PiCliError("INVALID_PI_OUTPUT", `codex did not produce the final message file: ${error instanceof Error ? error.message : String(error)}`);
      }
      const metadata = parseCodexJsonl(result.stdout);
      const usage = metadata.usage ?? undefined;
      return this.toResult(text, "codex", metadata.model ?? launch.model ?? "codex", usage, request);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async executeProcess(
    backend: BackendConfig,
    args: readonly string[],
    prompt: string,
    signal: AbortSignal,
    timeoutMs: number,
  ) {
    try {
      return await this.controller.execute(
        {
          executable: backend.executable,
          args,
          stdin: prompt,
          cwd: this.options.workspaceRoot,
          timeoutMs,
          maxOutputBytes: backend.maxOutputBytes,
          killGraceMs: backend.killGraceMs,
        },
        { signal },
      );
    } catch (error) {
      if (error instanceof CliExecutionError && error.code === "PROCESS_START_FAILED") {
        throw new PiCliError("PROCESS_START_FAILED", error.message, { retryable: false });
      }
      // TIMEOUT / CANCELLED / OUTPUT_LIMIT_EXCEEDED keep their process-control
      // codes and default retryability.
      throw error;
    }
  }

  private assertExit(backend: BackendConfig, result: { exitCode: number | null; stderr: string; stdout: string }): void {
    if (result.exitCode === 0) return;
    const details = excerpt(result.stderr || result.stdout);
    throw new PiCliError(
      "CLI_PROCESS_FAILED",
      `${backend.executable} exited with code ${result.exitCode ?? "signal"}${details ? `: ${details}` : ""}`,
      { retryable: true, stderr: details, exitCode: result.exitCode },
    );
  }

  /**
   * When the caller declared an output schema the final text is expected to be
   * that JSON; parse it here so `PiAdapter`'s `assertValidJson` validates the
   * value (parse/validation failures are retryable attempt errors).
   */
  private toResult(text: string, provider: string, model: string, usage: Readonly<Record<string, number>> | undefined, request: PiRequest): PiResult {
    if (!request.outputSchema) return { output: text, provider, model, ...(usage ? { usage } : {}) };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new PiCliError(
        "INVALID_PI_OUTPUT",
        `CLI output was not valid JSON for the declared schema: ${error instanceof Error ? error.message : String(error)}. Excerpt: ${excerpt(text, 400)}`,
      );
    }
    return { output: parsed, provider, model, ...(usage ? { usage } : {}) };
  }
}
