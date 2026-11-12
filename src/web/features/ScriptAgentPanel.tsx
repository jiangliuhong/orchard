import { AgentChat } from "../agent-chat/AgentChat";
import { MaintenanceOwnerPanel } from "../agent-chat/MaintenanceOwnerPanel";
import { scriptChatConfig, type ScriptChatContext } from "../agent-chat/adapters/script";

export { ScriptAgentPreview } from "./ScriptAgentPreview";

export function ScriptAgentPanel(context: ScriptChatContext) {
  return <MaintenanceOwnerPanel key={context.script.id} kind="script_draft" ownerId={context.script.id} disabled={context.dirty} onApplied={context.onApplied}>
    <AgentChat config={scriptChatConfig} context={context} resourceKey={`${context.script.id}:${context.script.currentDraftVersionId}`} className="script-agent-panel" />
  </MaintenanceOwnerPanel>;
}
