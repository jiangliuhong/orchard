import { Type, type NodeContext, type NodeRegistry } from "../../workflow-sdk/index.js";
import { PiAdapter } from "./adapter.js";
import { validateAgentProfile, type AgentLauncher, type NormalizedAgentProfile } from "./profile.js";
import type { CliPiClient } from "./cli-client.js";
import type { AgentProfileRecord } from "../../storage/repository.js";
import type { JsonSchema } from "../../core/contracts.js";

/**
 * `ai.pi` node registration (design D6): resolves the step's agentProfileId to
 * a profile, validates it, and routes execution to the profile's launcher.
 * The output contract is the step-configured JSON Schema; validation failures
 * are ordinary retryable errors (PiAdapter's `assertValidJson` post-check).
 */

export class AgentNodeConfigError extends Error {
  readonly retryable = false;
  constructor(readonly code: "AGENT_PROFILE_NOT_FOUND" | "INVALID_AGENT_PROFILE", message: string) {
    super(message);
    this.name = "AgentNodeConfigError";
  }
}

export interface AgentProfileSource {
  list(): readonly AgentProfileRecord[];
}

export interface RegisterAiNodesOptions {
  readonly agents: AgentProfileSource;
  readonly client: CliPiClient;
}

function findProfile(agents: AgentProfileSource, agentProfileId: string): AgentProfileRecord {
  const record = agents.list().find((profile) => profile.id === agentProfileId);
  if (!record) {
    throw new AgentNodeConfigError(
      "AGENT_PROFILE_NOT_FOUND",
      `Agent profile "${agentProfileId}" does not exist; create it in the workbench first.`,
    );
  }
  return record;
}

function normalizeProfile(record: AgentProfileRecord): NormalizedAgentProfile {
  try {
    return validateAgentProfile(record);
  } catch (error) {
    throw new AgentNodeConfigError("INVALID_AGENT_PROFILE", error instanceof Error ? error.message : String(error));
  }
}

export function registerAiNodes(nodes: NodeRegistry, options: RegisterAiNodesOptions): NodeRegistry {
  return nodes.register<{ agentProfileId: string; outputSchema?: JsonSchema }, { prompt: string }, unknown>({
    type: "ai.pi",
    version: "1",
    sideEffects: "unknown",
    configSchema: Type.Object(
      {
        agentProfileId: Type.String({ minLength: 1, maxLength: 100 }),
        outputSchema: Type.Optional(Type.Unknown()),
      },
      { additionalProperties: false },
    ),
    inputSchema: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 100_000 }) }, { additionalProperties: false }),
    outputSchema: Type.Unknown(),
    async execute(context: NodeContext, config, input) {
      const profile = normalizeProfile(findProfile(options.agents, config.agentProfileId));
      context.log("ai.pi execution started", { launcher: profile.launcher, model: profile.model || "(cli default)" });
      const adapter = new PiAdapter(
        options.client.forLauncher(profile.launcher, {
          ...(profile.model ? { model: profile.model } : {}),
          ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
          ...(profile.timeoutMs ? { timeoutMs: profile.timeoutMs } : {}),
          allowedTools: profile.allowedTools,
        }),
      );
      return await adapter.execute(
        {
          prompt: input.prompt,
          ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
          allowedTools: profile.allowedTools,
        },
        context.signal,
      );
    },
  });
}

export type { AgentLauncher };
