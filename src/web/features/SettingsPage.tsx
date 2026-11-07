import { useState } from "react";
import { ChevronDown, Globe, PlugZap, RefreshCw, Save, Settings2, Terminal, Boxes } from "lucide-react";
import type { ProviderView } from "../../domain/types.js";
import { isModelEnabled } from "../../domain/models.js";
import { api, send, useResource } from "../lib/api";
import { ThemePicker } from "../lib/theme";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ErrorNotice, Loading } from "../components/common";
import { ModelManager } from "./ModelManager";
import { WebBridgeSettings } from "./WebBridgeSettings";
import { AgentModelConfigSettings } from "./AgentModelConfigSettings";

function ProviderRow({ provider, reload }: { provider: ProviderView; reload: () => void }) {
  const localCli = typeof provider.config.executable === "string";
  const [enabled, setEnabled] = useState(provider.enabled);
  const [expanded, setExpanded] = useState(false);
  const [executable, setExecutable] = useState(String(provider.config.executable ?? ""));
  const [configText, setConfigText] = useState(JSON.stringify(provider.config, null, 2));
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const Icon = localCli ? Terminal : PlugZap;
  const availableModels = provider.models.filter(isModelEnabled);
  if (defaultModel && !availableModels.some(model => model.id === defaultModel)) {
    availableModels.push({ id: defaultModel, name: `${defaultModel}（未启用）`, source: "configured", enabled: false });
  }

  const action = async (name: string, work: () => Promise<unknown>) => {
    setBusy(name); setError(""); setNotice("");
    try { await work(); reload(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(""); }
  };
  const patch = (value: unknown) => api(`/providers/${provider.id}`, { method: "PATCH", body: JSON.stringify(value) });
  const save = () => action("save", async () => {
    await patch({
      enabled,
      config: localCli ? { ...provider.config, executable, transport: "native" } : JSON.parse(configText),
    });
    setNotice("设置已保存");
  });
  const toggle = (next: boolean) => action("toggle", async () => {
    setEnabled(next);
    try { await patch({ enabled: next }); }
    catch (error) { setEnabled(!next); throw error; }
  });
  const selectModel = (next: string) => action("model", async () => {
    const previous = defaultModel;
    setDefaultModel(next);
    try { await patch({ defaultModel: next }); }
    catch (error) { setDefaultModel(previous); throw error; }
  });
  const readiness = provider.readiness.state === "ready"
    ? localCli ? "CLI 可用" : "连接可用"
    : provider.readiness.state === "unavailable" ? "未就绪" : "尚未检测";

  return <section className="provider-row" aria-busy={!!busy}>
    <div className="provider-row-main">
      <div className="provider-icon"><Icon size={20} /></div>
      <div className="provider-identity">
        <h2>{provider.name}</h2>
        <div className={`readiness readiness-${provider.readiness.state}`}>
          <span className="status-dot" />{readiness}
          <span>·</span><ModelManager provider={provider} disabled={!!busy} onUpdated={updated => { setDefaultModel(updated.defaultModel); reload(); }} />
        </div>
      </div>
      <div className="provider-model">
        <Select value={defaultModel} onValueChange={value => void selectModel(value)} disabled={!!busy || !availableModels.some(isModelEnabled)}>
          <SelectTrigger className="w-full" aria-label={`${provider.name} 默认模型`}>
            <SelectValue placeholder="配置默认模型" />
          </SelectTrigger>
          <SelectContent>{availableModels.map(model => <SelectItem key={model.id} value={model.id} disabled={!isModelEnabled(model)}>{model.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Button variant="ghost" size="sm" disabled={!!busy} aria-label={`检测 ${provider.name}`} onClick={() => void action("detect", () => send(`/providers/${provider.id}/detect`))}>
        <RefreshCw size={14} className={busy === "detect" ? "animate-spin" : ""} /><span>检测</span>
      </Button>
      <label className="provider-toggle">
        <input type="checkbox" checked={enabled} disabled={!!busy} onChange={event => void toggle(event.target.checked)} aria-label={`启用 ${provider.name}`} />
        <span className="switch-track" aria-hidden="true" />
      </label>
      <Button variant="ghost" size="sm" className="provider-expand" aria-label={`配置 ${provider.name}`} aria-expanded={expanded} aria-controls={`${provider.id}-details`} onClick={() => setExpanded(value => !value)}>
        配置<ChevronDown size={14} className={expanded ? "rotate-180" : ""} />
      </Button>
    </div>
    {error && <div className="provider-feedback"><ErrorNotice message={error} /></div>}
    {notice && <p role="status" className="provider-feedback success-note">{notice}</p>}
    {expanded && <div className="provider-config" id={`${provider.id}-details`}>
      <div className="provider-config-heading"><code>{provider.id}</code>{provider.readiness.version && <span>{provider.readiness.version}</span>}</div>
      {provider.readiness.reason && <p className="field-hint">{provider.readiness.reason}</p>}
      {localCli
        ? <div className="field provider-path"><label htmlFor={`${provider.id}-path`}>CLI 可执行文件</label><Input id={`${provider.id}-path`} value={executable} onChange={event => setExecutable(event.target.value)} /></div>
        : <div className="field provider-path"><label htmlFor={`${provider.id}-config`}>连接配置 JSON</label><Textarea id={`${provider.id}-config`} value={configText} onChange={event => setConfigText(event.target.value)} rows={5} /></div>}
      {provider.id === "codex-cli" && <p className="field-hint">沿用本机 Codex 用户配置，支持 Magpie 等自定义网关和模型目录。刷新模型后使用模型 ID；显示名称不会作为调用 ID。</p>}
      <p className="field-hint">点击名称旁的模型数量管理模型，在列表行选择已启用的默认模型。</p>
      <div className="provider-config-footer">
        <div className="provider-capabilities"><span>{provider.capabilities.structuredOutput === "native" ? "原生结构化输出" : "宿主校验输出"}</span><span>{provider.capabilities.textStream ? "文本事件流" : "最终消息"}</span><span>原生协议</span></div>
        <div className="actions">
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void action("models", async () => {
            const result = await send<{ warning?: string }>(`/providers/${provider.id}/models/refresh`);
            setNotice(result.warning ?? "模型目录已刷新");
          })}><RefreshCw size={14} />刷新模型</Button>
          <Button size="sm" onClick={() => void save()} disabled={!!busy}><Save size={14} />{busy === "save" ? "保存中…" : "保存设置"}</Button>
        </div>
      </div>
    </div>}
  </section>;
}

export function SettingsPage() {
  const { data, error, reload } = useResource<{ items: ProviderView[] }>("/providers");
  const [section, setSection] = useState<"general" | "providers" | "web-bridge" | "agent-models">("general");
  return <>
    <div className="settings-layout">
      <aside className="settings-sidebar" aria-label="设置分类">
        <h1>设置</h1>
        <nav className="settings-sidebar-nav">
          <button className={section === "general" ? "active" : ""} aria-current={section === "general" ? "page" : undefined} onClick={() => setSection("general")}><Settings2 size={16} />常规</button>
          <button className={section === "providers" ? "active" : ""} aria-current={section === "providers" ? "page" : undefined} onClick={() => setSection("providers")}><PlugZap size={16} />Provider</button>
          <button className={section === "agent-models" ? "active" : ""} aria-current={section === "agent-models" ? "page" : undefined} onClick={() => setSection("agent-models")}><Boxes size={16} />Agent 模型配置</button>
          <button className={section === "web-bridge" ? "active" : ""} aria-current={section === "web-bridge" ? "page" : undefined} onClick={() => setSection("web-bridge")}><Globe size={16} />Web Bridge</button>
        </nav>
      </aside>
      <section className="settings-content">
      {section === "providers" && <>
        <div className="settings-section-heading"><div><h2>Provider</h2><p>管理模型连接、默认模型与本机 CLI。</p></div><span className="field-hint">{data?.items.length ?? 0} 个连接</span></div>
        <ErrorNotice message={error} />
        {data ? <div className="panel providers-list">{data.items.map(provider => <ProviderRow key={provider.id} provider={provider} reload={reload} />)}</div> : !error && <Loading />}
        <p className="page-footnote">启用开关和默认模型即时保存。工作流通过 Agent 模型配置引用明确的模型。</p>
      </>}
      {section === "web-bridge" && <WebBridgeSettings />}
      {section === "agent-models" && <><ErrorNotice message={error} /><AgentModelConfigSettings providers={data?.items ?? []} /></>}
      {section === "general" && <>
        <div className="settings-section-heading"><div><h2>常规</h2><p>管理 Orchard 的外观与使用偏好。</p></div></div>
        <section className="panel preferences-list" aria-label="外观设置">
          <div className="preference-row"><div><h2>外观</h2><p>选择浅色、深色，或跟随系统。</p></div><ThemePicker label="设置外观" /></div>
        </section>
      </>}
      </section>
    </div>
  </>;
}
