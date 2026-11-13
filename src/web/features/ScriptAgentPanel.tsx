import { MaintenanceChat } from "../agent-chat/MaintenanceChat";
import type { ScriptDetail } from "./ScriptPages";

export function ScriptAgentPanel({ script, dirty, onApplied }: { script: ScriptDetail; dirty: boolean; onApplied: () => void }) {
  return <MaintenanceChat kind="script_draft" ownerId={script.id} className="script-agent-panel"
    disabled={dirty || script.status === "archived" || !script.currentDraftVersionId} onApplied={onApplied} />;
}
