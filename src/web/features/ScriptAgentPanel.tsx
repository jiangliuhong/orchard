import { AgentChat } from "../agent-chat/AgentChat";
import { scriptChatConfig, type ScriptChatContext } from "../agent-chat/adapters/script";

export { ScriptAgentPreview } from "./ScriptAgentPreview";

export function ScriptAgentPanel(context: ScriptChatContext) {
  return <AgentChat config={scriptChatConfig} context={context} resourceKey={`${context.script.id}:${context.script.currentDraftVersionId}`} className="script-agent-panel" />;
}
