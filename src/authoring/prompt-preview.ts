import { AUTHORING_PROMPT_RULES } from "./context.js";
import { AUTHORING_SCHEMA } from "./service.js";
import { SCRIPT_PROPOSAL_SCHEMA } from "../domain/script-authoring.js";
import { BRIDGE_PROPOSAL_SCHEMA } from "../web-bridge/authoring.js";
import { SCRIPT_AGENT_PROMPT, bridgeAgentSystemPrompt } from "./default-prompts.js";

/** Only code-defined defaults; never read business data or provider credentials. */
export function defaultAgentPromptPreviews() {
  return { items: [
    { id: "workflow", name: "工作流", prompt: AUTHORING_PROMPT_RULES.join("\n"), schema: AUTHORING_SCHEMA,
      contextNote: "运行时追加可用 Provider、模型配置、工作流草稿及用户请求。多轮续接原生会话；显式重建时完整回放源对话链的已保存消息和 proposal，超限明确拒绝、不截断历史；单轮保持隔离。" },
    { id: "web-bridge", name: "Web Bridge 工具", prompt: bridgeAgentSystemPrompt("example-app"), schema: BRIDGE_PROPOSAL_SCHEMA,
      contextNote: "example-app 是应用 ID 占位示例。运行时替换为当前应用，并追加配置快照、所选工具、测试上下文、会话历史和用户请求。" },
    { id: "script", name: "脚本", prompt: SCRIPT_AGENT_PROMPT, schema: SCRIPT_PROPOSAL_SCHEMA,
      contextNote: "运行时追加当前完整脚本草稿、版本、测试信息、同一对话及草稿版本的全部历史请求与完整 Agent proposal（含失败状态、应用状态）和本轮用户请求；超过上下文大小限制时明确拒绝，不截断历史。" },
  ] };
}
