import { check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import type { JsonSchema } from "../domain/types.js";
import type { WebBridgeTool } from "./catalog.js";

export interface BridgeProposal {
  summary: string;
  changes: { operation: "create" | "update" | "delete"; toolId: string; definition: WebBridgeTool | null }[];
}
export const BRIDGE_PROPOSAL_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, required: ["summary", "changes"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 20000 },
    changes: { type: "array", maxItems: 50, items: {
      type: "object", additionalProperties: false, required: ["operation", "toolId", "definition"],
      properties: {
        operation: { enum: ["create", "update", "delete"] },
        toolId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,99}$" },
        definition: { anyOf: [{ type: "null" }, {
          type: "object", additionalProperties: false,
          required: ["toolId", "application", "site", "description", "parameters", "path", "method", "fields", "risk", "approval", "timeoutMs", "catalogVersion", "enabled"],
          properties: {
            toolId: { type: "string" }, application: { type: "string" }, site: { type: "string" },
            description: { type: "string" }, parameters: { type: "object" },
            path: { type: "string", pattern: "^/[^/]" }, method: { enum: ["GET", "POST"] },
            fields: { type: "array", items: { type: "string" } },
            risk: { enum: ["read", "write", "delete", "execute", "download"] },
            approval: { enum: ["none", "user"] }, timeoutMs: { type: "integer", minimum: 100, maximum: 120000 },
            catalogVersion: { type: "string", minLength: 1 }, enabled: { type: "boolean" },
          },
        }] },
      },
    } },
  },
};

export function prepareBridgeProposal(application: string, tools: WebBridgeTool[], value: unknown) {
  assertSchema(value, BRIDGE_PROPOSAL_SCHEMA, "网页桥接 Agent 输出");
  const proposal = value as BridgeProposal, candidate = new Map(tools.map(tool => [tool.toolId, structuredClone(tool)]));
  const changed = new Set<string>();
  for (const change of proposal.changes) {
    check(!changed.has(change.toolId), "INVALID_PROPOSAL", "同一工具只能修改一次");
    changed.add(change.toolId);
    check(change.operation === "create" ? !candidate.has(change.toolId) : candidate.has(change.toolId), "INVALID_PROPOSAL", `工具不存在或已存在：${change.toolId}`);
    if (change.operation === "delete") {
      check(change.definition === null, "INVALID_PROPOSAL", "删除工具不应包含定义");
      candidate.delete(change.toolId);
    } else {
      const definition = change.definition;
      check(definition?.application === application && definition.toolId === change.toolId, "INVALID_PROPOSAL", "不能修改其他应用或工具的身份");
      check(!/[\\\u0000-\u0020\u007f?#]/.test(definition.path), "INVALID_PROPOSAL", "工具路径不能包含查询参数、片段、空白或反斜线");
      assertSchema({}, { type: "object", properties: { args: definition.parameters } }, "参数 Schema");
      candidate.set(change.toolId, structuredClone(definition));
    }
  }
  return { proposal, candidate: [...candidate.values()] };
}
