import type { JsonSchema, Workflow } from "../domain/types.js";
import type { ScriptDefinitionResolver } from "../domain/dictionaries.js";

/** Conservatively protect the whole run: transformed values and logs can contain private inputs. */
export function hasPrivateHistory(schema: JsonSchema): boolean {
  if (!schema || typeof schema !== "object") return false;
  const policy = schema["x-history"];
  if (policy && typeof policy === "object" && (policy as Record<string, unknown>).record === false) return true;
  return Object.values(schema).some(value => Array.isArray(value)
    ? value.some(item => item && typeof item === "object" && hasPrivateHistory(item))
    : value && typeof value === "object" && hasPrivateHistory(value as JsonSchema));
}

export function privateWorkflowHistory(workflow: Workflow, resolveScript: ScriptDefinitionResolver, bridgeParameters: (application: string, tool: string) => JsonSchema | undefined): boolean {
  if (hasPrivateHistory(workflow.inputSchema) || hasPrivateHistory(workflow.outputSchema)) return true;
  return workflow.nodes.some(node => {
    if (hasPrivateHistory(node.inputSchema ?? true) || hasPrivateHistory(node.outputSchema)) return true;
    if (node.type === "script") {
      const script = resolveScript(node.config.scriptId!, node.config.scriptVersionId!);
      return hasPrivateHistory(script.inputSchema) || hasPrivateHistory(script.outputSchema);
    }
    return node.type === "web-bridge" && hasPrivateHistory(bridgeParameters(node.config.application!, node.config.tool!) ?? true);
  });
}
