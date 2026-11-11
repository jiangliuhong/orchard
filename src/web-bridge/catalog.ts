import { readFileSync } from "node:fs";
import type { BridgeHttpMethod } from "./http-methods.js";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { BridgeExecution } from "./execution.js";
import { assertSchema } from "../domain/validation.js";
import type { JsonSchema } from "../domain/types.js";

export type WebBridgeRisk = "read" | "write" | "delete" | "execute" | "download";
export interface WebBridgeTool {
  toolId: string;
  application: string;
  site: string;
  description: string;
  parameters: JsonSchema;
  path: string;
  method: BridgeHttpMethod;
  fields: string[];
  execution?: BridgeExecution;
  risk: WebBridgeRisk;
  approval: "none" | "user";
  timeoutMs: number;
  catalogVersion: string;
  enabled: boolean;
}
export interface WebBridgeApplication {
  id: string;
  name: string;
  environments: { id: string; origin: string; enabled: boolean; bound: boolean; tabAvailable: boolean }[];
  enabled: boolean;
}

export const catalog: WebBridgeTool[] = [];
export const catalogHash = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
const extensionManifest = JSON.parse(readFileSync(new URL("./extension/manifest.json", import.meta.url), "utf8")) as { key: string };
export const extensionId = [...createHash("sha256").update(Buffer.from(extensionManifest.key, "base64")).digest("hex").slice(0, 32)].map(char => String.fromCharCode(97 + parseInt(char, 16))).join("");

export function listTools(application?: string) {
  return catalog.filter(tool => !application || tool.application === application);
}
export function findTool(application: string, toolId: string) {
  return catalog.find(tool => tool.application === application && tool.toolId === toolId);
}
export function validateToolArgs(tool: WebBridgeTool, args: unknown) {
  assertSchema(args, tool.parameters, `${tool.application}/${tool.toolId} 参数`);
}
export function extensionDirectory() {
  return fileURLToPath(new URL("./extension", import.meta.url));
}
export function catalogHashFor(tools: WebBridgeTool[]) { return createHash("sha256").update(JSON.stringify(tools)).digest("hex"); }
