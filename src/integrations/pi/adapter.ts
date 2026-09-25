import type { JsonSchema } from "../../core/contracts.js";
import { assertValidJson } from "../../core/validation.js";

export interface PiRequest {
  readonly prompt: string;
  readonly outputSchema?: JsonSchema;
  readonly model?: string;
  readonly allowedTools?: readonly string[];
}

export interface PiResult<Output = unknown> {
  readonly output: Output;
  readonly provider: string;
  readonly model: string;
  readonly sessionId?: string;
  readonly usage?: Readonly<Record<string, number>>;
}

export interface PiSession {
  run(request: PiRequest, signal: AbortSignal): Promise<PiResult>;
  cancel?(): Promise<void>;
}

export interface PiClient {
  createSession(options: { signal: AbortSignal; allowedTools: readonly string[] }): Promise<PiSession>;
}

/** Minimal adapter for a real Pi-compatible HTTP gateway. The gateway owns provider credentials. */
export class HttpPiClient implements PiClient {
  constructor(private readonly options: { endpoint: string; apiKey?: string; provider?: string; model?: string; fetch?: typeof globalThis.fetch }) {}
  async createSession(options: { signal: AbortSignal; allowedTools: readonly string[] }): Promise<PiSession> {
    const fetcher = this.options.fetch ?? globalThis.fetch;
    const endpoint = this.options.endpoint.replace(/\/$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    return new HttpPiSession(fetcher, `${endpoint}/sessions`, headers, options.allowedTools, this.options.provider, this.options.model, options.signal);
  }
}

class HttpPiSession implements PiSession {
  private sessionId: string | undefined;
  constructor(private readonly fetcher: typeof globalThis.fetch, private readonly endpoint: string, private readonly headers: Record<string, string>, private readonly allowedTools: readonly string[], private readonly provider: string | undefined, private readonly defaultModel: string | undefined, private readonly signal: AbortSignal) {}
  async run(request: PiRequest, signal: AbortSignal): Promise<PiResult> {
    const response = await this.fetcher(this.endpoint, { method: "POST", headers: this.headers, signal, body: JSON.stringify({ prompt: request.prompt, outputSchema: request.outputSchema, model: request.model ?? this.defaultModel, provider: this.provider, allowedTools: request.allowedTools ?? this.allowedTools, sessionId: this.sessionId }) });
    if (!response.ok) throw new Error(`Pi gateway returned HTTP ${response.status}`);
    const body = await response.json() as { output: unknown; provider?: string; model?: string; sessionId?: string; usage?: Readonly<Record<string, number>> };
    if (!Object.hasOwn(body, "output")) throw new Error("Pi gateway response did not include output");
    this.sessionId = body.sessionId ?? this.sessionId;
    return { output: body.output, provider: body.provider ?? this.provider ?? "pi", model: body.model ?? request.model ?? this.defaultModel ?? "unknown", ...(this.sessionId ? { sessionId: this.sessionId } : {}), ...(body.usage ? { usage: body.usage } : {}) };
  }
  async cancel(): Promise<void> { /* AbortSignal cancellation is the transport cancellation mechanism. */ }
}

export class PiNotConfiguredError extends Error {
  readonly code = "PI_NOT_CONFIGURED" as const;
  constructor() { super("Pi is not configured; configure an explicit Pi provider before running an ai.pi node"); this.name = "PiNotConfiguredError"; }
}

export class PiAdapter {
  readonly type = "ai.pi" as const;
  readonly version = "1" as const;
  constructor(private readonly client?: PiClient) {}

  async execute(request: PiRequest, signal: AbortSignal): Promise<PiResult> {
    if (!this.client) throw new PiNotConfiguredError();
    signal.throwIfAborted();
    const session = await this.client.createSession({ signal, allowedTools: request.allowedTools ?? [] });
    if (signal.aborted) {
      await session.cancel?.();
      signal.throwIfAborted();
    }
    let abort: (() => void) | undefined;
    const cancellation = new Promise<never>((_, reject) => {
      abort = () => { void session.cancel?.(); reject(signal.reason ?? new Error("Pi execution cancelled")); };
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([session.run(request, signal), cancellation]);
      if (request.outputSchema) assertValidJson(result.output, request.outputSchema, "Pi output");
      return result;
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
}
