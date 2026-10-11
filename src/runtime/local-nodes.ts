import { setTimeout } from "node:timers/promises";
import { NodeRegistry, Type } from "../workflow-sdk/index.js";
import { registerMetricNodes } from "../integrations/metric/nodes.js";
import { registerAiNodes, type AgentProfileSource } from "../integrations/pi/nodes.js";
import type { CliPiClient } from "../integrations/pi/cli-client.js";

export interface LocalNodeRegistryOptions {
  /** Agent profile storage; required for the ai.pi node. */
  readonly agents?: AgentProfileSource;
  /** Host CLI backend client; the node reports AGENT_BACKEND_NOT_CONFIGURED at execution time when a launcher is unresolved. */
  readonly client?: CliPiClient;
}

/** Nodes available to the local CLI worker. */
export function createLocalNodeRegistry(options: LocalNodeRegistryOptions = {}): NodeRegistry {
  const nodes = new NodeRegistry().register<unknown, { durationMs: number }, null>({
    type: "core.sleep", version: "1", sideEffects: "read_only",
    configSchema: Type.Object({}, { additionalProperties: false }),
    inputSchema: Type.Object({ durationMs: Type.Integer({ minimum: 0, maximum: 30 * 60 * 1000 }) }, { additionalProperties: false }),
    outputSchema: Type.Null(),
    async execute(context, _config, input) {
      await setTimeout(input.durationMs, undefined, { signal: context.signal });
      return null;
    },
  });
  const withMetrics = registerMetricNodes(nodes);
  // ai.pi registers whenever agent storage exists; unresolved backends fail at
  // execution time so settings can enable them without a restart.
  return options.agents && options.client ? registerAiNodes(withMetrics, { agents: options.agents, client: options.client }) : withMetrics;
}
