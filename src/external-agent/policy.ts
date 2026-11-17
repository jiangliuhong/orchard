import { assertSchema } from "../domain/validation.js";
import { present, readJson, safe } from "../migrations/journal.js";

export type Channel = "mcp" | "cli";
export type Grant = { id: string; revision: number };
export type Access = { enabled: boolean; cards: Grant[] };
export type AgentPolicy = { revision: number; mcp: Access; cli: Access };
const revision = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
export const cardId = { type: "string", pattern: "^[a-f0-9-]{36}$" };
const access = {
  type: "object", required: ["enabled", "cards"], additionalProperties: false,
  properties: { enabled: { type: "boolean" }, cards: { type: "array", maxItems: 1000, items: {
    type: "object", required: ["id", "revision"], additionalProperties: false, properties: { id: cardId, revision },
  } } },
};
export function validatePolicy(value: unknown): AgentPolicy {
  assertSchema(value, {
    type: "object", required: ["revision", "mcp", "cli"], additionalProperties: false,
    properties: { revision: { ...revision, minimum: 0 }, mcp: access, cli: access },
  }, "Agent 调用权限");
  return value as AgentPolicy;
}
export const policyFile = (root: string) => safe(root, "agent-access.json");
export function readPolicy(root: string): AgentPolicy {
  const path = policyFile(root);
  return present(path) ? validatePolicy(readJson(path)) :
    { revision: 0, mcp: { enabled: true, cards: [] }, cli: { enabled: true, cards: [] } };
}
