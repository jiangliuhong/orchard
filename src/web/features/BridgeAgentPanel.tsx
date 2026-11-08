import { AgentChat } from "../agent-chat/AgentChat";
import { browserApplicationChatConfig, type BrowserApplicationChatContext } from "../agent-chat/adapters/browser-application";

export { bridgePreference, saveBridgePreference } from "../agent-chat/adapters/browser-application";
export type { BridgeAgentHistory, BridgeTurnView } from "../agent-chat/adapters/browser-application";

export function BridgeAgentPanel({ onClose, ...context }: BrowserApplicationChatContext & { onClose: () => void }) {
  return <aside className="bridge-agent" aria-label="应用 Agent 维护"><AgentChat config={browserApplicationChatConfig} context={context} resourceKey={context.application.id} onClose={onClose} /></aside>;
}
