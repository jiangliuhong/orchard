import { useEffect, useId, useRef, useState } from "react";
import { ToastNotice } from "../components/ToastNotice";
import { CheckCircle2, ChevronRight, Plus, RefreshCw, Search, Square, Trash2 } from "lucide-react";
import type { Model, ModelVerification, ProviderView } from "../../domain/types.js";
import { isModelEnabled } from "../../domain/models.js";
import { api, send } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { ErrorNotice } from "../components/common";

export function ModelManager({ provider, disabled, onUpdated }: {
  provider: ProviderView;
  disabled?: boolean;
  onUpdated: (provider: ProviderView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState(provider.models);
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [newEnabled, setNewEnabled] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [verifications, setVerifications] = useState(new Map<string, ModelVerification>());
  const verificationController = useRef<AbortController | null>(null);
  const verificationEpoch = useRef(0);
  const formId = useId();
  const base = `/providers/${encodeURIComponent(provider.id)}/models`;

  useEffect(() => {
    setModels(provider.models);
    setDefaultModel(provider.defaultModel);
  }, [provider.models, provider.defaultModel]);
  useEffect(() => {
    verificationEpoch.current++;
    verificationController.current?.abort();
    setVerifications(new Map());
  }, [provider.revision]);
  useEffect(() => () => verificationController.current?.abort(), []);

  const mutate = async (operation: string, work: () => Promise<ProviderView>, message: string | (() => string)) => {
    if (busy) return false;
    setBusy(operation); setError(""); setNotice("");
    try {
      const updated = await work();
      setModels(updated.models); setDefaultModel(updated.defaultModel); onUpdated(updated);
      const summary = typeof message === "function" ? message() : message;
      setNotice(defaultModel && !updated.defaultModel ? `${summary}，原默认模型已清空，请重新选择。` : summary);
      return true;
    } catch (error) {
      setError((error as Error).message); return false;
    } finally { setBusy(""); }
  };
  const add = async () => {
    const id = modelId.trim(), name = modelName.trim();
    if (!id) { setError("请输入模型 ID"); return; }
    if (await mutate("add", () => send<ProviderView>(base, { id, ...(name ? { name } : {}), enabled: newEnabled }), "模型已添加")) {
      setModelId(""); setModelName(""); setNewEnabled(true); setQuery("");
    }
  };
  const refresh = () => {
    let warning: string | undefined;
    return mutate("refresh", async () => {
      const result = await send<{ models: Model[]; defaultModel: string; revision: number; warning?: string }>(`${base}/refresh`);
      warning = result.warning;
      return { ...provider, models: result.models, defaultModel: result.defaultModel, revision: result.revision };
    }, () => warning ?? "模型目录已刷新");
  };
  const verify = async (model: Model) => {
    if (busy) return;
    const controller = new AbortController(), epoch = verificationEpoch.current, startedAt = Date.now();
    verificationController.current = controller;
    setBusy(`verify:${model.id}`); setError(""); setNotice("");
    const saveResult = (result: ModelVerification) => {
      if (epoch !== verificationEpoch.current) return;
      setVerifications(current => new Map(current).set(model.id, result));
    };
    try {
      const result = await api<ModelVerification>(`${base}/${encodeURIComponent(model.id)}/verify`, { method: "POST", signal: controller.signal });
      saveResult(result);
    } catch (error) {
      saveResult({
        providerId: provider.id, modelId: model.id, providerRevision: provider.revision,
        status: controller.signal.aborted ? "cancelled" : "failed", checkedAt: Date.now(), durationMs: Date.now() - startedAt,
        error: { code: controller.signal.aborted ? "CANCELLED" : "REQUEST_FAILED", message: controller.signal.aborted ? "模型验证已取消" : (error as Error).message },
      });
    } finally {
      if (verificationController.current === controller) {
        verificationController.current = null; setBusy("");
      }
    }
  };
  const filtered = models.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const enabledCount = models.filter(isModelEnabled).length;

  return <Dialog open={open} onOpenChange={value => { if (!value) verificationController.current?.abort(); setOpen(value); setPendingDelete(null); }}>
    <DialogTrigger asChild>
      <Button variant="ghost" size="xs" className="model-count-button" disabled={disabled} aria-label={`管理 ${provider.name} 模型`}>
        {provider.models.length} 个模型<ChevronRight size={12} />
      </Button>
    </DialogTrigger>
    <DialogContent className="model-dialog" aria-busy={!!busy}>
      <DialogHeader>
        <DialogTitle>{provider.name} 模型管理</DialogTitle>
        <DialogDescription>查看模型目录，管理可用模型，或添加自定义模型 ID。</DialogDescription>
      </DialogHeader>
      <div className="models-toolbar">
        <div className="models-search"><Search size={14} aria-hidden="true" /><Input aria-label="搜索模型" placeholder="搜索名称或模型 ID" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy === "refresh" ? "animate-spin" : ""} />刷新目录</Button>
      </div>
      <div className="models-summary"><span>已启用 {enabledCount} / {models.length}</span><span>设置即时保存</span></div>
      <ErrorNotice message={error} />
      <ToastNotice message={notice} onDismiss={() => setNotice("")} />
      <div className="models-list" role="list" aria-label={`${provider.name} 模型列表`}>
        {filtered.length ? filtered.map(model => {
          const verification = verifications.get(model.id), verifying = busy === `verify:${model.id}`;
          return <div className="model-row" role="listitem" key={model.id}>
          <div className="model-identity"><strong>{model.name}</strong><code>{model.id}</code>
            {verifying ? <span role="status" className="model-verification">正在验证…</span> : verification && <div role="status" className="model-verification" data-status={verification.status}>
              <span>{verification.status === "available" ? "可用" : verification.status === "cancelled" ? "已取消" : "验证失败"} · {(verification.durationMs / 1000).toFixed(2)} 秒 · {new Date(verification.checkedAt).toLocaleTimeString("zh-CN")}</span>
              {verification.error && <p>{verification.error.message}</p>}
              {verification.actualModelId && verification.actualModelId !== model.id && <p>返回模型：{verification.actualModelId}</p>}
            </div>}
          </div>
          <div className="model-meta"><span>{model.source === "configured" ? "手动添加" : "自动发现"}</span>{model.id === defaultModel && <span className="model-default">默认</span>}</div>
          <Button variant="ghost" size="sm" aria-label={verifying ? `取消验证模型 ${model.id}` : `验证模型 ${model.id}`}
            disabled={!verifying && (!!busy || !provider.enabled)} title={!provider.enabled ? "请先启用 Provider" : "发起一次真实请求，可能产生少量用量"}
            onClick={() => verifying ? verificationController.current?.abort() : void verify(model)}>
            {verifying ? <><Square size={12} />取消</> : <><CheckCircle2 size={14} />验证</>}
          </Button>
          <label className="provider-toggle">
            <input type="checkbox" aria-label={`启用模型 ${model.id}`} checked={isModelEnabled(model)} disabled={!!busy} onChange={event => void mutate(`toggle:${model.id}`, () => api<ProviderView>(`${base}/${encodeURIComponent(model.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: event.target.checked }) }), "模型设置已保存")} />
            <span className="switch-track" aria-hidden="true" />
          </label>
          {pendingDelete === model.id
            ? <div className="model-delete-confirm"><span>确认删除？</span><Button size="xs" variant="ghost" disabled={!!busy} aria-label={`取消删除模型 ${model.id}`} onClick={() => setPendingDelete(null)}>取消</Button><Button size="xs" variant="destructive" disabled={!!busy} aria-label={`确认删除模型 ${model.id}`} onClick={async () => {
              if (await mutate(`delete:${model.id}`, () => send<ProviderView>(`${base}/${encodeURIComponent(model.id)}`, undefined, "DELETE"), "模型已删除")) setPendingDelete(null);
            }}>删除</Button></div>
            : <Button variant="ghost" size="icon-xs" aria-label={`删除模型 ${model.id}`} disabled={!!busy} onClick={() => setPendingDelete(model.id)}><Trash2 size={14} /></Button>}
        </div>;
        }) : <div className="models-empty">{models.length ? "没有匹配的模型。" : "还没有模型，可刷新目录或手动添加。"}</div>}
      </div>
      <form className="model-add-form" onSubmit={event => { event.preventDefault(); void add(); }}>
        <h3>添加模型</h3>
        <div className="model-add-fields">
          <div className="field"><label htmlFor={`${formId}-id`}>模型 ID</label><Input id={`${formId}-id`} required maxLength={200} value={modelId} onChange={event => setModelId(event.target.value)} placeholder="例如 provider/model-name" disabled={!!busy} /></div>
          <div className="field"><label htmlFor={`${formId}-name`}>显示名称（可选）</label><Input id={`${formId}-name`} maxLength={200} value={modelName} onChange={event => setModelName(event.target.value)} placeholder="留空使用模型 ID" disabled={!!busy} /></div>
        </div>
        <div className="model-add-actions"><label><input type="checkbox" checked={newEnabled} onChange={event => setNewEnabled(event.target.checked)} disabled={!!busy} />添加后启用</label><Button type="submit" size="sm" disabled={!!busy || !modelId.trim()}><Plus size={14} />添加模型</Button></div>
      </form>
      <p className="field-hint models-footnote">禁用或删除会阻止后续调用；进行中的调用按原配置完成。原默认模型被禁用或删除后，需要重新选择。</p>
      <p className="field-hint models-footnote">验证会发起一次真实模型请求，可能产生少量用量，最多等待 60 秒。结果仅反映本次请求，不会更改启用状态。</p>
    </DialogContent>
  </Dialog>;
}
