import type { Store } from "../persistence/store.js";
import { configuredWebBridge } from "../web-bridge/configured.js";
import { credentialSchema } from "../web-bridge/credential-schema.js";

/** Allowlisted contracts only: never include source files, credential values or execution code. */
export function workflowResourceMetadata(store: Store) {
  const availableScripts = store.scripts().filter(script => script.status !== "archived").flatMap(script =>
    store.scriptVersions(script.id).filter(version => version.status === "published").map(version => {
      const definition = store.scriptDefinition(script.id, version.id);
      return {
        scriptId: script.id, scriptVersionId: version.id, version: version.number,
        current: version.id === script.currentPublishedVersionId,
        name: definition.name, description: definition.description, runtime: definition.runtime,
        inputSchema: version.inputSchema, outputSchema: version.outputSchema,
        dictionaryBindings: definition.dictionaryBindings ?? {},
      };
    }));
  // Read the current persisted configuration each turn, including after configuration restores.
  const bridge = configuredWebBridge(store);
  const availableBridgeTools = bridge.tools().filter(tool => tool.enabled && bridge.application(tool.application)?.enabled).map(tool => ({
    application: tool.application, tool: tool.toolId, description: tool.description,
    parameters: tool.parameters, fields: tool.fields, risk: tool.risk, approval: tool.approval,
    credentialSchema: tool.execution?.transport === "browser" ? credentialSchema(tool.execution) : null,
    environments: bridge.environments(tool.application).filter(environment => environment.enabled).map(({ id }) => ({ id })),
  }));
  return { availableScripts, availableBridgeTools };
}
export type WorkflowResourceMetadata = ReturnType<typeof workflowResourceMetadata>;
