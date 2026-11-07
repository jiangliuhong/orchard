import { useId } from "react";
import type { AgentModelConfigView } from "../../domain/types.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

export function AgentModelConfigPicker({ configs, value, onChange, disabled = false, inherit = false, defaultId }: {
  configs: AgentModelConfigView[]; value?: string; onChange: (id: string | undefined) => void; disabled?: boolean; inherit?: boolean; defaultId?: string;
}) {
  const id = useId(), effective = configs.find(config => config.id === (value ?? (inherit ? defaultId : undefined)));
  const options = configs.filter(config => config.enabled || config.id === value);
  return <div className="agent-model-picker">
    <label className="sr-only" htmlFor={id}>{inherit ? "节点 Agent 模型配置" : "工作流默认 Agent 模型配置"}</label>
    <Select value={value ?? (inherit ? "__inherit" : "")} onValueChange={id => onChange(id === "__inherit" ? undefined : id)} disabled={disabled}>
      <SelectTrigger id={id} className="w-full"><SelectValue placeholder="选择 Agent 模型配置" /></SelectTrigger>
      <SelectContent>
        {inherit && <SelectItem value="__inherit">继承工作流默认配置</SelectItem>}
        {value && !configs.some(config => config.id === value) && <SelectItem value={value} disabled>配置不存在 · {value}</SelectItem>}
        {options.map(config => <SelectItem value={config.id} key={config.id} disabled={!config.enabled || !config.available}>{config.name}{!config.enabled ? " · 已禁用" : !config.available ? " · 不可用" : ""}</SelectItem>)}
      </SelectContent>
    </Select>
    {effective && <p className="field-hint">{effective.name} · {effective.providerId} · {effective.modelId} · 修订 {effective.revision}</p>}
    {effective && !effective.available && <p className="field-hint text-destructive">{effective.unavailableReason ?? "配置不可用，请重新选择或前往设置修复。"}</p>}
    {!effective && (value || inherit && !defaultId) && <p className="field-hint text-destructive">{value ? "引用的模型配置不存在，请重新选择。" : "尚未设置工作流默认配置，请设置默认配置或为此节点单独选择。"}</p>}
    {!configs.some(config => config.enabled && config.available) && <p className="field-hint">暂无可用模型配置，请在<a href="/settings">设置 → Agent 模型配置</a>中创建或启用。</p>}
  </div>;
}
