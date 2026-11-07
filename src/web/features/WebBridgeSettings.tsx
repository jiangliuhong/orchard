import { useMemo, useState } from "react";
import { Check, Globe, Plus, RefreshCw, Settings2, Trash2, Wrench } from "lucide-react";
import { api, send, useResource } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { ErrorNotice, Loading } from "../components/common";

interface Environment { id: string; origin: string; profileId?: string; extensionId?: string; enabled: boolean; bound: boolean; tabAvailable: boolean }
interface Application { id: string; name: string; enabled: boolean; environments: Environment[] }
interface Tool { toolId: string; application: string; description: string; risk: string; catalogVersion: string; enabled: boolean; parameters: unknown; path: string; method: string; fields: string[]; approval: string; timeoutMs: number }
interface BrowserProfile { id: string; name: string; extensionId: string; connected: boolean; lastSeen: number }

export function WebBridgeSettings() {
  const apps = useResource<{ items: Application[] }>("/web-bridge/applications");
  const tools = useResource<{ items: Tool[] }>("/web-bridge/tools");
  const profiles = useResource<{ items: BrowserProfile[] }>("/web-bridge/profiles");
  const auth = useResource<{ configured: boolean; last4: string }>("/web-bridge/auth");
  const extension = useResource<{ directory: string }>("/web-bridge/extension");
  const [selectedId, setSelectedId] = useState(""), [tab, setTab] = useState("definitions"), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [applicationId, setApplicationId] = useState(""), [applicationName, setApplicationName] = useState("");
  const [origin, setOrigin] = useState(""), [profileId, setProfileId] = useState(""), [toolEditor, setToolEditor] = useState<{ application: string; toolId?: string; value: string }>(), [testToolState, setTestToolState] = useState<Tool>(), [testArgs, setTestArgs] = useState("{}"), [testOutput, setTestOutput] = useState(""), [deleteTarget, setDeleteTarget] = useState<Application>();
  const selected = apps.data?.items.find(application => application.id === selectedId) ?? apps.data?.items[0];
  const selectedTools = useMemo(() => tools.data?.items.filter(tool => tool.application === selected?.id) ?? [], [tools.data, selected?.id]);

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setError(""); setNotice("");
    try { await action(); if (success) setNotice(success); }
    catch (e) { setError((e as Error).message); }
  };
  const copyExtensionDirectory = () => {
    const directory = extension.data?.directory;
    if (!directory) return;
    void run(async () => {
      try { await navigator.clipboard.writeText(directory); }
      catch { throw new Error("复制失败，请允许剪贴板访问后重试。"); }
    }, "浏览器插件目录已复制");
  };
  const createApplication = () => run(async () => {
    await send("/web-bridge/applications", { id: applicationId.trim(), name: applicationName.trim() });
    setApplicationId(""); setApplicationName(""); await apps.reload();
  }, "应用已创建");
  const removeApplication = (application: Application) => setDeleteTarget(application);
  const confirmRemoveApplication = () => {
    if (!deleteTarget) return;
    void run(async () => {
      await api(`/web-bridge/applications/${deleteTarget.id}`, { method: "DELETE" });
      if (selectedId === deleteTarget.id) setSelectedId("");
      await apps.reload(); await tools.reload();
    }, "应用及其环境、工具已删除");
    setDeleteTarget(undefined);
  };
  const addEnvironment = () => selected && run(async () => {
    await send(`/web-bridge/applications/${selected.id}/environments`, { origin: origin.trim(), profileId, enabled: true });
    setOrigin(""); setProfileId(""); await apps.reload();
  }, "环境已添加");
  const removeEnvironment = (environment: Environment) => selected && run(async () => {
    await api(`/web-bridge/applications/${selected.id}/environments/${environment.id}`, { method: "DELETE" }); await apps.reload();
  }, "环境已删除");
  const saveTool = () => toolEditor && run(async () => {
    const definition = JSON.parse(toolEditor.value);
    const path = toolEditor.toolId ? `/web-bridge/applications/${toolEditor.application}/tools/${toolEditor.toolId}/definition` : `/web-bridge/applications/${toolEditor.application}/tools`;
    await send(path, definition, toolEditor.toolId ? "PATCH" : "POST"); setToolEditor(undefined); await tools.reload();
  }, "工具定义已保存");
  const removeTool = (tool: Tool) => {
    if (!window.confirm(`确定删除工具“${tool.toolId}”吗？`)) return;
    void run(async () => { await api(`/web-bridge/applications/${tool.application}/tools/${tool.toolId}`, { method: "DELETE" }); await tools.reload(); }, "工具已删除");
  };
  const toggleTool = (tool: Tool) => void run(async () => { await api(`/web-bridge/applications/${tool.application}/tools/${tool.toolId}`, { method: "PATCH", body: JSON.stringify({ enabled: !tool.enabled }) }); await tools.reload(); });
  const testTool = () => testToolState && void run(async () => {
    const result = await api<unknown>(`/web-bridge/applications/${testToolState.application}/tools/${testToolState.toolId}/test`, { method: "POST", body: testArgs });
    setTestOutput(JSON.stringify(result, null, 2));
  });

  return <section className="web-bridge-settings" aria-label="Web Bridge 设置">
    <div className="preference-row"><div><h2><Globe size={17} /> Web Bridge</h2><p>先定义应用和工具，再进入应用管理环境与测试。</p></div><span className="readiness readiness-ready"><span className="status-dot" />本机服务已就绪</span></div>
    <div className="management-section">
      <label className="field" htmlFor="web-bridge-extension-directory">浏览器插件目录</label>
      <Input id="web-bridge-extension-directory" className="font-mono" readOnly value={extension.data?.directory ?? ""} onDoubleClick={copyExtensionDirectory} title="双击复制目录" placeholder={extension.error ? "目录加载失败" : "正在加载目录…"} />
      <p className="field-hint">双击输入框可复制目录。在 Chrome 中打开 chrome://extensions，开启“开发者模式”，点击“加载已解压的扩展程序”，选择此目录。</p>
      <ErrorNotice message={extension.error} />
    </div>
    <section className="management-section" aria-label="浏览器资料列表">
      <div className="section-heading"><span>已注册的浏览器资料：{profiles.data?.items.length ?? 0}</span><Button variant="outline" size="sm" onClick={() => { profiles.reload(); apps.reload(); }}><RefreshCw size={14} />刷新浏览器资料</Button></div>
      <p className="field-hint">点击 Chrome 工具栏中的 Orchard 插件，为当前浏览器资料设置名称；保存后刷新此列表。</p>
      <ErrorNotice message={profiles.error} />
      {!profiles.data && !profiles.error ? <Loading /> : !profiles.data?.items.length ? <p className="field-hint">安装或重新加载插件后，点击插件图标连接本机服务，再刷新浏览器资料。</p> : <ul className="web-bridge-profile-list">
        {profiles.data.items.map(profile => <li key={profile.id}>
          <div className="section-heading"><strong>{profile.name}</strong><span className={`readiness ${profile.connected ? "readiness-ready" : "readiness-unavailable"}`}><span className="status-dot" />{profile.connected ? "已连接" : "已断开"}</span></div>
          <dl>
            <div><dt>浏览器</dt><dd>Chrome</dd></div>
            <div><dt>最近注册</dt><dd><time dateTime={new Date(profile.lastSeen).toISOString()}>{new Date(profile.lastSeen).toLocaleString("zh-CN")}</time></dd></div>
            <div><dt>资料 ID</dt><dd><code>{profile.id}</code></dd></div>
            <div><dt>插件 ID</dt><dd><code>{profile.extensionId}</code></dd></div>
          </dl>
        </li>)}
      </ul>}
    </section>
    <ErrorNotice message={error} />
    {notice && <p role="status" className="success-note">{notice}</p>}
    {!apps.data || !tools.data || !profiles.data ? <Loading /> : <Tabs value={tab} onValueChange={setTab} className="web-bridge-tabs">
      <TabsList aria-label="Web Bridge 设置层级"><TabsTrigger value="definitions"><Settings2 size={14} />应用定义</TabsTrigger><TabsTrigger value="management"><Wrench size={14} />应用管理</TabsTrigger></TabsList>
      <TabsContent value="definitions">
        <div className="web-bridge-grid">
          <div className="web-bridge-create-application"><div><strong>添加应用定义</strong><span>应用是环境和工具的容器，配置保存在 `.orchard`。</span></div><div className="inline-field"><Input placeholder="应用 ID，如 crm" value={applicationId} onChange={event => setApplicationId(event.target.value)} /><Input placeholder="应用名称，如客户系统" value={applicationName} onChange={event => setApplicationName(event.target.value)} /><Button size="sm" disabled={!applicationId.trim() || !applicationName.trim()} onClick={() => void createApplication()}><Plus size={14} />添加</Button></div></div>
          {apps.data.items.map(application => <div className="web-bridge-application definition-card" key={application.id}><div className="web-bridge-heading"><div><strong>{application.name}</strong><span>{application.id} · {tools.data?.items.filter(tool => tool.application === application.id).length ?? 0} 个工具</span></div><Button variant="ghost" size="icon" aria-label={`删除 ${application.name}`} onClick={() => removeApplication(application)}><Trash2 size={14} /></Button></div><p className="field-hint">进入“应用管理”配置环境、查看工具和执行测试。</p><Button variant="outline" size="sm" onClick={() => { setSelectedId(application.id); setTab("management"); }}>管理应用</Button></div>)}
          {!apps.data.items.length && <p className="field-hint">还没有应用定义，请先添加一个应用。</p>}
        </div>
      </TabsContent>
      <TabsContent value="management">
        {!apps.data.items.length ? <p className="field-hint">请先在“应用定义”中创建应用。</p> : <div className="web-bridge-management">
          <div className="web-bridge-app-picker">{apps.data.items.map(application => <button key={application.id} className={selected?.id === application.id ? "active" : ""} onClick={() => setSelectedId(application.id)}>{application.name}<small>{application.id}</small></button>)}</div>
          {selected && <div className="web-bridge-management-body"><div className="management-title"><div><h3>{selected.name}</h3><span>{selected.id}</span></div><Button variant="ghost" size="sm" onClick={() => removeApplication(selected)}><Trash2 size={14} />删除应用</Button></div>
            <section className="management-section"><div className="section-heading"><h4>环境</h4><span>绑定到已连接的浏览器资料</span></div><div className="inline-field"><Input placeholder="https://example.test" value={origin} onChange={event => setOrigin(event.target.value)} /><select className="web-bridge-profile-select" aria-label="选择浏览器资料" value={profileId} onChange={event => setProfileId(event.target.value)}><option value="">选择浏览器资料</option>{profiles.data?.items.map(profile => <option key={profile.id} value={profile.id} disabled={!profile.connected}>{profile.name} · {profile.id.slice(-8)}{profile.connected ? " · 已连接" : " · 已断开"}</option>)}</select><Button size="sm" disabled={!origin.trim() || !profileId || !profiles.data?.items.some(profile => profile.id === profileId && profile.connected)} onClick={() => void addEnvironment()}><Plus size={14} />添加</Button></div>{!profiles.data?.items.some(profile => profile.connected) && <p className="field-hint">暂无已连接的浏览器资料，请先启动 Chrome 扩展。</p>}{selected.environments.map(environment => <div className="web-bridge-environment" key={environment.id}><span>{environment.origin}</span><span className="field-hint">{profiles.data?.items.find(profile => profile.id === environment.profileId)?.name ?? environment.profileId ?? "未知资料"} · {environment.bound ? "已绑定" : "未绑定"}</span><Button variant="ghost" size="icon" onClick={() => void removeEnvironment(environment)}><Trash2 size={14} /></Button></div>)}</section>
            <section className="management-section"><div className="section-heading"><h4>工具列表</h4><Button size="sm" onClick={() => setToolEditor({ application: selected.id, value: "{}" })}><Plus size={14} />新增工具</Button></div>{selectedTools.map(tool => <div className="web-bridge-tool" key={tool.toolId}><input type="checkbox" checked={tool.enabled} onChange={() => toggleTool(tool)} /><span><strong>{tool.toolId}</strong><small>{tool.description} · {tool.method} {tool.path} · {tool.risk}</small></span><div className="tool-actions"><Button variant="outline" size="sm" onClick={() => setToolEditor({ application: tool.application, toolId: tool.toolId, value: JSON.stringify(tool, null, 2) })}>编辑</Button><Button variant="outline" size="sm" onClick={() => { setTestToolState(tool); setTestOutput(""); }}><Check size={13} />测试</Button><Button variant="ghost" size="sm" onClick={() => removeTool(tool)}><Trash2 size={13} />删除</Button></div></div>)}</section>
            {testToolState && <section className="management-section"><div className="section-heading"><h4>测试：{testToolState.toolId}</h4><Button variant="ghost" size="sm" onClick={() => setTestToolState(undefined)}>关闭</Button></div><Textarea rows={4} className="font-mono" value={testArgs} onChange={event => setTestArgs(event.target.value)} /><Button size="sm" onClick={() => testTool()}><Check size={13} />执行测试</Button><pre className="web-bridge-test-output">{testOutput || "输入 JSON 参数后执行测试。"}</pre></section>}
          </div>}
        </div>}
      </TabsContent>
    </Tabs>}
    <Dialog open={!!toolEditor} onOpenChange={open => { if (!open) setToolEditor(undefined); }}><DialogContent className="web-bridge-tool-dialog"><DialogHeader><DialogTitle>{toolEditor?.toolId ? "编辑工具" : "新增工具"}</DialogTitle><DialogDescription>工具定义保存到当前应用配置中。</DialogDescription></DialogHeader><Textarea rows={10} className="font-mono" value={toolEditor?.value ?? ""} onChange={event => setToolEditor(current => current && ({ ...current, value: event.target.value }))} /><DialogFooter><Button variant="outline" onClick={() => setToolEditor(undefined)}>取消</Button><Button onClick={() => void saveTool()}>保存工具</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(undefined); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>删除应用</DialogTitle><DialogDescription>{deleteTarget && <>确定删除“{deleteTarget.name}”吗？这会同时删除 {deleteTarget.environments.length} 个环境和 {tools.data?.items.filter(tool => tool.application === deleteTarget.id).length ?? 0} 个工具定义。</>}</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setDeleteTarget(undefined)}>取消</Button><Button variant="destructive" onClick={confirmRemoveApplication}>删除应用</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
