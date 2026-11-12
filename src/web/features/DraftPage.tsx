import { DictionaryDeclarationEditor, DictionaryInputEditor } from "./DictionaryEditors";
import { useEffect, useState } from "react";
import { Check, GitBranch, Maximize2, RefreshCw, Save } from "lucide-react";
import type { AgentModelConfigView, Layout, SourceFiles, Version, Workflow } from "../../domain/types.js";
import { api, requestId, send, useResource } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Breadcrumbs, ErrorNotice, Loading, NodePicker, PageHeading, Payload, Status } from "../components/common";
import { ProjectContextPicker } from "./ProjectContextPicker";
import { BridgeNodeCredentials } from "./BridgeNodeCredentials";
import { ScriptNodePicker } from "./ScriptNodePicker";
import FlowCanvas from "./FlowCanvas";
import { RunButton } from "./WorkflowPages";
import { SourcePreviewDialog } from "./SourceTabs";
import { renderableWorkflow } from "./graph";
import { DeleteWorkflowButton } from "./DeleteWorkflowButton";
import { WorkflowOutputEditor } from "./WorkflowOutputEditor";
import { AgentModelConfigPicker } from "./AgentModelConfigPicker";
import { AgentChat } from "../agent-chat/AgentChat";
import { MaintenanceOwnerPanel } from "../agent-chat/MaintenanceOwnerPanel";
import { workflowChatConfig, type WorkflowChatDraft } from "../agent-chat/adapters/workflow";

export function DraftPage({ id }: { id: string }) {
  const resource = useResource<WorkflowChatDraft>(`/drafts/${id}`);
  const modelConfigs = useResource<{ items: AgentModelConfigView[] }>("/agent-model-configs");
  const [files, setFiles] = useState<SourceFiles>({}), [dirty, setDirty] = useState(false), [selected, setSelected] = useState(""), [filePath, setFilePath] = useState("workflow.json");
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [mobileTab, setMobileTab] = useState("chat");
  const [detailTab, setDetailTab] = useState("config"), [previewKey, setPreviewKey] = useState(0);
  const [sourceOpen, setSourceOpen] = useState(false);
  const draft = resource.data, activeTurn = draft?.turns.find(t => ["queued", "running", "cancel_requested"].includes(t.status));
  useEffect(() => { if (draft) { setFiles(draft.files); setDirty(false); setPreviewKey(key => key + 1); } }, [draft?.revision, draft?.status, draft?.id]);
  let graph: Workflow | undefined, layout: Layout = {};
  try { const candidate: unknown = JSON.parse(files["workflow.json"] ?? "null"); if (renderableWorkflow(candidate)) graph = candidate; layout = JSON.parse(files["layout.json"] ?? "{}"); } catch { /* The editor can temporarily contain invalid JSON. */ }
  const node = selected && selected !== "__end" ? graph?.nodes?.find(n => n.id === selected) : undefined;
  const locked = !!activeTurn || draft?.status !== "draft";
  const editGraph = (change: (workflow: Workflow) => void) => {
    if (!graph) return; const next = structuredClone(graph); change(next);
    setFiles(current => ({ ...current, "workflow.json": JSON.stringify(next, null, 2) })); setDirty(true);
  };
  const selectNode = (nodeId: string) => {
    if (nodeId !== selected) {
      const script = graph?.nodes.find(node => node.id === nodeId)?.config.script;
      setFilePath(script && Object.hasOwn(files, script) ? script : "workflow.json");
    }
    setSelected(nodeId);
    setDetailTab(nodeId === "__end" ? "output" : "node");
    setMobileTab("details");
  };
  const selectDetailTab = (tab: string) => {
    setDetailTab(tab);
    if (tab === "config") setSelected("");
    if (tab === "output") setSelected("__end");
  };
  const act = async (name: string, action: () => Promise<void>) => { setBusy(name); setError(""); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(""); resource.reload(); } };
  const save = () => act("save", async () => { await api(`/drafts/${id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: draft!.revision, files }) }); resource.reload(); });
  const publish = () => act("publish", async () => {
    const version = await send<Version>(`/drafts/${id}/publish`, { expectedRevision: draft!.revision, requestId: requestId() });
    window.location.assign(`/workflows/${version.workflowId}`);
  });
  if (!draft) return <><PageHeading parents={[{ label: "工作流定义", href: "/" }]} title="工作流草稿" /><ErrorNotice message={resource.error} /><Loading /></>;
  return <div className="draft-page"><div className="workspace-heading"><div className="workspace-heading-name"><Breadcrumbs items={[{ label: "工作流定义", href: "/" }, { label: graph?.name ?? "工作流草稿" }, { label: "草稿" }]} /><Status value={draft.status} /></div><div className="actions"><span className="revision">修订 {draft.revision}{dirty ? " · 未保存" : ""}</span><Button variant="outline" disabled={locked || !dirty || !!busy} onClick={() => void save()}><Save size={14} />保存修改</Button><RunButton draftId={id} revision={draft.revision} disabled={locked || dirty || !draft.validation.valid || !!busy} onRunningChange={running => setBusy(running ? "test" : "")} /><Button disabled={locked || dirty || !draft.validation.valid || !!busy} onClick={() => void publish()}><Check size={15} />{draft.workflowId ? "发布新版本" : "发布工作流"}</Button><DeleteWorkflowButton id={id} name={graph?.name ?? "未命名工作流"} kind="draft" compact disabled={locked || !!busy} /></div></div>
    <ErrorNotice message={error || resource.error || modelConfigs.error} />
    {dirty && <div className="notice">先保存修改，再运行测试或发布。</div>}
    {!draft.validation.valid && <div className="notice warning"><span>流程尚未通过校验，可以继续对话修复。</span>{draft.validation.diagnostics.map((d, i) => <pre key={i}>{d}</pre>)}</div>}
    {draft.validation.valid && !!draft.validation.diagnostics.length && <div className="notice"><div>{draft.validation.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic}</p>)}</div></div>}
    {draft.workflowId && !draft.publishedVersionId && <div className="notice">正在编辑已有工作流，发布后将新增版本，历史版本保留。</div>}
    {draft.publishedVersionId && <div className="notice success">此草稿已发布。<a href={`/workflows/${graph?.id}`}>查看工作流 →</a></div>}
    <div className="mobile-workspace-tabs" role="group" aria-label="工作区视图"><Button aria-pressed={mobileTab === "chat"} variant={mobileTab === "chat" ? "secondary" : "ghost"} onClick={() => setMobileTab("chat")}>对话</Button><Button aria-pressed={mobileTab === "flow"} variant={mobileTab === "flow" ? "secondary" : "ghost"} onClick={() => setMobileTab("flow")}>流程</Button><Button aria-pressed={mobileTab === "details"} variant={mobileTab === "details" ? "secondary" : "ghost"} onClick={() => setMobileTab("details")}>节点</Button></div>
    <div className="studio-grid" data-mobile-tab={mobileTab}>
      <MaintenanceOwnerPanel key={id} kind="workflow_draft" ownerId={id} disabled={dirty || !!busy} onApplied={resource.reload}>
        <AgentChat config={workflowChatConfig} resourceKey={id} context={{ draft, dirty, busy: !!busy, setBusy: value => setBusy(value ? "chat" : ""), reload: resource.reload, onOpenFile: path => { setFilePath(path); setSourceOpen(true); } }} />
      </MaintenanceOwnerPanel>
      <section className="canvas-panel"><div className="panel-bar"><span><GitBranch size={15} />流程预览</span><span className="panel-bar-actions"><span>{graph?.nodes?.length ?? 0} 个节点</span><Button variant="ghost" size="icon" aria-label="重新渲染流程预览" title="重新渲染流程预览" disabled={!!busy || !!dirty} onClick={() => { resource.reload(); setPreviewKey(key => key + 1); }}><RefreshCw size={15} /></Button></span></div>{graph?.nodes && Array.isArray(graph.edges) ? <FlowCanvas key={previewKey} workflow={graph} layout={layout} onSelect={selectNode} /> : <div className="empty">流程定义暂时无法展示，请修复 JSON。</div>}</section>
      <aside className="node-panel"><div className="panel-bar node-config-header"><NodePicker nodes={graph?.nodes ?? []} value={selected || "__global"} onChange={value => value === "__global" ? setSelected("") : selectNode(value)} includeGlobal includeOutput /><span>{selected === "__end" ? "全局输出" : node?.type ?? "全局配置"}</span><SourcePreviewDialog files={files} path={filePath} onPath={setFilePath} onChange={locked ? undefined : (value, path) => { setFiles(current => ({ ...current, [path]: value })); setDirty(true); }} open={sourceOpen} onOpenChange={setSourceOpen} trigger={<Button variant="ghost" size="icon" disabled={!Object.keys(files).length} aria-label="全屏预览源码" title="全屏预览源码"><Maximize2 size={15} /></Button>} /></div><Tabs value={detailTab} onValueChange={selectDetailTab}><TabsList><TabsTrigger value="config">全局配置</TabsTrigger><TabsTrigger value="node">节点配置</TabsTrigger><TabsTrigger value="output">最终输出</TabsTrigger></TabsList><TabsContent value="config"><div className="detail-stack">
        <div className="field"><label htmlFor="workflow-name">工作流名称</label><Input id="workflow-name" value={graph?.name ?? ""} disabled={locked} onChange={e => editGraph(g => { g.name = e.target.value; })} /></div>
        <div className="field"><label>Agent 默认配置</label><AgentModelConfigPicker configs={modelConfigs.data?.items ?? []} value={graph?.defaults?.agent?.agentConfigId} disabled={locked} onChange={agentConfigId => editGraph(g => { g.defaults = { ...g.defaults, agent: { agentConfigId } }; })} /></div>
        <label>全局输入</label><Payload value={graph?.inputSchema} />
      </div></TabsContent><TabsContent value="node"><div className="detail-stack">{!node ? <p className="field-hint">请选择一个节点查看节点配置。</p> : <>
        <div className="field"><label htmlFor="node-name">节点名称</label><Input id="node-name" value={node.name} disabled={locked} onChange={e => editGraph(g => { g.nodes.find(item => item.id === node.id)!.name = e.target.value; })} /></div>
        <div className="field"><label>节点类型</label><span className="field-hint">{node.type}</span></div>
        {["script", "code.nodejs", "shell"].includes(node.type) && <ScriptNodePicker key={`${node.id}:${node.config.scriptId ?? ""}`} node={node} disabled={locked || !!busy} onApply={replacement => editGraph(workflow => { workflow.nodes[workflow.nodes.findIndex(item => item.id === node.id)] = replacement; })} />}
        {node.type === "agent" && <><label>Agent 配置</label><AgentModelConfigPicker configs={modelConfigs.data?.items ?? []} value={node.config.agentConfigId} inherit defaultId={graph?.defaults?.agent?.agentConfigId} disabled={locked} onChange={agentConfigId => editGraph(g => { const target = g.nodes.find(n => n.id === node.id)!; if (agentConfigId) target.config.agentConfigId = agentConfigId; else delete target.config.agentConfigId; })} /><ProjectContextPicker value={node.config.project?.projectId} config={modelConfigs.data?.items?.find(c => c.id === (node.config.agentConfigId ?? graph?.defaults?.agent?.agentConfigId))} disabled={locked} onChange={projectId => editGraph(g => { const target = g.nodes.find(n => n.id === node.id)!; if (projectId) target.config.project = { projectId }; else delete target.config.project; })} /><div className="field"><label htmlFor="agent-prompt">节点提示词</label><Textarea id="agent-prompt" value={node.config.prompt ?? ""} disabled={locked} onChange={e => editGraph(g => { g.nodes.find(n => n.id === node.id)!.config.prompt = e.target.value; })} rows={5} /></div></>}
        {node.type === "web-bridge" && <BridgeNodeCredentials key={`${node.id}:${node.config.application}:${node.config.tool}`} node={node} disabled={locked || !!busy} onChange={value => editGraph(g => { const config = g.nodes.find(n => n.id === node.id)!.config; if (value) config.credentialBindings = value; else delete config.credentialBindings; })} />}
        <DictionaryInputEditor key={`${node.id}:${JSON.stringify(node.input)}`} value={node.input} disabled={locked || !!busy} onApply={input => editGraph(g => { g.nodes.find(n => n.id === node.id)!.input = input; })} />{["code.nodejs", "shell"].includes(node.type) && <DictionaryDeclarationEditor value={node.config.dictionaryBindings} disabled={locked || !!busy} onApply={value => editGraph(g => { const config = g.nodes.find(n => n.id === node.id)!.config; if (value) config.dictionaryBindings = value; else delete config.dictionaryBindings; })} />}<label>节点输入</label><Payload value={node.input} /><label>节点输出</label><Payload value={node.outputSchema} />
        {node.config.script && <Button variant="outline" onClick={() => { setFilePath(node.config.script!); setSourceOpen(true); }}>打开源码：{node.config.script}</Button>}
        <details><summary>节点其他配置</summary><Payload value={node.config} /></details>
      </>}</div></TabsContent><TabsContent value="output">{graph ? <WorkflowOutputEditor workflow={graph} disabled={locked || !!busy} onApply={(result, outputSchema) => editGraph(workflow => { workflow.result = result; workflow.outputSchema = outputSchema; })} /> : <p className="field-hint">请先修复流程定义 JSON。</p>}</TabsContent></Tabs></aside>
    </div>
  </div>;
}
