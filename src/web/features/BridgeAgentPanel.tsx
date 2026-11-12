import { AgentChat } from "../agent-chat/AgentChat";
import { MaintenanceOwnerPanel } from "../agent-chat/MaintenanceOwnerPanel";
import { browserApplicationChatConfig, type BrowserApplicationChatContext } from "../agent-chat/adapters/browser-application";

export { bridgePreference, saveBridgePreference } from "../agent-chat/adapters/browser-application";
export type { BridgeAgentHistory, BridgeTurnView } from "../agent-chat/adapters/browser-application";

export function BridgeAgentPanel({ onClose, onApplied, disabled, ...context }: BrowserApplicationChatContext & { onClose: () => void; onApplied?: () => void; disabled?: boolean }) {
  return <aside className="bridge-agent" aria-label="应用 Agent 维护">
    <MaintenanceOwnerPanel key={context.application.id} kind="browser_application" ownerId={context.application.id} onApplied={onApplied} onClose={onClose} disabled={disabled}>
      <AgentChat config={browserApplicationChatConfig} context={context} resourceKey={context.application.id} onClose={onClose} />
    </MaintenanceOwnerPanel>
  </aside>;
}
