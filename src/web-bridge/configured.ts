import { existsSync, readFileSync } from "node:fs";
import { configCoordinator, type ConfigWriteCoordinator } from "../config-git/coordinator.js";
import type { Store } from "../persistence/store.js";
import { workspaceSchemaInstalled } from "../agent/workspace-business-hooks.js";
import { WebBridgeConfig } from "./config.js";
import { DatabaseBridgeConfiguration } from "./database-config.js";

/** Production factory. Once all reviewed tables exist, missing/corrupt DB
 * configuration is an error: stale JSON can never become an automatic fallback. */
export function configuredWebBridge(store: Store, coordinator: ConfigWriteCoordinator = configCoordinator(store)): WebBridgeConfig {
  return new WebBridgeConfig(store.root, coordinator, workspaceSchemaInstalled(store) ? new DatabaseBridgeConfiguration(store) : undefined);
}
export function readConfiguredBridge(store: Store, allowMissingLegacy = false): Record<string, unknown> {
  if (workspaceSchemaInstalled(store)) return JSON.parse(new DatabaseBridgeConfiguration(store).read()) as Record<string, unknown>;
  const path = store.files.path("config/web-bridge.json");
  if (allowMissingLegacy && !existsSync(path)) return { schemaVersion: 1, applications: {}, environments: {}, tools: {}, enabledTools: {} };
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
