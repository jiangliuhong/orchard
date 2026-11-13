import { MaintenanceChat } from "../agent-chat/MaintenanceChat";

export function bridgePreference(key: string, fallback = "") {
  try { return localStorage.getItem(`orchard.bridge.${key}`) ?? fallback; } catch { return fallback; }
}

export function saveBridgePreference(key: string, value: string) {
  try { localStorage.setItem(`orchard.bridge.${key}`, value); } catch {}
}

export function BridgeAgentPanel({ applicationId, disabled, onApplied, onClose }: {
  applicationId: string; disabled: boolean; onApplied: () => void; onClose: () => void;
}) {
  return <aside className="bridge-agent" aria-label="应用 Agent 维护">
    <MaintenanceChat kind="browser_application" ownerId={applicationId} disabled={disabled} onApplied={onApplied} onClose={onClose} />
  </aside>;
}
