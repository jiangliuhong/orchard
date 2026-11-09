import { useEffect, useState } from "react";
import type { AgentModelConfigView } from "../../domain/types.js";
import { send, useResource } from "../lib/api";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ErrorNotice } from "../components/common";
import { ToastNotice } from "../components/ToastNotice";

export interface MessageAgentSetting {
  agentConfigId: string | null;
  name?: string;
  providerId?: string;
  modelId?: string;
  available: boolean;
  unavailableReason?: string;
}

export function ConfigGitMessageAgentSettings({ setting, onSaved }: { setting: MessageAgentSetting; onSaved: () => void }) {
  const configs = useResource<{ items: AgentModelConfigView[] }>("/agent-model-configs");
  const [selected, setSelected] = useState(setting.agentConfigId ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => { setSelected(setting.agentConfigId ?? ""); }, [setting.agentConfigId]);
  const current = configs.data?.items.find(config => config.id === selected);
  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      await send("/config-git/message-agent", { agentConfigId: selected || null }, "PUT");
      setNotice("生成描述的 Agent 已保存"); onSaved();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="management-section config-git-message-agent" aria-label="变更描述生成设置">
    <div><h3>变更描述</h3><p className="field-hint">配置同步时，使用此 Agent 模型配置生成提交描述。</p></div>
    <ErrorNotice message={configs.error || error} />
    <div className="config-git-agent-setting-row">
      <div className="field"><label htmlFor="config-git-message-agent">生成描述的 Agent</label>
        <Select value={selected || "__none"} disabled={busy || !configs.data} onValueChange={value => { setSelected(value === "__none" ? "" : value); setNotice(""); }}>
          <SelectTrigger id="config-git-message-agent" className="w-full"><SelectValue placeholder="选择 Agent 模型配置" /></SelectTrigger>
          <SelectContent><SelectItem value="__none">不使用 Agent 生成</SelectItem>
            {selected && configs.data && !configs.data.items.some(config => config.id === selected) && <SelectItem value={selected} disabled>配置不存在</SelectItem>}
            {configs.data?.items.map(config => <SelectItem key={config.id} value={config.id} disabled={!config.available}>{config.name}{!config.enabled ? " · 已禁用" : !config.available ? " · 不可用" : ""}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Button size="sm" variant="outline" disabled={busy || !configs.data || selected === (setting.agentConfigId ?? "") || !!selected && !current?.available} onClick={() => void save()}>{busy ? "保存中…" : "保存 Agent 设置"}</Button>
    </div>
    {current && <p className="field-hint">{current.providerId} · {current.modelId}</p>}
    {setting.unavailableReason && <p className="field-hint text-destructive">{setting.unavailableReason}</p>}
    {configs.data && !configs.data.items.some(config => config.available) && <p className="field-hint">暂无可用配置，请先在<a href="/settings?section=agent-models">设置 → Agent 模型配置</a>中创建或启用。</p>}
    <ToastNotice message={notice} onDismiss={() => setNotice("")} />
  </section>;
}
