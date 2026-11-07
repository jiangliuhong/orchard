import { useId } from "react";
import type { AgentChoice, ProviderView } from "../../domain/types.js";
import { isModelEnabled } from "../../domain/models.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

export function ProviderPicker({ providers, value, onChange, disabled = false, enabledOnly = false }: { providers: ProviderView[]; value: AgentChoice; onChange: (value: AgentChoice) => void; disabled?: boolean; enabledOnly?: boolean }) {
  const provider = providers.find(p => p.id === value.providerId), id = useId();
  const hiddenSelection = enabledOnly && !!value.providerId && !provider?.enabled;
  const models = (provider?.models ?? []).filter(isModelEnabled);
  const modelUnavailable = !!value.modelId && !models.some(model => model.id === value.modelId);
  if (modelUnavailable) models.push({ id: value.modelId!, name: `${value.modelId}（已保存，当前不可用）`, source: "configured", enabled: false });
  const unavailable = !!provider && (!provider.enabled || provider.readiness.state === "unavailable");
  return <div className="provider-picker">
    <div className="field"><label htmlFor={`${id}-provider`}>Provider</label><Select value={hiddenSelection ? "" : value.providerId ?? ""} onValueChange={providerId => { const p = providers.find(p => p.id === providerId); onChange({ providerId, modelId: p?.defaultModel || undefined }); }} disabled={disabled}>
      <SelectTrigger id={`${id}-provider`} className="w-full"><SelectValue placeholder="选择 Provider" /></SelectTrigger>
      <SelectContent>{providers.filter(p => !enabledOnly || p.enabled).map(p => <SelectItem key={p.id} value={p.id} disabled={!p.enabled || p.readiness.state === "unavailable"}>{p.name}{!p.enabled ? " · 已禁用" : p.readiness.state === "unavailable" ? " · 未就绪" : ""}</SelectItem>)}</SelectContent>
    </Select></div>
    <div className="field"><label htmlFor={`${id}-model`}>模型</label><Select value={hiddenSelection ? "" : value.modelId ?? ""} onValueChange={modelId => onChange({ ...value, modelId })} disabled={disabled || !provider || unavailable}>
      <SelectTrigger id={`${id}-model`} className="w-full"><SelectValue placeholder="选择模型" /></SelectTrigger>
      <SelectContent>{models.map(model => <SelectItem key={model.id} value={model.id} disabled={!isModelEnabled(model)}>{model.name}</SelectItem>)}</SelectContent>
    </Select></div>
    {unavailable && <p className="field-hint text-destructive">已保存选择当前不可用：{provider?.readiness.reason ?? "Provider 已禁用"}</p>}
    {hiddenSelection && <p className="field-hint text-destructive">请重新选择已启用的 Provider。</p>}
    {!providers.some(p => p.enabled) && <p className="field-hint">尚未启用 Provider。<a href="/settings">前往设置 →</a></p>}
    {modelUnavailable && <p className="field-hint text-destructive">已保存的模型未启用或已删除，请重新选择。</p>}
    {provider?.enabled && !provider.models.length && <p className="field-hint">模型目录为空，请在<a href="/settings">设置</a>中刷新或添加模型。</p>}
    {provider?.enabled && !!provider.models.length && !provider.models.some(isModelEnabled) && <p className="field-hint">尚未启用模型，请在<a href="/settings">设置</a>中启用。</p>}
  </div>;
}
