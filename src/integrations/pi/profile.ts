/**
 * Validation and normalization for agent profiles used by the host CLI backends.
 *
 * Field semantics (see openspec change implement-host-cli-agents, design D5):
 * - `provider` is a launcher enum: "pi-cli" | "codex-cli".
 * - `model` may be empty, meaning "use the CLI's default model".
 * - `config` accepts only enumerated control fields; anything else (in
 *   particular arbitrary command line fragments) is rejected.
 * - `allowedTools` is the pi tool allowlist; on codex it carries the explicit
 *   write-authorization sentinel and nothing else.
 */

export type AgentLauncher = "pi-cli" | "codex-cli";

export const AGENT_LAUNCHERS = ["pi-cli", "codex-cli"] as const;

export const CODEX_WRITE_SENTINEL = "workspace-write";

export type CodexSandbox = "read-only" | "workspace-write";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const PROFILE_TIMEOUT_CEILING_MS = 900_000;
const MODEL_MAX_LENGTH = 200;
const NAME_MAX_LENGTH = 200;
const TOOL_MAX_LENGTH = 100;
const TOOL_MAX_COUNT = 50;

export class InvalidAgentProfileError extends Error {
  readonly code = "INVALID_AGENT_PROFILE" as const;
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentProfileError";
  }
}

export interface NormalizedAgentProfile {
  readonly name: string;
  readonly launcher: AgentLauncher;
  readonly model: string;
  readonly allowedTools: readonly string[];
  readonly codexSandbox: CodexSandbox;
  readonly timeoutMs?: number;
  readonly thinkingLevel?: ThinkingLevel;
}

export function isAgentLauncher(value: unknown): value is AgentLauncher {
  return typeof value === "string" && (AGENT_LAUNCHERS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a raw profile payload and returns the normalized form.
 * Throws {@link InvalidAgentProfileError} with an actionable message on any
 * violation. Accepts records coming from the API or from storage.
 */
export function validateAgentProfile(input: {
  name?: unknown;
  provider?: unknown;
  model?: unknown;
  config?: unknown;
  allowedTools?: unknown;
}): NormalizedAgentProfile {
  if (typeof input.name !== "string" || input.name.length < 1 || input.name.length > NAME_MAX_LENGTH) {
    throw new InvalidAgentProfileError(`Agent name must be a string of 1..${NAME_MAX_LENGTH} characters.`);
  }
  if (!isAgentLauncher(input.provider)) {
    throw new InvalidAgentProfileError(
      `Agent provider must be one of ${AGENT_LAUNCHERS.join(" | ")} (got ${JSON.stringify(input.provider ?? null)}).`,
    );
  }
  const launcher: AgentLauncher = input.provider;
  const model = input.model === undefined || input.model === null ? "" : input.model;
  if (typeof model !== "string" || model.length > MODEL_MAX_LENGTH) {
    throw new InvalidAgentProfileError(`Agent model must be a string of at most ${MODEL_MAX_LENGTH} characters (empty means the CLI default).`);
  }

  const rawConfig = input.config ?? {};
  if (!isPlainObject(rawConfig)) {
    throw new InvalidAgentProfileError("Agent config must be an object.");
  }
  const allowedConfigKeys = ["timeoutMs", "thinkingLevel"];
  for (const key of Object.keys(rawConfig)) {
    if (!allowedConfigKeys.includes(key)) {
      throw new InvalidAgentProfileError(`Agent config field "${key}" is not supported; allowed fields: ${allowedConfigKeys.join(", ")}.`);
    }
  }

  let timeoutMs: number | undefined;
  if (rawConfig.timeoutMs !== undefined) {
    if (
      typeof rawConfig.timeoutMs !== "number" || !Number.isInteger(rawConfig.timeoutMs) ||
      rawConfig.timeoutMs < 1 || rawConfig.timeoutMs > PROFILE_TIMEOUT_CEILING_MS
    ) {
      throw new InvalidAgentProfileError(`Agent config timeoutMs must be an integer between 1 and ${PROFILE_TIMEOUT_CEILING_MS}.`);
    }
    timeoutMs = rawConfig.timeoutMs;
  }

  let thinkingLevel: ThinkingLevel | undefined;
  if (rawConfig.thinkingLevel !== undefined) {
    if (launcher !== "pi-cli") {
      throw new InvalidAgentProfileError(`Agent config thinkingLevel only applies to the pi-cli launcher.`);
    }
    if (typeof rawConfig.thinkingLevel !== "string" || !(THINKING_LEVELS as readonly string[]).includes(rawConfig.thinkingLevel)) {
      throw new InvalidAgentProfileError(`Agent config thinkingLevel must be one of ${THINKING_LEVELS.join(" | ")}.`);
    }
    thinkingLevel = rawConfig.thinkingLevel as ThinkingLevel;
  }

  const rawTools = input.allowedTools ?? [];
  if (!Array.isArray(rawTools)) {
    throw new InvalidAgentProfileError("Agent allowedTools must be an array of strings.");
  }
  if (rawTools.length > TOOL_MAX_COUNT) {
    throw new InvalidAgentProfileError(`Agent allowedTools accepts at most ${TOOL_MAX_COUNT} entries.`);
  }
  const allowedTools: string[] = [];
  for (const entry of rawTools) {
    if (typeof entry !== "string") {
      throw new InvalidAgentProfileError("Agent allowedTools entries must be strings.");
    }
    if (launcher === "codex-cli") {
      if (entry !== CODEX_WRITE_SENTINEL) {
        throw new InvalidAgentProfileError(
          `The codex-cli launcher does not support tool allowlists; allowedTools may only contain the "${CODEX_WRITE_SENTINEL}" authorization sentinel.`,
        );
      }
      continue;
    }
    if (entry.length < 1 || entry.length > TOOL_MAX_LENGTH) {
      throw new InvalidAgentProfileError(`Agent allowedTools entries must be 1..${TOOL_MAX_LENGTH} characters.`);
    }
    allowedTools.push(entry);
  }

  return {
    name: input.name,
    launcher,
    model,
    allowedTools,
    codexSandbox: launcher === "codex-cli" && rawTools.includes(CODEX_WRITE_SENTINEL) ? "workspace-write" : "read-only",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

/** Returns the validation error for a stored record, or undefined when valid. */
export function agentProfileValidationError(record: { provider?: unknown; model?: unknown; config?: unknown; allowedTools?: unknown }): string | undefined {
  try {
    validateAgentProfile(record);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
