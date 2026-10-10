import { setTimeout } from "node:timers/promises";
import { NodeRegistry, Type } from "../workflow-sdk/index.js";
import { registerMetricNodes } from "../integrations/metric/nodes.js";

/** Nodes available to the local CLI worker. */
export function createLocalNodeRegistry(): NodeRegistry {
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
  return registerMetricNodes(nodes);
}
