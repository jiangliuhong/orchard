import { check } from "./errors.js";
import { assertSchema } from "./validation.js";
import { validateScript, type ScriptDefinition } from "./scripts.js";

export interface ScriptProposal {
  summary: string;
  changes: { operation: "create" | "update" | "delete"; path: string; content?: string }[];
  metadata: Partial<Pick<ScriptDefinition, "name" | "description" | "entryFile" | "inputSchema" | "outputSchema" | "timeoutMs" | "resultMode">>;
  testInput?: unknown;
}
export const SCRIPT_PROPOSAL_SCHEMA = {
  type: "object", required: ["summary", "changes", "metadata"], additionalProperties: false,
  properties: {
    summary: { type: "string", maxLength: 10000 },
    changes: { type: "array", maxItems: 100, items: {
      type: "object", required: ["operation", "path"], additionalProperties: false,
      properties: { operation: { enum: ["create", "update", "delete"] }, path: { type: "string", minLength: 1, maxLength: 200 }, content: { type: "string", maxLength: 1048576 } },
    } },
    metadata: { type: "object", additionalProperties: false, properties: {
      name: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string", maxLength: 4000 },
      entryFile: { type: "string" }, inputSchema: { anyOf: [{ type: "object" }, { type: "boolean" }] },
      outputSchema: { anyOf: [{ type: "object" }, { type: "boolean" }] }, timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
      resultMode: { enum: ["process", "json"] },
    } },
    testInput: {},
  },
};
export function prepareScriptProposal(definition: ScriptDefinition, value: unknown) {
  assertSchema(value, SCRIPT_PROPOSAL_SCHEMA, "脚本 Agent 变更");
  const proposal = value as ScriptProposal, files = { ...definition.files }, seen = new Set<string>();
  for (const change of proposal.changes) {
    check(!seen.has(change.path), "INVALID_CHANGE", "同一文件不能重复变更");
    seen.add(change.path);
    check(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(ts|js|mjs|sh)$/.test(change.path) && !change.path.includes(".."), "INVALID_SCRIPT_PATH", "Agent 文件路径无效");
    if (change.operation === "delete") {
      check(Object.hasOwn(files, change.path) && change.content === undefined, "INVALID_CHANGE", "删除操作无效");
      delete files[change.path];
    } else {
      check(typeof change.content === "string", "INVALID_CHANGE", "缺少完整文件内容");
      check(Object.hasOwn(files, change.path) === (change.operation === "update"), "INVALID_CHANGE", "文件操作与草稿状态不一致");
      files[change.path] = change.content;
    }
  }
  const next = validateScript({ ...definition, ...proposal.metadata, files });
  if (Object.hasOwn(proposal, "testInput")) assertSchema(proposal.testInput, next.inputSchema, "Agent 测试输入");
  return { proposal, definition: next };
}
