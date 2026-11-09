import { AUTHORING_PROMPT_RULES } from "./context.js";
import { AUTHORING_SCHEMA } from "./service.js";
import { SCRIPT_PROPOSAL_SCHEMA } from "../domain/script-authoring.js";
import { BRIDGE_PROPOSAL_SCHEMA } from "../web-bridge/authoring.js";
import { SCRIPT_AGENT_PROMPT, bridgeAgentSystemPrompt } from "./default-prompts.js";

/** Only code-defined defaults; never read business data or provider credentials. */
export function defaultAgentPromptPreviews() {
  return { items: [
    { id: "workflow", name: "工作流", prompt: AUTHORING_PROMPT_RULES.join("\n"), schema: AUTHORING_SCHEMA,
      contextNote: "运行时追加可用 Provider、模型配置、工作流草稿、用户请求及会话上下文。" },
    { id: "web-bridge", name: "Web Bridge 工具", prompt: bridgeAgentSystemPrompt("example-app"), schema: BRIDGE_PROPOSAL_SCHEMA,
      contextNote: "example-app 是应用 ID 占位示例。运行时替换为当前应用，并追加配置快照、所选工具、测试上下文、会话历史和用户请求。" },
    { id: "script", name: "脚本", prompt: SCRIPT_AGENT_PROMPT, schema: SCRIPT_PROPOSAL_SCHEMA,
      contextNote: "运行时追加脚本草稿、版本、测试信息、会话历史和用户请求。" },
  ] };
}
