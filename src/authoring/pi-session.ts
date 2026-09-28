import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AuthoringSessionRepository } from "../storage/repository.js";
import { normalizeRelativePath } from "./compiler.js";
import type { PiAdapter } from "../integrations/pi/adapter.js";

export interface AuthoringPatch { readonly path: string; readonly content: string; }
export interface AuthoringResponse { readonly summary: string; readonly patches: readonly AuthoringPatch[]; }

export class InvalidAuthoringOutputError extends Error { readonly code = "INVALID_AUTHORING_OUTPUT" as const; }

function parseResponse(value: unknown, maxOutputBytes: number): AuthoringResponse {
  const raw = JSON.stringify(value);
  if (raw === undefined || Buffer.byteLength(raw) > maxOutputBytes) throw new InvalidAuthoringOutputError("Pi output exceeds the configured limit");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidAuthoringOutputError("Pi output must be an object");
  const result = value as { summary?: unknown; patches?: unknown };
  if (typeof result.summary !== "string" || !Array.isArray(result.patches)) throw new InvalidAuthoringOutputError("Pi output must contain summary and patches");
  const patches: AuthoringPatch[] = [];
  for (const patch of result.patches) {
    if (!patch || typeof patch !== "object" || typeof (patch as { path?: unknown }).path !== "string" || typeof (patch as { content?: unknown }).content !== "string") throw new InvalidAuthoringOutputError("Each Pi patch must contain path and content");
    patches.push({ path: (patch as { path: string }).path, content: (patch as { content: string }).content });
  }
  return { summary: result.summary, patches };
}

export class PiAuthoringService {
  constructor(private readonly pi: PiAdapter, private readonly sessions: AuthoringSessionRepository) {}

  async generate(input: {
    sessionId: string;
    workspaceRoot: string;
    allowedFiles: readonly string[];
    prompt: string;
    signal?: AbortSignal;
    maxOutputBytes?: number;
    timeoutMs?: number;
  }): Promise<AuthoringResponse> {
    const signal = input.signal ?? new AbortController().signal;
    const controller = new AbortController();
    const relay = () => controller.abort(signal.reason);
    signal.addEventListener("abort", relay, { once: true });
    const timer = input.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new Error("Pi authoring timed out")), input.timeoutMs);
    this.sessions.transition(input.sessionId, "running");
    try {
      const result = await this.pi.execute({ prompt: input.prompt, allowedTools: [], outputSchema: { type: "object", required: ["summary", "patches"] } }, controller.signal);
      const response = parseResponse(result.output, input.maxOutputBytes ?? 256 * 1024);
      const allowed = new Set(input.allowedFiles.map(normalizeRelativePath));
      for (const patch of response.patches) {
        const path = normalizeRelativePath(patch.path);
        if (!allowed.has(path)) throw new InvalidAuthoringOutputError(`Pi attempted to modify an unapproved file: ${patch.path}`);
        const target = resolve(input.workspaceRoot, path);
        if (!target.startsWith(`${resolve(input.workspaceRoot)}/`)) throw new InvalidAuthoringOutputError("Pi patch escaped workspace");
        await writeFile(target, patch.content, { encoding: "utf8", mode: 0o600 });
      }
      this.sessions.appendMessage({ sessionId: input.sessionId, role: "assistant", content: response });
      this.sessions.transition(input.sessionId, "succeeded");
      return response;
    } catch (error) {
      this.sessions.appendMessage({ sessionId: input.sessionId, role: "error", content: { code: error instanceof Error && "code" in error ? (error as { code: string }).code : "PI_AUTHORING_FAILED", message: error instanceof Error ? error.message : String(error) } });
      this.sessions.transition(input.sessionId, controller.signal.aborted ? "cancelled" : "failed");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", relay);
    }
  }
}
