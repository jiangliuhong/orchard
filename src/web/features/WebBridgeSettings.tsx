import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Check, Copy, Globe, MessageSquare, Plus, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import type { WebBridgeTool } from "../../web-bridge/catalog";
import { normalizeToolIdentity, validateToolId } from "../../web-bridge/tool-identity";
import { api, pretty, send, useResource } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { BridgeParameterInputs } from "./BridgeParameterInputs";
import { BridgeExecutionHistory } from "./BridgeExecutionHistory";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Breadcrumbs, ErrorNotice, Loading } from "../components/common";
import { BridgeAgentPanel, bridgePreference, saveBridgePreference, type BridgeTurnView } from "./BridgeAgentPanel";
import { BridgeToolForm } from "./BridgeToolForm";
import { BridgeCredentialInputs } from "./BridgeCredentialInputs";
import type { CredentialBindings } from "../../web-bridge/credential-inputs";
import { credentialProperties, credentialRequired, missingCredentials } from "../../web-bridge/credential-schema";
import { historyValue, pointerPart, restoredCredentials, type HistorySources } from "../../web-bridge/history-policy";
import { ToastNotice } from "../components/ToastNotice";

interface Environment { id: string; origin: string; profileId?: string; extensionId?: string; enabled: boolean; bound: boolean; tabAvailable: boolean }
interface Application { id: string; name: string; enabled: boolean; environments: Environment[] }
interface BrowserProfile { id: string; name: string; extensionId: string; connected: boolean; lastSeen: number }
interface ToolDraft { application: string; toolId?: string; value: string; original: string }
interface TestState { environmentId?: string; args: string; output: string; error: string; busy: boolean; historySources?: HistorySources; historyNotice?: string }
const emptyTest = (): TestState => ({ args: "{}", output: "", error: "", busy: false });
const BridgeDiff = lazy(() => import("./CodeEditor").then(module => ({ default: module.CodeDiffEditor })));
const newTool = (application: string): WebBridgeTool => ({
  application, toolId: "", site: application, description: "", parameters: { type: "object", properties: {}, additionalProperties: false },
  path: "/api/", method: "GET", fields: [], risk: "read", approval: "none", timeoutMs: 30000, catalogVersion: "1", enabled: true,
});

export function WebBridgeSettings() {
  const apps = useResource<{ items: Application[] }>("/web-bridge/applications");
  const tools = useResource<{ items: WebBridgeTool[] }>("/web-bridge/tools");
  const profiles = useResource<{ items: BrowserProfile[] }>("/web-bridge/profiles");
  const extension = useResource<{ directory: string }>("/web-bridge/extension");
  const [selectedId, setSelectedId] = useState(() => bridgePreference("application"));
  const [appQuery, setAppQuery] = useState(""), [toolQuery, setToolQuery] = useState("");
  const [tab, setTab] = useState(() => bridgePreference("tab", "tools"));
  const [agentOpen, setAgentOpen] = useState(() => bridgePreference("agentOpen", "true") === "true");
  const [connectionsOpen, setConnectionsOpen] = useState(false), [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [applicationId, setApplicationId] = useState(""), [applicationName, setApplicationName] = useState("");
  const [origin, setOrigin] = useState(""), [profileId, setProfileId] = useState(""), [environmentId, setEnvironmentId] = useState<string>();
  const [draft, setDraft] = useState<ToolDraft>(), [editorTab, setEditorTab] = useState("definition"), [editorError, setEditorError] = useState("");
  const [editorMode, setEditorMode] = useState("form"), [formInvalid, setFormInvalid] = useState(false);
  const [saveAsToolId, setSaveAsToolId] = useState<string>();
  const [agentWidth, setAgentWidth] = useState(() => Number(bridgePreference("agentWidth", "340")) || 340);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [testParametersInvalid, setTestParametersInvalid] = useState(false);
  const [credentialBindings, setCredentialBindings] = useState<CredentialBindings>({});
  const [review, setReview] = useState<BridgeTurnView>(), [agentRefresh, setAgentRefresh] = useState(0);
  const [deletion, setDeletion] = useState<{ title: string; description: string; action: () => Promise<void>; execution?: boolean }>();
  const [pendingNavigation, setPendingNavigation] = useState<{ action: () => void }>();
  const saving = useRef(false), saveCallback = useRef<(() => void) | undefined>(undefined);
  const selected = apps.data?.items.find(application => application.id === selectedId) ?? apps.data?.items[0];
  const selectedTools = useMemo(() => tools.data?.items.filter(tool => tool.application === selected?.id) ?? [], [tools.data, selected?.id]);
  const dirty = !!draft && (draft.value !== draft.original || formInvalid);
  const draftDefinition = useMemo(() => {
    try {
      const value: unknown = JSON.parse(draft?.value ?? "null");
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch { return undefined; }
  }, [draft?.value]);
  const applicationConflict = !!draft && draftDefinition?.application !== undefined && draftDefinition.application !== draft.application;
  const testKey = draft ? `${draft.application}/${draft.toolId ?? "new"}` : "";
  const test = tests[testKey] ?? emptyTest();
  const persistedTool = selectedTools.find(tool => tool.toolId === draft?.toolId);
  useEffect(() => { setCredentialBindings({}); }, [testKey, selectedId]);
  useEffect(() => {
    if (editorTab !== "test" || tab !== "tools" || review) setCredentialBindings(current => Object.fromEntries(Object.entries(current).filter(([, binding]) => binding.source === "dictionary")));
  }, [editorTab, tab, review?.id]);
  const missing = persistedTool?.execution?.transport === "browser" ? missingCredentials(persistedTool.execution, credentialBindings) : [];
  const arrayPlaceholders = Object.entries(test.historySources ?? {}).filter(([path, source]) => {
    if (source.source !== "omitted") return false;
    try { return path !== "" && /\/\d+$/.test(path) && historyValue(JSON.parse(test.args), path) === null; } catch { return true; }
  });
  const canTest = !!persistedTool && persistedTool.enabled;
  const requiresApproval = persistedTool && (persistedTool.risk !== "read" || persistedTool.approval !== "none");
  const refresh = () => { apps.reload(); tools.reload(); profiles.reload(); };
  const run = async (action: () => Promise<void>, success?: string) => {
    if (saving.current) return false;
    saving.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); if (success) setNotice(success); return true; }
    catch (error) { setError((error as Error).message); return false; }
    finally { saving.current = false; setBusy(false); }
  };
  const guard = (action: () => void) => {
    if (saving.current) return;
    if (dirty) setPendingNavigation({ action }); else action();
  };
  const openTool = (tool?: WebBridgeTool) => {
    if (!selected) return;
    const value = pretty(tool ?? newTool(selected.id));
    setDraft({ application: selected.id, toolId: tool?.toolId, value, original: tool ? value : "" });
    setEditorTab("definition"); setEditorMode("form"); setFormInvalid(false); setEditorError(""); setReview(undefined);
    saveBridgePreference(`${selected.id}.tool`, tool?.toolId ?? "");
  };
  const selectApplication = (application: Application) => guard(() => {
    setSelectedId(application.id); setDraft(undefined); setFormInvalid(false); setReview(undefined); setEditorError(""); setToolQuery("");
    setOrigin(""); setProfileId(""); setEnvironmentId(undefined); setTab("tools");
  });
  const saveTool = async (newId?: string) => {
    if (!draft || saving.current) return false;
    setEditorError("");
    if (formInvalid) { setEditorError("请先修正表单中的 JSON 字段"); return false; }
    try {
      const parsed: unknown = JSON.parse(draft.value);
      const copying = newId !== undefined;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工具定义必须是 JSON 对象");
      const definition = normalizeToolIdentity(copying ? { ...parsed, toolId: newId.trim() } : parsed, draft.application, copying ? undefined : draft.toolId);
      validateToolId(definition.toolId);
      const existingId = copying ? undefined : draft.toolId;
      if (!existingId && selectedTools.some(tool => tool.toolId === definition.toolId)) throw new Error("工具 ID 已存在，请使用其他 ID");
      const captured = draft;
      return await run(async () => {
        const saved = await send<WebBridgeTool>(`/web-bridge/applications/${captured.application}/tools${existingId ? `/${existingId}/definition` : ""}`, definition, existingId ? "PATCH" : "POST");
        const value = pretty(saved);
        setDraft({ application: captured.application, toolId: saved.toolId, value, original: value });
        setSaveAsToolId(undefined); setEditorTab("definition");
        saveBridgePreference(`${captured.application}.tool`, saved.toolId); tools.reload();
      }, copying ? "已另存为新工具" : "工具定义已保存");
    } catch (error) { setEditorError((error as Error).message); return false; }
  };
  saveCallback.current = () => { if (saveAsToolId === undefined) void saveTool(); };
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    const keyboard = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && draft) { event.preventDefault(); saveCallback.current?.(); } };
    window.addEventListener("beforeunload", beforeUnload); window.addEventListener("keydown", keyboard);
    return () => { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("keydown", keyboard); };
  }, [dirty, !!draft]);
  useEffect(() => {
    const protectLinks = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!dirty || !anchor || anchor.getAttribute("href")?.startsWith("#")) return;
      event.preventDefault();
      setPendingNavigation({ action: () => { window.location.href = anchor.getAttribute("href")!; } });
    };
    document.addEventListener("click", protectLinks);
    return () => document.removeEventListener("click", protectLinks);
  }, [dirty]);
  useEffect(() => { if (selected) saveBridgePreference("application", selected.id); }, [selected?.id]);
  useEffect(() => { saveBridgePreference("tab", tab); }, [tab]);
  useEffect(() => { saveBridgePreference("agentOpen", String(agentOpen)); }, [agentOpen]);
  const restored = useRef("");
  useEffect(() => {
    if (!selected || !tools.data || restored.current === selected.id) return;
    restored.current = selected.id;
    const tool = selectedTools.find(item => item.toolId === bridgePreference(`${selected.id}.tool`));
    if (tool) openTool(tool);
  }, [selected?.id, tools.data]);
  useEffect(() => {
    const update = () => { if (document.visibilityState !== "hidden") profiles.reload(); };
    const interval = setInterval(update, 30000);
    window.addEventListener("focus", update);
    return () => { clearInterval(interval); window.removeEventListener("focus", update); };
  }, []);
  const testTool = async (approved = false) => {
    if (!draft?.toolId || dirty || !canTest || test.busy || testParametersInvalid || missing.length || arrayPlaceholders.length) return;
    if (requiresApproval && !approved) {
      setDeletion({ execution: true, title: "确认执行工具", description: `工具 ${draft.toolId} 的风险类型为 ${persistedTool?.risk}，将真实调用业务接口。是否继续？`, action: () => testTool(true) });
      return;
    }
    const key = testKey, application = draft.application, toolId = draft.toolId;
    try { JSON.parse(test.args); } catch { setTests(current => ({ ...current, [key]: { ...test, error: "测试参数必须是合法 JSON" } })); return; }
    setTests(current => ({ ...current, [key]: { ...test, busy: true, error: "", output: "" } }));
    try {
      const query = test.environmentId ? `?environmentId=${encodeURIComponent(test.environmentId)}` : "";
      const execution = persistedTool?.execution;
      const callBindings = execution?.transport === "browser" ? Object.fromEntries(Object.entries(credentialBindings).filter(([name, binding]) => binding.source !== "inline" || binding.value !== "" || credentialRequired(execution).includes(name) || Object.hasOwn(execution.preprocess.credentials ?? {}, name))) : {};
      const output = requiresApproval || persistedTool?.execution?.transport === "browser"
        ? await send("/web-bridge/calls", { application, tool: toolId, args: JSON.parse(test.args), environmentId: test.environmentId || undefined, approved, source: "test", ...(persistedTool?.execution?.transport === "browser" ? { credentialBindings: callBindings } : {}) })
        : await send(`/web-bridge/applications/${application}/tools/${toolId}/test${query}`, JSON.parse(test.args));
      setTests(current => ({ ...current, [key]: { ...current[key], busy: false, output: pretty(output) } }));
    } catch (error) { setTests(current => ({ ...current, [key]: { ...current[key], busy: false, error: (error as Error).message } })); }
    finally { setCredentialBindings(current => Object.fromEntries(Object.entries(current).filter(([, binding]) => binding.source === "dictionary"))); }
  };
  const reviewTurn = (turn: BridgeTurnView) => guard(() => { setReview(turn); setTab("tools"); });
  const askDeletion = (title: string, description: string, action: () => Promise<void>) => guard(() => setDeletion({ title, description, action }));
  const deleteApplication = () => {
    if (!selected) return;
    const application = selected;
    askDeletion("删除应用", `确定删除“${application.name}”吗？这会同时删除 ${application.environments.length} 个环境和 ${selectedTools.length} 个工具定义，且无法撤销。`, async () => {
      await api(`/web-bridge/applications/${application.id}`, { method: "DELETE" });
      saveBridgePreference(`${application.id}.tool`, "");
      setDraft(undefined); setReview(undefined); setFormInvalid(false); setEditorError("");
      setOrigin(""); setProfileId(""); setEnvironmentId(undefined); setToolQuery("");
      setTests(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${application.id}/`))));
      setSelectedId(apps.data?.items.find(item => item.id !== application.id)?.id ?? "");
      setTab("tools"); refresh();
    });
  };
  return <section className="bridge-desktop" aria-label="网页桥接">
    <header className="bridge-topbar"><Breadcrumbs items={[{ label: "网页桥接" }]} /><div className="actions">
      <Button variant="outline" size="sm" onClick={() => setConnectionsOpen(true)}><Globe size={14} />浏览器连接</Button>
      <Button variant="ghost" size="icon" aria-label="刷新网页桥接" onClick={refresh}><RefreshCw size={15} /></Button>
      <Button size="sm" onClick={() => guard(() => setCreateOpen(true))}><Plus size={14} />新建应用</Button>
    </div></header>
    <ErrorNotice message={error || apps.error || tools.error} />
    <ToastNotice message={notice} onDismiss={() => setNotice("")} />
    <div className={`bridge-workspace ${agentOpen && selected ? "has-agent" : ""}`} style={{ "--bridge-agent-width": `${agentWidth}px` } as CSSProperties}>
      <aside className="bridge-apps" aria-label="应用列表">
        <label className="bridge-search"><Search size={14} /><Input aria-label="搜索应用" placeholder="搜索应用…" value={appQuery} onChange={event => setAppQuery(event.target.value)} /></label>
        <div className="bridge-app-items" onKeyDown={event => {
          if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}>
          {!apps.data && !apps.error && <Loading />}
          {apps.data?.items.filter(application => `${application.name} ${application.id}`.toLowerCase().includes(appQuery.toLowerCase())).map(application => <button type="button" key={application.id} aria-label={`选择应用 ${application.name}`} aria-pressed={selected?.id === application.id} className={selected?.id === application.id ? "active" : ""} onClick={() => selectApplication(application)}>
            <Globe size={16} /><span><strong>{application.name}</strong><small>{application.id}</small></span><small>{tools.data?.items.filter(tool => tool.application === application.id).length ?? 0}</small>
          </button>)}
          {!!apps.data?.items.length && !apps.data.items.some(application => `${application.name} ${application.id}`.toLowerCase().includes(appQuery.toLowerCase())) && <p className="field-hint">没有匹配的应用</p>}
        </div>
      </aside>
      <main className="bridge-main">
        {!selected ? <div className="bridge-empty"><Globe size={32} /><h2>创建第一个网页应用</h2><p>应用用于组织环境和工具，Agent 可以协助维护工具定义。</p><Button onClick={() => setCreateOpen(true)}><Plus size={14} />添加应用</Button></div> : <>
          <header className="bridge-pane-heading"><div><strong>{selected.name}</strong><small>{selected.id}</small></div><div className="actions">{!agentOpen && <Button variant="outline" size="sm" onClick={() => setAgentOpen(true)}><MessageSquare size={14} />Agent 维护</Button>}<Button variant="ghost" size="icon" aria-label={`删除应用 ${selected.name}`} title="删除应用" disabled={busy} onClick={deleteApplication}><Trash2 size={14} /></Button></div></header>
          <nav className="bridge-tabs" aria-label="应用配置">{[["tools", "工具"], ["environments", "环境"], ["settings", "应用设置"]].map(([value, label]) => <button key={value} type="button" aria-current={tab === value ? "page" : undefined} className={tab === value ? "active" : ""} onClick={() => guard(() => { setTab(value); setReview(undefined); })}>{label}</button>)}</nav>
          <div className="bridge-main-scroll">
            {review && tab === "tools" ? <div className="bridge-review">
              <div className="bridge-toolbar"><Button variant="ghost" size="sm" onClick={() => setReview(undefined)}><ArrowLeft size={14} />返回</Button><strong>Agent 变更审阅</strong></div>
              <p className="bridge-prewrap">{review.proposal?.summary}</p>
              {review.proposal?.changes.map(change => <section key={change.toolId} className="bridge-change"><h3>{change.operation === "create" ? "新增" : change.operation === "delete" ? "删除" : "修改"} · {change.toolId}</h3><Suspense fallback={<Loading />}><BridgeDiff path={`${change.toolId}.json`} original={pretty(review.base?.find(tool => tool.toolId === change.toolId) ?? null)} modified={pretty(change.definition)} /></Suspense></section>)}
              <Button disabled={busy || !!review.appliedHash || dirty} onClick={() => void run(async () => {
                const result = await send<{ hash: string }>(`/web-bridge/applications/${selected.id}/agent/turns/${review.id}/apply`);
                setReview({ ...review, appliedHash: result.hash }); setDraft(undefined); tools.reload(); setAgentRefresh(value => value + 1);
              }, "Agent 变更已应用，请按需执行测试")}>{review.appliedHash ? "已应用" : busy ? "正在应用…" : "确认应用变更"}</Button>
            </div> : tab === "tools" ? draft ? <div className="bridge-tool-editor">
              <header className="bridge-editor-header">
              <div className="bridge-toolbar"><Button variant="ghost" size="sm" onClick={() => guard(() => { setDraft(undefined); saveBridgePreference(`${selected.id}.tool`, ""); })}><ArrowLeft size={14} />工具列表</Button><strong>{draft.toolId ?? "新增工具"}{dirty ? " · 未保存" : ""}</strong>{draft.toolId && <Button size="sm" variant="outline" disabled={busy || formInvalid} onClick={() => {
                setEditorError(""); setError("");
                setSaveAsToolId(typeof draftDefinition?.toolId === "string" && draftDefinition.toolId !== draft.toolId ? draftDefinition.toolId : "");
              }}><Copy size={13} />另存为新工具</Button>}<Button size="sm" disabled={busy || !dirty} onClick={() => void saveTool()}><Save size={13} />{busy ? "保存中…" : "保存"}</Button></div>
              <div className="bridge-tabs"><button className={editorTab === "definition" ? "active" : ""} onClick={() => setEditorTab("definition")}>工具定义</button><button disabled={formInvalid} className={editorTab === "test" ? "active" : ""} onClick={() => setEditorTab("test")}>测试</button><button disabled={!draft.toolId} className={editorTab === "history" ? "active" : ""} onClick={() => setEditorTab("history")}>执行历史</button></div>
              </header>
              <ErrorNotice message={editorError || (applicationConflict ? `JSON 中的应用 ID 为 ${JSON.stringify(draftDefinition!.application)}，当前应用为 ${draft.application}` : "")} />
              {applicationConflict && <Button className="self-start" size="sm" variant="outline" disabled={busy} onClick={() => {
                setDraft({ ...draft, value: pretty({ ...draftDefinition, application: draft.application }) }); setEditorError("");
              }}>使用当前应用 ID</Button>}
              {editorTab === "history" && draft.toolId ? <BridgeExecutionHistory application={draft.application} toolId={draft.toolId} disabled={dirty || test.busy || busy} onReuse={record => {
                setTests(current => ({ ...current, [testKey]: { ...emptyTest(), args: pretty(record.args ?? {}), environmentId: record.environmentId, historySources: record.argSources,
                  historyNotice: record.legacy ? "旧历史未记录完整凭据来源，请重新选择字典或填写凭据。" : record.definitionChanged ? "工具定义已变化，将使用当前 Schema 校验和执行。" : "已载入历史参数和字典引用；未记录的手动值请重新填写。" } }));
                const names = persistedTool?.execution?.transport === "browser" ? Object.keys(credentialProperties(persistedTool.execution)) : [];
                setCredentialBindings(Object.fromEntries(Object.entries(restoredCredentials(record.credentialValues, record.credentialSources)).filter(([name]) => names.includes(name))));
                setTestParametersInvalid(false); setEditorTab("test");
              }} /> : editorTab === "definition" ? <><div className="bridge-toolbar"><div className="actions"><Button size="sm" variant={editorMode === "form" ? "secondary" : "ghost"} disabled={busy} onClick={() => {
                try {
                  const definition = normalizeToolIdentity(JSON.parse(draft.value), draft.application, draft.toolId);
                  if (!Array.isArray(definition.fields) || !definition.parameters || typeof definition.parameters !== "object" || Array.isArray(definition.parameters)) throw new Error("请先补全 parameters 和 fields 字段");
                  setDraft({ ...draft, value: pretty({ ...definition, toolId: definition.toolId ?? "" }) }); setEditorMode("form"); setEditorError("");
                } catch (error) { setEditorError((error as Error).message); }
              }}>表单</Button><Button size="sm" variant={editorMode === "json" ? "secondary" : "ghost"} disabled={busy || formInvalid} onClick={() => setEditorMode("json")}>JSON</Button></div></div>
                {editorMode === "form" ? <BridgeToolForm key={`${draft.application}/${draft.toolId ?? "new"}`} value={draft.value} existing={!!draft.toolId} disabled={busy} onChange={value => setDraft({ ...draft, value })} onInvalidChange={setFormInvalid} /> : <Textarea className="bridge-definition font-mono" aria-label="工具 JSON 定义" spellCheck={false} disabled={busy} value={draft.value} onChange={event => setDraft({ ...draft, value: event.target.value })} />}
              </> : <div className="bridge-test">
                <section className="bridge-test-input" aria-label="测试配置">
                <div className="bridge-test-heading"><h3>请求配置</h3><span>使用已保存的工具定义</span></div>
                {(dirty || !canTest) && <p className="field-hint">{dirty ? "请先保存工具定义，再执行测试。" : !persistedTool ? "请先保存新工具。" : !persistedTool.enabled ? "工具已停用，请先启用。" : "当前仅支持无需确认的只读工具测试。"}</p>}
                {persistedTool?.execution && <><p className="field-hint">{persistedTool.execution.transport === "browser" ? "浏览器模式：使用绑定资料的已登录页签，可指定本次调用凭据。" : "本机 HTTP 模式：不复用浏览器 Cookie，不需要浏览器资料。凭据从普通或加密字典的字符串键解析，敏感凭据建议加密保存。"}</p><label htmlFor="bridge-test-environment" className="field">运行环境</label><select id="bridge-test-environment" value={test.environmentId ?? ""} disabled={test.busy} onChange={event => setTests(current => ({ ...current, [testKey]: { ...test, environmentId: event.target.value, output: "", error: "" } }))}><option value="">自动选择（仅一个启用环境时）</option>{selected.environments.filter(environment => environment.enabled).map(environment => <option key={environment.id} value={environment.id}>{environment.origin}</option>)}</select></>}
                {test.historyNotice && <p className="field-hint" role="status">{test.historyNotice}</p>}
                {Object.entries(test.historySources ?? {}).map(([path, source]) => source.source === "omitted" && <p className="field-hint" key={path}>参数 {path || "（根参数）"}：历史未记录原值，请按当前 Schema 补填（可选字段可留空）。</p>)}
                {!!missing.length && <p className="field-hint" role="alert">请填写或选择调用凭据：{missing.join("、")}</p>}
                {!!arrayPlaceholders.length && <p className="field-hint" role="alert">请编辑并补全历史中未记录的数组项。</p>}
                {persistedTool?.execution?.transport === "browser" && <BridgeCredentialInputs execution={persistedTool.execution} value={credentialBindings} disabled={test.busy} onChange={setCredentialBindings} />}
                {persistedTool && <BridgeParameterInputs key={`${testKey}/${JSON.stringify(persistedTool.parameters)}`} schema={persistedTool.parameters} value={test.args} disabled={test.busy} onInvalidChange={setTestParametersInvalid} onFieldChange={name => setTests(current => ({ ...current, [testKey]: { ...current[testKey], historySources: Object.fromEntries(Object.entries(current[testKey]?.historySources ?? {}).filter(([path]) => path !== `/${pointerPart(name)}` && !path.startsWith(`/${pointerPart(name)}/`) && path !== "")) } }))} onChange={args => setTests(current => ({ ...current, [testKey]: { ...current[testKey] ?? test, args } }))} />}
                </section>
                <div className="bridge-toolbar bridge-test-actions"><Button size="sm" disabled={dirty || !canTest || test.busy || busy || testParametersInvalid || !!missing.length || !!arrayPlaceholders.length} onClick={() => void testTool()}><Check size={13} />{test.busy ? "执行中…" : requiresApproval ? "确认并执行" : "执行测试"}</Button>{(test.output || test.error) && <Button size="sm" variant="outline" onClick={() => setAgentOpen(true)}><MessageSquare size={13} />交给 Agent 分析</Button>}</div>
                <section className="bridge-test-response" aria-label="测试结果" aria-busy={test.busy}>
                  <div className="bridge-test-heading"><h3>响应结果</h3><span role="status">{test.busy ? "正在执行…" : test.error ? "执行失败" : test.output ? "执行完成" : "等待执行"}</span></div>
                  <ErrorNotice message={test.error} /><pre className={`bridge-test-result${test.output ? "" : " is-empty"}`}>{test.output || (test.busy ? "正在等待工具响应…" : "执行测试后，响应内容将在这里展示。")}</pre>
                </section>
              </div>}
            </div> : <>
              <div className="bridge-toolbar"><Input aria-label="搜索工具" placeholder="搜索工具名称或描述…" value={toolQuery} onChange={event => setToolQuery(event.target.value)} /><Button size="sm" onClick={() => openTool()}><Plus size={14} />新建工具</Button></div>
              {!tools.data && !tools.error ? <Loading /> : !selectedTools.length ? <div className="bridge-empty"><h3>还没有工具</h3><p>手动新建工具，或让 Agent 根据接口说明生成定义。</p><Button variant="outline" onClick={() => setAgentOpen(true)}>让 Agent 帮助创建</Button></div> : <div className="bridge-tools">
                {selectedTools.filter(tool => `${tool.toolId} ${tool.description}`.toLowerCase().includes(toolQuery.toLowerCase())).map(tool => <div className="bridge-tool-row" key={tool.toolId}>
                  <input type="checkbox" aria-label={`启用 ${tool.toolId}`} checked={tool.enabled} disabled={busy} onChange={() => void run(async () => { await send(`/web-bridge/applications/${selected.id}/tools/${tool.toolId}`, { enabled: !tool.enabled }, "PATCH"); tools.reload(); })} />
                  <button className="bridge-tool-select" aria-label={`编辑工具 ${tool.toolId}`} onClick={() => openTool(tool)}><strong>{tool.toolId}</strong><span>{tool.description || "暂无说明"}</span><small>{tool.method} {tool.path} · {tool.risk}</small></button>
                  <Button variant="ghost" size="icon" aria-label={`删除工具 ${tool.toolId}`} onClick={() => askDeletion("删除工具", `确定删除工具“${tool.toolId}”吗？`, async () => { await api(`/web-bridge/applications/${selected.id}/tools/${tool.toolId}`, { method: "DELETE" }); tools.reload(); })}><Trash2 size={14} /></Button>
                </div>)}
              </div>}
            </> : tab === "environments" ? <div className="bridge-environments">
              <h3>{environmentId ? "编辑环境" : "添加环境"}</h3>
              <label className="field" htmlFor="bridge-origin">网站 Origin</label><Input id="bridge-origin" placeholder="https://example.test" value={origin} disabled={busy} onChange={event => setOrigin(event.target.value)} />
              <label className="field" htmlFor="bridge-profile">浏览器资料</label><select id="bridge-profile" aria-label="选择浏览器资料" value={profileId} disabled={busy} onChange={event => setProfileId(event.target.value)}><option value="">选择浏览器资料</option>{profiles.data?.items.map(profile => <option key={profile.id} value={profile.id} disabled={!profile.connected}>{profile.name} · {profile.id.slice(-8)}{profile.connected ? " · 已连接" : " · 已断开"}</option>)}</select>
              <ErrorNotice message={profiles.error} />
              {!profiles.data?.items.some(profile => profile.connected) && <p className="field-hint">暂无已连接的浏览器资料，请先启动 Chrome 扩展。</p>}
              <div className="actions"><Button size="sm" disabled={busy || !origin.trim() || !profileId || !profiles.data?.items.some(profile => profile.id === profileId && profile.connected)} onClick={() => void run(async () => {
                await send(`/web-bridge/applications/${selected.id}/environments${environmentId ? `/${environmentId}` : ""}`, { origin: origin.trim().replace(/\/$/, ""), profileId, enabled: true }, environmentId ? "PATCH" : "POST");
                setOrigin(""); setProfileId(""); setEnvironmentId(undefined); apps.reload();
              }, "环境已保存")}>{environmentId ? "保存环境" : "添加环境"}</Button>{environmentId && <Button variant="ghost" size="sm" onClick={() => { setEnvironmentId(undefined); setOrigin(""); setProfileId(""); }}>取消编辑</Button>}</div>
              {selected.environments.map(environment => <div className="bridge-environment" key={environment.id}><div><strong>{environment.origin}</strong><p>{profiles.data?.items.find(profile => profile.id === environment.profileId)?.name ?? environment.profileId ?? "未知资料"} · {environment.bound ? "已绑定" : "已配置"}</p></div><div className="actions"><Button variant="outline" size="sm" onClick={() => { setEnvironmentId(environment.id); setOrigin(environment.origin); setProfileId(environment.profileId ?? ""); }}>编辑</Button><Button variant="ghost" size="icon" aria-label={`删除环境 ${environment.origin}`} onClick={() => askDeletion("删除环境", `确定删除环境 ${environment.origin} 吗？`, async () => { await api(`/web-bridge/applications/${selected.id}/environments/${environment.id}`, { method: "DELETE" }); apps.reload(); })}><Trash2 size={14} /></Button></div></div>)}
            </div> : <div className="bridge-settings"><h3>应用设置</h3><p>应用 ID：<code>{selected.id}</code></p><ApplicationSettings key={`${selected.id}:${selected.name}:${selected.enabled}`} application={selected} busy={busy} onSave={(name, enabled) => void run(async () => { await send(`/web-bridge/applications/${selected.id}`, { name, enabled }, "PATCH"); apps.reload(); }, "应用设置已保存")} />
              <div className="bridge-danger"><h3>删除应用</h3><p>同时删除 {selected.environments.length} 个环境和 {selectedTools.length} 个工具定义。</p><Button variant="destructive" size="sm" disabled={busy} onClick={deleteApplication}>删除应用</Button></div>
            </div>}
          </div>
        </>}
      </main>
      {selected && agentOpen && <div className="bridge-agent-container">
        <div className="bridge-resize-handle" role="separator" aria-label="调整 Agent 面板宽度" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={600} aria-valuenow={agentWidth} tabIndex={0} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault(); const width = Math.max(280, Math.min(600, agentWidth + (event.key === "ArrowLeft" ? 20 : -20)));
          setAgentWidth(width); saveBridgePreference("agentWidth", String(width));
        }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const right = event.currentTarget.parentElement!.getBoundingClientRect().right;
          const width = Math.max(280, Math.min(600, right - event.clientX));
          setAgentWidth(width); saveBridgePreference("agentWidth", String(width));
        }} onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); }} />
        <BridgeAgentPanel key={selected.id} application={selected} toolId={draft?.toolId} testContext={draft?.toolId && (test.output || test.error) ? pretty({ toolId: draft.toolId, args: test.args, output: test.output.slice(0, 10000), error: test.error }).slice(0, 16000) : undefined} refresh={agentRefresh} onReview={reviewTurn} onClose={() => setAgentOpen(false)} />
      </div>}
    </div>
    <Dialog open={connectionsOpen} onOpenChange={setConnectionsOpen}><DialogContent className="bridge-connections-dialog"><DialogHeader><DialogTitle>浏览器连接与插件配置</DialogTitle><DialogDescription>安装插件，并为当前浏览器资料设置名称。</DialogDescription></DialogHeader>
      <label className="field" htmlFor="web-bridge-extension-directory">浏览器插件目录</label><div className="bridge-toolbar"><Input id="web-bridge-extension-directory" className="font-mono" readOnly value={extension.data?.directory ?? ""} placeholder={extension.error ? "目录加载失败" : "正在加载目录…"} /><Button variant="outline" size="icon" aria-label="复制插件目录" disabled={!extension.data?.directory} onClick={() => void run(async () => { await navigator.clipboard.writeText(extension.data!.directory); }, "浏览器插件目录已复制")}><Copy size={14} /></Button></div>
      <p className="field-hint">在 Chrome 中打开 chrome://extensions，开启“开发者模式”，点击“加载已解压的扩展程序”，选择此目录。</p><ErrorNotice message={extension.error} />
      <section aria-label="浏览器资料列表"><div className="bridge-toolbar"><strong>已注册的浏览器资料：{profiles.data?.items.length ?? 0}</strong><Button variant="outline" size="sm" onClick={() => { profiles.reload(); extension.reload(); }}><RefreshCw size={13} />刷新浏览器资料</Button></div><ErrorNotice message={profiles.error} />
        <p className="field-hint">点击 Chrome 工具栏中的 Orchard 插件，为当前浏览器资料设置名称；保存后刷新此列表。</p>
        {profiles.data?.items.map(profile => <article className="bridge-profile" key={profile.id}><strong>{profile.name}</strong><span>{profile.connected ? "已连接" : "已断开"}</span><dl><dt>资料 ID</dt><dd>{profile.id}</dd><dt>插件 ID</dt><dd>{profile.extensionId}</dd><dt>最近注册</dt><dd><time dateTime={new Date(profile.lastSeen).toISOString()}>{new Date(profile.lastSeen).toLocaleString("zh-CN")}</time></dd></dl></article>)}
        {!profiles.data?.items.length && <p className="field-hint">安装或重新加载插件后，点击插件图标连接本机服务。</p>}
      </section>
    </DialogContent></Dialog>
    <Dialog open={createOpen} onOpenChange={open => { if (!busy) setCreateOpen(open); }}><DialogContent><DialogHeader><DialogTitle>新建网页应用</DialogTitle><DialogDescription>应用用于组织网站环境和可调用的工具。</DialogDescription></DialogHeader><label htmlFor="bridge-app-id">应用 ID</label><Input id="bridge-app-id" placeholder="如 crm" value={applicationId} disabled={busy} onChange={event => setApplicationId(event.target.value)} /><label htmlFor="bridge-app-name">应用名称</label><Input id="bridge-app-name" placeholder="如客户系统" value={applicationName} disabled={busy} onChange={event => setApplicationName(event.target.value)} /><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setCreateOpen(false)}>取消</Button><Button disabled={busy || !applicationId.trim() || !applicationName.trim()} onClick={() => void run(async () => {
      if (apps.data?.items.some(application => application.id === applicationId.trim())) throw new Error("应用 ID 已存在");
      await send("/web-bridge/applications", { id: applicationId.trim(), name: applicationName.trim() }); setSelectedId(applicationId.trim()); setDraft(undefined); setReview(undefined); setTab("tools"); setCreateOpen(false); setApplicationId(""); setApplicationName(""); apps.reload();
    }, "应用已创建")}>{busy ? "创建中…" : "创建应用"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={saveAsToolId !== undefined} onOpenChange={open => { if (!open && !busy) setSaveAsToolId(undefined); }}><DialogContent><DialogHeader><DialogTitle>另存为新工具</DialogTitle><DialogDescription>将当前编辑内容保存到当前应用，并打开新工具。原工具保留。</DialogDescription></DialogHeader>
      <form className="grid gap-3" onSubmit={event => { event.preventDefault(); if (saveAsToolId?.trim()) void saveTool(saveAsToolId); }}>
        <div className="grid gap-2"><label className="field" htmlFor="bridge-save-as-id">新工具 ID</label><Input id="bridge-save-as-id" className="font-mono" value={saveAsToolId ?? ""} disabled={busy} onChange={event => setSaveAsToolId(event.target.value)} /></div>
        <ErrorNotice message={editorError || error} /><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setSaveAsToolId(undefined)}>取消</Button><Button type="submit" disabled={busy || !saveAsToolId?.trim()}>{busy ? "保存中…" : "创建新工具"}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
    <Dialog open={!!deletion} onOpenChange={open => { if (!open && !busy) setDeletion(undefined); }}><DialogContent><DialogHeader><DialogTitle>{deletion?.title}</DialogTitle><DialogDescription>{deletion?.description}</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeletion(undefined)}>取消</Button><Button variant="destructive" disabled={busy} onClick={async () => { if (deletion && await run(deletion.action, deletion.execution ? undefined : "删除成功")) setDeletion(undefined); }}>{busy ? "处理中…" : deletion?.title}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!pendingNavigation} onOpenChange={open => { if (!open && !busy) setPendingNavigation(undefined); }}><DialogContent><DialogHeader><DialogTitle>有未保存的工具修改</DialogTitle><DialogDescription>保存当前工具后继续，或放弃本次修改。</DialogDescription></DialogHeader><ErrorNotice message={error || editorError} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setPendingNavigation(undefined)}>取消</Button><Button variant="outline" disabled={busy} onClick={() => { const action = pendingNavigation?.action; setDraft(undefined); setFormInvalid(false); setPendingNavigation(undefined); action?.(); }}>放弃修改</Button><Button disabled={busy} onClick={async () => { const action = pendingNavigation?.action; if (await saveTool()) { setPendingNavigation(undefined); action?.(); } }}>保存并继续</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}

function ApplicationSettings({ application, busy, onSave }: { application: Application; busy: boolean; onSave: (name: string, enabled: boolean) => void }) {
  const [name, setName] = useState(application.name), [enabled, setEnabled] = useState(application.enabled);
  return <><label className="field" htmlFor="bridge-edit-name">应用名称</label><Input id="bridge-edit-name" value={name} disabled={busy} onChange={event => setName(event.target.value)} /><label className="bridge-checkbox"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />启用应用</label><Button size="sm" disabled={busy || !name.trim() || name === application.name && enabled === application.enabled} onClick={() => onSave(name.trim(), enabled)}>保存应用设置</Button></>;
}
