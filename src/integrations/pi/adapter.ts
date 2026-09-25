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
