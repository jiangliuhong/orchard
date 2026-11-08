import { useState } from "react";
import { Plus, Pencil } from "lucide-react";
import type { AgentChoice, AgentModelConfigView, ProviderView } from "../../domain/types.js";
import type { AgentModelConfigReference } from "../../authoring/agent-model-configs.js";
import { isModelEnabled } from "../../domain/models.js";
import { send, useCommandKey, useResource } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { ErrorNotice, Loading } from "../components/common";
import { ProviderPicker } from "./ProviderPicker";

export function AgentModelConfigSettings({ providers }: { providers: ProviderView[] }) {
  const resource = useResource<{ items: AgentModelConfigView[] }>("/agent-model-configs");
  const [editor, setEditor] = useState<{ config?: AgentModelConfigView } | null>(null);
  const [references, setReferences] = useState<AgentModelConfigView | null>(null);
  return <>
    <div className="settings-section-heading"><Button onClick={() => setEditor({})}><Plus size={14} />新增配置</Button></div>
    <ErrorNotice message={resource.error} />
    {!resource.data ? !resource.error && <Loading /> : resource.data.items.length ? <div className="agent-model-config-list">
      {resource.data.items.map(config => <section className="panel agent-model-config-card" key={config.id}>
        <div className="agent-model-config-info"><h3>{config.name}<span className={`readiness ${config.available ? "readiness-ready" : "readiness-unavailable"}`}>{!config.enabled ? "已禁用" : config.available ? "可用" : "不可用"}</span></h3>
          {config.description && <p>{config.description}</p>}
          <p className="field-hint">{providers.find(provider => provider.id === config.providerId)?.name ?? config.providerId} · {config.modelId} · 修订 {config.revision}</p>
          {config.unavailableReason && <p className="field-hint text-destructive">{config.unavailableReason}</p>}
        </div>
        <div className="actions"><Button variant="ghost" onClick={() => setReferences(config)} aria-label={`查看 ${config.name} 的引用`}>{config.workflowCount} 个工作流 · {config.draftCount} 个草稿</Button><Button variant="outline" onClick={() => setEditor({ config })} aria-label={`编辑模型配置 ${config.name}`}><Pencil size={13} />编辑</Button></div>
      </section>)}
    </div> : <div className="panel empty"><h3>还没有 Agent 模型配置</h3><p>例如创建「xxx 分析」，绑定一个已启用的 Provider 和模型，再在工作流中引用。</p><Button onClick={() => setEditor({})}>新增配置</Button></div>}
    <p className="page-footnote">修改配置只影响后续新创建的运行，无需重新发布工作流。排队和执行中的运行保留原绑定。</p>
    {editor && <AgentModelConfigEditor config={editor.config} providers={providers} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); resource.reload(); }} />}
    {references && <AgentModelConfigReferences config={references} onClose={() => setReferences(null)} />}
  </>;
}

function AgentModelConfigEditor({ config, providers, onClose, onSaved }: { config?: AgentModelConfigView; providers: ProviderView[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(config?.name ?? ""), [description, setDescription] = useState(config?.description ?? "");
  const [choice, setChoice] = useState<AgentChoice>({ providerId: config?.providerId, modelId: config?.modelId });
  const [enabled, setEnabled] = useState(config?.enabled ?? true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const commandKey = useCommandKey();
  const provider = providers.find(provider => provider.id === choice.providerId);
  const validChoice = provider?.enabled && provider.models.some(model => model.id === choice.modelId && isModelEnabled(model));
  const unchangedDisabledChoice = !enabled && config && config.providerId === choice.providerId && config.modelId === choice.modelId;
  const save = async () => {
    setBusy(true); setError("");
    try {
      const input = { name: name.trim(), description: description.trim(), ...choice, enabled, ...(config ? { expectedRevision: config.revision } : {}) };
      await send(config ? `/agent-model-configs/${config.id}` : "/agent-model-configs", { ...input, requestId: commandKey(input) }, config ? "PATCH" : "POST");
      onSaved();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="agent-model-config-editor">
    <DialogHeader><DialogTitle>{config ? "编辑 Agent 模型配置" : "新增 Agent 模型配置"}</DialogTitle><DialogDescription>{config ? `此配置被 ${config.workflowCount} 个工作流、${config.draftCount} 个草稿引用。保存后仅影响新创建的运行。` : "选择一个明确的 Provider 和模型，工作流通过配置名称引用。"}</DialogDescription></DialogHeader>
    <div className="field"><label htmlFor="agent-config-name">配置名称</label><Input id="agent-config-name" value={name} maxLength={100} disabled={busy} onChange={event => setName(event.target.value)} placeholder="例如：xxx 分析" /></div>
    <div className="field"><label htmlFor="agent-config-description">说明</label><Textarea id="agent-config-description" value={description} maxLength={2000} disabled={busy} onChange={event => setDescription(event.target.value)} rows={2} /></div>
    <ProviderPicker providers={providers} value={choice} onChange={setChoice} enabledOnly disabled={busy} />
    <label className="agent-model-config-enabled"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />启用此配置</label>
    <ErrorNotice message={error} />
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button disabled={busy || !name.trim() || !(validChoice || unchangedDisabledChoice)} onClick={() => void save()}>{busy ? "保存中…" : config ? "确认修改" : "创建配置"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function AgentModelConfigReferences({ config, onClose }: { config: AgentModelConfigView; onClose: () => void }) {
  const resource = useResource<{ items: AgentModelConfigReference[] }>(`/agent-model-configs/${config.id}/references`);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>「{config.name}」的引用</DialogTitle><DialogDescription>列出引用此配置的草稿和发布版本；修改配置对后续新创建的运行生效。</DialogDescription></DialogHeader>
    <ErrorNotice message={resource.error} />
    {!resource.data ? !resource.error && <Loading /> : <div className="agent-model-reference-list">{resource.data.items.length ? resource.data.items.map(item => <a key={`${item.kind}:${item.id}`} href={item.kind === "draft" ? `/drafts/${item.id}` : `/workflows/${item.workflowId}?versionId=${encodeURIComponent(item.id)}`}><strong>{item.name}</strong><span>{item.kind === "draft" ? "草稿" : `v${item.version}${item.current ? " · 当前发布版本" : " · 历史版本"}`}</span></a>) : <p className="field-hint">此配置暂无工作流引用。</p>}</div>}
  </DialogContent></Dialog>;
}
