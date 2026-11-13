import { parseConfigJson, inspectBridgeConfig as inspectHistoricalConfig, validateBridgeConfigV1 as validateHistoricalConfig, type BridgeConfig } from "../migrations/config.js";
import { BRIDGE_HTTP_METHODS } from "./http-methods.js";
import { validateEnvironmentKey } from "./local-bindings.js";
import { check } from "../domain/errors.js";

/** Extend live configuration validation without changing the reviewed v0→v1 migration. */
export function validateBridgeConfigV1(source: string): BridgeConfig {
  const value = parseConfigJson(source);
  const projected = structuredClone(value);
  if (projected && typeof projected === "object" && !Array.isArray(projected)) {
    const tools = projected.tools;
    if (tools && typeof tools === "object" && !Array.isArray(tools)) {
      for (const tool of Object.values(tools)) {
        if (tool && typeof tool === "object" && !Array.isArray(tool) && BRIDGE_HTTP_METHODS.some(method => method === tool.method)) tool.method = "GET";
      }
    }
  }
  validateHistoricalConfig(JSON.stringify(projected));
  for (const environments of Object.values((value as BridgeConfig).environments)) {
    const keys = new Set<string>();
    for (const environment of environments as unknown as { id: string; key?: string }[]) {
      if (environment.key !== undefined) validateEnvironmentKey(environment.key);
      const key = environment.key ?? environment.id;
      check(!keys.has(key), "ENVIRONMENT_KEY_CONFLICT", "该应用中已存在相同的环境标识", 409);
      keys.add(key);
    }
  }
  return value as BridgeConfig;
}

export function inspectBridgeConfig(source: string) {
  const value = parseConfigJson(source);
  if (value && typeof value === "object" && !Array.isArray(value) && value.schemaVersion === 1) {
    return { version: 1 as const, value: validateBridgeConfigV1(source) };
  }
  return inspectHistoricalConfig(source);
}
