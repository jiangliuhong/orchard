import { useId, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { AgentChoice, ProviderView } from "../../domain/types.js";
import { isModelEnabled } from "../../domain/models.js";

function ProviderSelect({ id, value, placeholder, disabled, options, onChange }: {
  id: string; value: string; placeholder: string; disabled?: boolean;
  options: { id: string; name: string; disabled?: boolean }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.id === value);
  return <DropdownMenu.Root modal={false} open={open && !disabled} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild><button type="button" id={id} role="combobox" aria-haspopup="listbox" aria-expanded={open && !disabled} data-slot="select-trigger" disabled={disabled} title={selected?.name}><span data-slot="select-value">{selected?.name ?? placeholder}</span><ChevronDown size={14} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content role="listbox" aria-labelledby={id} data-slot="select-content" className="provider-picker-options" align="start" sideOffset={4} collisionPadding={12} loop>
      {options.map(option => <DropdownMenu.Item key={option.id} role="option" aria-selected={option.id === value} data-slot="select-item" title={option.name} disabled={option.disabled} textValue={option.name} onSelect={() => onChange(option.id)}><span>{option.name}</span>{option.id === value && <Check size={14} aria-hidden="true" />}</DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

export function ProviderPicker({ providers, value, onChange, disabled = false, enabledOnly = false }: { providers: ProviderView[]; value: AgentChoice; onChange: (value: AgentChoice) => void; disabled?: boolean; enabledOnly?: boolean }) {
  const provider = providers.find(p => p.id === value.providerId), id = useId();
  const hiddenSelection = enabledOnly && !!value.providerId && !provider?.enabled;
  const models = (provider?.models ?? []).filter(isModelEnabled);
  const modelUnavailable = !!value.modelId && !models.some(model => model.id === value.modelId);
  if (modelUnavailable) models.push({ id: value.modelId!, name: `${value.modelId}（已保存，当前不可用）`, source: "configured", enabled: false });
  const unavailable = !!provider && (!provider.enabled || provider.readiness.state === "unavailable");
  return <div className="provider-picker">
    <div className="field"><label htmlFor={`${id}-provider`}>Provider</label><ProviderSelect id={`${id}-provider`} value={hiddenSelection ? "" : value.providerId ?? ""} placeholder="选择 Provider" disabled={disabled} onChange={providerId => { const selected = providers.find(provider => provider.id === providerId); onChange({ providerId, modelId: selected?.defaultModel || undefined }); }} options={providers.filter(provider => !enabledOnly || provider.enabled).map(provider => ({ id: provider.id, name: `${provider.name}${!provider.enabled ? " · 已禁用" : provider.readiness.state === "unavailable" ? " · 未就绪" : ""}`, disabled: !provider.enabled || provider.readiness.state === "unavailable" }))} /></div>
    <div className="field"><label htmlFor={`${id}-model`}>模型</label><ProviderSelect id={`${id}-model`} value={hiddenSelection ? "" : value.modelId ?? ""} placeholder="选择模型" disabled={disabled || !provider || unavailable} onChange={modelId => onChange({ ...value, modelId })} options={models.map(model => ({ id: model.id, name: model.name, disabled: !isModelEnabled(model) }))} /></div>
    {unavailable && <p className="field-hint text-destructive">已保存选择当前不可用：{provider?.readiness.reason ?? "Provider 已禁用"}</p>}
    {hiddenSelection && <p className="field-hint text-destructive">请重新选择已启用的 Provider。</p>}
    {!providers.some(p => p.enabled) && <p className="field-hint">尚未启用 Provider。<a href="/settings">前往设置 →</a></p>}
    {modelUnavailable && <p className="field-hint text-destructive">已保存的模型未启用或已删除，请重新选择。</p>}
    {provider?.enabled && !provider.models.length && <p className="field-hint">模型目录为空，请在<a href="/settings">设置</a>中刷新或添加模型。</p>}
    {provider?.enabled && !!provider.models.length && !provider.models.some(isModelEnabled) && <p className="field-hint">尚未启用模型，请在<a href="/settings">设置</a>中启用。</p>}
  </div>;
}
