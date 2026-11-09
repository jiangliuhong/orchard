import { check } from "../domain/errors.js";
import type { WebBridgeTool } from "./catalog.js";

export function validateToolId(toolId: unknown): asserts toolId is string {
  check(typeof toolId === "string" && /^[a-z][a-z0-9_-]{0,99}$/.test(toolId), "INVALID_TOOL", "工具 ID 应以小写字母开头，仅包含小写字母、数字、下划线和短横线，最多 100 个字符");
}

/** Fill identity from the editor or route context; explicit conflicts must be resolved by the caller. */
export function normalizeToolIdentity(value: unknown, application: string, toolId?: string): WebBridgeTool {
  check(value && typeof value === "object" && !Array.isArray(value), "INVALID_TOOL", "工具定义必须是 JSON 对象");
  const definition = { ...(value as Record<string, unknown>) };
  check(definition.application === undefined || typeof definition.application === "string", "INVALID_TOOL", "应用 ID 必须是字符串");
  check(definition.toolId === undefined || typeof definition.toolId === "string", "INVALID_TOOL", "工具 ID 必须是字符串");
  check(definition.application === undefined || definition.application === application, "TOOL_APPLICATION_CONFLICT", `JSON 中的应用 ID 为 ${JSON.stringify(definition.application)}，当前应用为 ${application}`);
  definition.application = application;
  if (toolId !== undefined) {
    check(definition.toolId === undefined || definition.toolId === toolId, "TOOL_ID_CONFLICT", `当前工具 ID 为 ${toolId}，JSON 中的工具 ID 为 ${JSON.stringify(definition.toolId)}；如需创建新工具，请另存为新工具`);
    definition.toolId = toolId;
  }
  return definition as unknown as WebBridgeTool;
}
