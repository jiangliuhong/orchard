import { useEffect, useRef, useState } from "react";
import { Check, GitBranch, Maximize2, Menu, RefreshCw, Save, Send, Square, Sparkles } from "lucide-react";
import type { AgentChoice, AgentModelConfigView, ConversationView, Draft, Layout, Message, ProviderView, SourceFiles, Turn, Version, Workflow } from "../../domain/types.js";
import { api, pretty, requestId, send, useResource, useStream } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { BackButton, ErrorNotice, Loading, NodePicker, Payload, Status } from "../components/common";
import { ProviderPicker } from "./ProviderPicker";
import { ScriptNodePicker } from "./ScriptNodePicker";
import FlowCanvas from "./FlowCanvas";
import { RunButton } from "./WorkflowPages";
import { SourcePreviewDialog } from "./SourceTabs";
import { renderableWorkflow } from "./graph";
import { isModelEnabled } from "../../domain/models.js";
import { DeleteWorkflowButton } from "./DeleteWorkflowButton";
import { WorkflowOutputEditor } from "./WorkflowOutputEditor";
import { ConversationPanel } from "./ConversationPanel";
import { ConversationDrawer } from "./ConversationDrawer";
import { AgentModelConfigPicker } from "./AgentModelConfigPicker";

interface DraftDetail extends Draft { files: SourceFiles; messages: Message[]; turns: Turn[]; conversations: ConversationView[]; currentConversation: string | null }
export function DraftPage({ id }: { id: string }) {
  const resource = useResource<DraftDetail>(`/drafts/${id}`), providerResource = useResource<{ items: ProviderView[] }>("/providers");
  const modelConfigs = useResource<{ items: AgentModelConfigView[] }>("/agent-model-configs");
  const [files, setFiles] = useState<SourceFiles>({}), [dirty, setDirty] = useState(false), [selected, setSelected] = useState(""), [filePath, setFilePath] = useState("workflow.json");
  const [prompt, setPrompt] = useState(""), [choice, setChoice] = useState<AgentChoice>(() => { try { return JSON.parse(localStorage.getItem("orchard-workbench-agent") ?? "{}"); } catch { return {}; } });
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [delta, setDelta] = useState(""), [mobileTab, setMobileTab] = useState("chat");
  const [detailTab, setDetailTab] = useState("config"), [previewKey, setPreviewKey] = useState(0), [viewedConversationId, setViewedConversationId] = useState<string | null>(null);
  const [newConversation, setNewConversation] = useState(true), [historyOpen, setHistoryOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null), draft = resource.data, activeTurn = draft?.turns.find(t => ["queued", "running", "cancel_requested"].includes(t.status));
  const callbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { if (draft) { setFiles(draft.files); setDirty(false); setPreviewKey(key => key + 1); } }, [draft?.revision, draft?.status, draft?.id]);
  useEffect(() => () => clearTimeout(callbackTimer.current), []);
  // 切换草稿后回到当前对话视图，不残留旧草稿的选中状态。
  useEffect(() => { setViewedConversationId(null); setNewConversation(true); setHistoryOpen(false); setPrompt(""); }, [id]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [draft?.messages.length, delta]);
  useStream("turns", activeTurn?.id, event => {
    if (event.type === "provider.text") setDelta(text => (text + (event.payload as { text: string }).text).slice(-4000));
    if (/turn\.(succeeded|failed|cancelled|interrupted)/.test(event.type)) { setDelta(""); resource.reload(); setPreviewKey(key => key + 1); }
  });
  // A short poll also handles a turn finishing before its subscription is established.
  useEffect(() => { if (!activeTurn) return; const timer = setInterval(resource.reload, 1500); return () => clearInterval(timer); }, [activeTurn?.id]);
  let graph: Workflow | undefined, layout: Layout = {};
  try { const candidate: unknown = JSON.parse(files["workflow.json"] ?? "null"); if (renderableWorkflow(candidate)) graph = candidate; layout = JSON.parse(files["layout.json"] ?? "{}"); } catch { /* The editor can temporarily contain invalid JSON. */ }
  const node = selected && selected !== "__end" ? graph?.nodes?.find(n => n.id === selected) : undefined, providers = providerResource.data?.items ?? [];
  const selectedProvider = providers.find(provider => provider.id === choice.providerId);
  const modelAvailable = selectedProvider?.enabled && selectedProvider.models.some(model => model.id === choice.modelId && isModelEnabled(model));
  const currentConversation = draft?.conversations?.find(conversation => conversation.id === draft.currentConversation);
  const brokenConversation = draft?.conversations?.filter(conversation => conversation.status === "needs_rebuild").at(-1);
  const hasConversations = !!draft?.conversations?.length;
  // 消息按选中会话过滤：默认当前对话；无 current 时显示未关联会话的旧版历史。
  const activeView = viewedConversationId ?? draft?.currentConversation ?? null;
  const visibleMessages = draft && !newConversation ? draft.messages.filter(message => (message.conversationId ?? null) === activeView) : [];
  const viewedConversation = draft?.conversations?.find(conversation => conversation.id === activeView);
  const firstUserContent = visibleMessages.find(message => message.role === "user")?.content;
  const firstPrompt = typeof firstUserContent === "string" ? firstUserContent : firstUserContent && typeof firstUserContent === "object" && "text" in firstUserContent && typeof firstUserContent.text === "string" ? firstUserContent.text : "";
  const conversationName = newConversation ? "新对话" : viewedConversation?.title?.trim() || firstPrompt.trim() || "新对话";
  const locked = !!activeTurn || draft?.status !== "draft", canSend = !locked && !busy && !!modelAvailable && !!prompt.trim() && !dirty && (newConversation || ((!hasConversations || !!draft?.currentConversation) && activeView === draft?.currentConversation));
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [visibleMessages.length, delta]);
  const choose = (value: AgentChoice) => { setChoice(value); localStorage.setItem("orchard-workbench-agent", JSON.stringify(value)); };
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
  const act = async (name: string, action: () => Promise<void>) => { setBusy(name); setError(""); try { await action(); if (name === "conversation" || name === "rebuild") setNewConversation(false); } catch (e) { setError((e as Error).message); } finally { setBusy(""); resource.reload(); } };
  const save = () => act("save", async () => { await api(`/drafts/${id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: draft!.revision, files }) }); resource.reload(); });
  const generate = () => act("generate", async () => {
    let conversationId = draft!.currentConversation;
    if (newConversation) {
      const conversation = await send<ConversationView>(`/drafts/${id}/conversations`, { ...choice, mode: "multi", expectedRevision: draft!.revision, requestId: requestId() });
      conversationId = conversation.id; setViewedConversationId(conversation.id); setNewConversation(false);
    }
    await send(`/drafts/${id}/turns`, { ...choice, conversationId: conversationId ?? undefined, mode: newConversation ? "multi" : currentConversation?.mode ?? "multi", prompt, expectedRevision: draft!.revision, requestId: requestId() });
    setPrompt(""); setDelta(""); resource.reload();
  });
  const publish = () => act("publish", async () => {
    const version = await send<Version>(`/drafts/${id}/publish`, { expectedRevision: draft!.revision, requestId: requestId() });
    window.location.assign(`/workflows/${version.workflowId}`);
  });
  if (!draft) return <><BackButton /><ErrorNotice message={resource.error} /><Loading /></>;
  return <div className="draft-page"><div className="workspace-heading"><div className="workspace-heading-name"><BackButton /><span className="heading-divider" /><div><span className="eyebrow">WORKFLOW STUDIO</span><h1>{graph?.name ?? "工作流草稿"}</h1></div><Status value={draft.status} /></div><div className="actions"><span className="revision">修订 {draft.revision}{dirty ? " · 未保存" : ""}</span><span className="field-hint">{newConversation ? "新对话" : currentConversation ? `${currentConversation.mode === "multi" ? "多轮" : "单次"} · ${currentConversation.transport}` : "尚未创建对话"}</span><Button variant="outline" disabled={locked || !dirty || !!busy} onClick={() => void save()}><Save size={14} />保存修改</Button><RunButton draftId={id} revision={draft.revision} disabled={locked || dirty || !draft.validation.valid || !!busy} onRunningChange={running => setBusy(running ? "test" : "")} /><Button disabled={locked || dirty || !draft.validation.valid || !!busy} onClick={() => void publish()}><Check size={15} />{draft.workflowId ? "发布新版本" : "发布工作流"}</Button><DeleteWorkflowButton id={id} name={graph?.name ?? "未命名工作流"} kind="draft" compact disabled={locked || !!busy} /></div></div>
    <ErrorNotice message={error || resource.error || providerResource.error || modelConfigs.error} />
    {dirty && <div className="notice">先保存修改，再运行测试或发布。</div>}{brokenConversation && !draft.currentConversation && <div className="notice warning">对话「{brokenConversation.title ?? "未命名对话"}」的后端上下文已中断，仅可阅读；重建会开启新上下文并保留原对话作诊断历史。<Button size="sm" disabled={!!busy} onClick={() => void act("rebuild", async () => { setViewedConversationId(null); await send(`/drafts/${id}/conversations/${brokenConversation.id}/rebuild`, { ...choice, mode: brokenConversation.mode, expectedRevision: draft.revision, requestId: requestId() }); })}>重建上下文</Button></div>}
    {!draft.validation.valid && <div className="notice warning"><span>流程尚未通过校验，可以继续对话修复。</span>{draft.validation.diagnostics.map((d, i) => <pre key={i}>{d}</pre>)}</div>}
    {draft.validation.valid && !!draft.validation.diagnostics.length && <div className="notice"><div>{draft.validation.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic}</p>)}</div></div>}
    {draft.workflowId && !draft.publishedVersionId && <div className="notice">正在编辑已有工作流，发布后将新增版本，历史版本保留。</div>}
    {draft.publishedVersionId && <div className="notice success">此草稿已发布。<a href={`/workflows/${graph?.id}`}>查看工作流 →</a></div>}
    <div className="mobile-workspace-tabs"><Button variant={mobileTab === "chat" ? "secondary" : "ghost"} onClick={() => setMobileTab("chat")}>对话</Button><Button variant={mobileTab === "flow" ? "secondary" : "ghost"} onClick={() => setMobileTab("flow")}>流程</Button><Button variant={mobileTab === "details" ? "secondary" : "ghost"} onClick={() => setMobileTab("details")}>节点</Button></div>
    <div className="studio-grid" data-mobile-tab={mobileTab}>
      <section className="chat-panel"><div className="panel-bar conversation-heading"><Button variant="ghost" size="icon" aria-label="历史对话" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}><Menu size={16} /></Button><h2 className="conversation-heading-title" title={conversationName}>{conversationName}</h2><Button variant="ghost" size="sm" disabled={locked || !!busy} onClick={() => { setNewConversation(true); setViewedConversationId(null); setPrompt(""); setHistoryOpen(false); }}>新对话</Button></div>
      <ConversationDrawer open={historyOpen} onOpenChange={setHistoryOpen}><ConversationPanel draftId={id} revision={draft.revision} conversations={draft.conversations ?? []} currentId={draft.currentConversation} locked={!!activeTurn || draft.status !== "draft"} busy={busy} choice={choice} viewedId={viewedConversationId} onView={value => { setViewedConversationId(value); setNewConversation(false); setPrompt(""); setHistoryOpen(false); const conversation = draft.conversations.find(item => item.id === (value ?? draft.currentConversation)); if (conversation) choose({ providerId: conversation.providerId, modelId: conversation.modelId }); }} run={act} /></ConversationDrawer>
      <div className="messages">
        {!visibleMessages.length && <div className="chat-welcome"><div className="welcome-icon"><Sparkles size={22} /></div><h2>描述你想自动完成的工作</h2><p>例如：读取一份数据，用 Agent 分析是否需要处理，再按判断执行脚本。</p><span className="field-hint">生成过程不会执行业务脚本。</span></div>}
        {visibleMessages.map(message => <article className={`message message-${message.role}`} key={message.id}><span className="message-role">{message.role === "user" ? "你" : message.role === "error" ? "执行诊断" : "Agent"}</span><p>{typeof message.content === "object" && message.content ? String((message.content as { text?: string; message?: string }).text ?? (message.content as { message?: string }).message ?? "") : String(message.content)}</p>{message.content && typeof message.content === "object" && "files" in message.content ? <div className="changed-files">{(message.content as { files: string[] }).files.map(name => <button key={name} onClick={() => { setFilePath(name); setSourceOpen(true); }}>{name}</button>)}</div> : null}</article>)}
        {activeTurn && <article className="message message-assistant"><span className="message-role">Agent · 生成中</span><p>{delta || "正在分析流程与上下文…"}</p></article>}<div ref={bottom} />
      </div><div className="chat-compose"><ProviderPicker providers={providers} value={choice} enabledOnly onChange={choose} disabled={locked || !!busy} /><label className="sr-only" htmlFor="workflow-prompt">描述工作流需求</label><Textarea id="workflow-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述需求，或继续修改流程…" disabled={locked || !!busy} rows={3} /><div className="compose-footer"><span>{dirty ? "先保存修改，再继续对话" : "工作流仅在手动运行时执行"}</span>{activeTurn ? <Button variant="outline" onClick={() => void act("cancel", async () => { await send(`/drafts/${id}/turns/${activeTurn.id}/cancel`); resource.reload(); })}><Square size={13} />{activeTurn.status === "cancel_requested" ? "正在停止…" : "取消生成"}</Button> : <Button disabled={!canSend} onClick={() => void generate()}><Send size={14} />发送</Button>}</div></div></section>
      <section className="canvas-panel"><div className="panel-bar"><span><GitBranch size={15} />流程预览</span><span className="panel-bar-actions"><span>{graph?.nodes?.length ?? 0} 个节点</span><Button variant="ghost" size="icon" aria-label="重新渲染流程预览" title="重新渲染流程预览" disabled={!!busy || !!dirty} onClick={() => { resource.reload(); setPreviewKey(key => key + 1); }}><RefreshCw size={15} /></Button></span></div>{graph?.nodes && Array.isArray(graph.edges) ? <FlowCanvas key={previewKey} workflow={graph} layout={layout} onSelect={selectNode} /> : <div className="empty">流程定义暂时无法展示，请修复 JSON。</div>}</section>
      <aside className="node-panel"><div className="panel-bar node-config-header"><NodePicker nodes={graph?.nodes ?? []} value={selected || "__global"} onChange={value => value === "__global" ? setSelected("") : selectNode(value)} includeGlobal includeOutput /><span>{selected === "__end" ? "全局输出" : node?.type ?? "全局配置"}</span><SourcePreviewDialog files={files} path={filePath} onPath={setFilePath} onChange={locked ? undefined : (value, path) => { setFiles(current => ({ ...current, [path]: value })); setDirty(true); }} open={sourceOpen} onOpenChange={setSourceOpen} trigger={<Button variant="ghost" size="icon" disabled={!Object.keys(files).length} aria-label="全屏预览源码" title="全屏预览源码"><Maximize2 size={15} /></Button>} /></div><Tabs value={detailTab} onValueChange={selectDetailTab}><TabsList><TabsTrigger value="config">全局配置</TabsTrigger><TabsTrigger value="node">节点配置</TabsTrigger><TabsTrigger value="output">最终输出</TabsTrigger></TabsList><TabsContent value="config"><div className="detail-stack">
        <div className="field"><label htmlFor="workflow-name">工作流名称</label><Input id="workflow-name" value={graph?.name ?? ""} disabled={locked} onChange={e => editGraph(g => { g.name = e.target.value; })} /></div>
        <div className="field"><label>Agent 默认配置</label><AgentModelConfigPicker configs={modelConfigs.data?.items ?? []} value={graph?.defaults?.agent?.agentConfigId} disabled={locked} onChange={agentConfigId => editGraph(g => { g.defaults = { ...g.defaults, agent: { agentConfigId } }; })} /></div>
        <label>全局输入</label><Payload value={graph?.inputSchema} />
      </div></TabsContent><TabsContent value="node"><div className="detail-stack">{!node ? <p className="field-hint">请选择一个节点查看节点配置。</p> : <>
        <div className="field"><label htmlFor="node-name">节点名称</label><Input id="node-name" value={node.name} disabled={locked} onChange={e => editGraph(g => { g.nodes.find(item => item.id === node.id)!.name = e.target.value; })} /></div>
        <div className="field"><label>节点类型</label><span className="field-hint">{node.type}</span></div>
        {["script", "code.nodejs", "shell"].includes(node.type) && <ScriptNodePicker key={`${node.id}:${node.config.scriptId ?? ""}`} node={node} disabled={locked || !!busy} onApply={replacement => editGraph(workflow => { workflow.nodes[workflow.nodes.findIndex(item => item.id === node.id)] = replacement; })} />}
        {node.type === "agent" && <><label>Agent 配置</label><AgentModelConfigPicker configs={modelConfigs.data?.items ?? []} value={node.config.agentConfigId} inherit defaultId={graph?.defaults?.agent?.agentConfigId} disabled={locked} onChange={agentConfigId => editGraph(g => { const target = g.nodes.find(n => n.id === node.id)!; if (agentConfigId) target.config.agentConfigId = agentConfigId; else delete target.config.agentConfigId; })} /><div className="field"><label htmlFor="agent-prompt">节点提示词</label><Textarea id="agent-prompt" value={node.config.prompt ?? ""} disabled={locked} onChange={e => editGraph(g => { g.nodes.find(n => n.id === node.id)!.config.prompt = e.target.value; })} rows={5} /></div></>}
        <label>节点输入</label><Payload value={node.input} /><label>节点输出</label><Payload value={node.outputSchema} />
        {node.config.script && <Button variant="outline" onClick={() => { setFilePath(node.config.script!); setSourceOpen(true); }}>打开源码：{node.config.script}</Button>}
        <details><summary>节点其他配置</summary><Payload value={node.config} /></details>
      </>}</div></TabsContent><TabsContent value="output">{graph ? <WorkflowOutputEditor workflow={graph} disabled={locked || !!busy} onApply={(result, outputSchema) => editGraph(workflow => { workflow.result = result; workflow.outputSchema = outputSchema; })} /> : <p className="field-hint">请先修复流程定义 JSON。</p>}</TabsContent></Tabs></aside>
    </div>
  </div>;
}
