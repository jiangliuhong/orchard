import { useEffect, useRef, useState } from "react";
import { Check, GitBranch, MessageSquare, Save, Send, Square, Sparkles } from "lucide-react";
import type { AgentChoice, ConversationView, Draft, Layout, Message, ProviderView, SourceFiles, Turn, Version, Workflow } from "../../domain/types.js";
import { api, pretty, requestId, send, useResource, useStream } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { BackButton, ErrorNotice, Loading, NodePicker, Payload, Status } from "../components/common";
import { ProviderPicker } from "./ProviderPicker";
import FlowCanvas from "./FlowCanvas";
import { RunButton, SourceTabs } from "./WorkflowPages";
import { renderableWorkflow } from "./graph";
import { isModelEnabled } from "../../domain/models.js";
import { DeleteWorkflowButton } from "./DeleteWorkflowButton";
import { WorkflowOutputEditor } from "./WorkflowOutputEditor";

interface DraftDetail extends Draft { files: SourceFiles; messages: Message[]; turns: Turn[]; conversations: ConversationView[]; currentConversation: string | null }
export function DraftPage({ id }: { id: string }) {
  const resource = useResource<DraftDetail>(`/drafts/${id}`), providerResource = useResource<{ items: ProviderView[] }>("/providers");
  const [files, setFiles] = useState<SourceFiles>({}), [dirty, setDirty] = useState(false), [selected, setSelected] = useState(""), [filePath, setFilePath] = useState("workflow.json");
  const [prompt, setPrompt] = useState(""), [choice, setChoice] = useState<AgentChoice>(() => { try { return JSON.parse(localStorage.getItem("orchard-workbench-agent") ?? "{}"); } catch { return {}; } });
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [delta, setDelta] = useState(""), [mobileTab, setMobileTab] = useState("chat");
  const [detailTab, setDetailTab] = useState("config");
  const bottom = useRef<HTMLDivElement>(null), draft = resource.data, activeTurn = draft?.turns.find(t => ["queued", "running", "cancel_requested"].includes(t.status));
  const callbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { if (draft) { setFiles(draft.files); setDirty(false); } }, [draft?.revision, draft?.status, draft?.id]);
  useEffect(() => () => clearTimeout(callbackTimer.current), []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [draft?.messages.length, delta]);
  useStream("turns", activeTurn?.id, event => {
    if (event.type === "provider.text") setDelta(text => (text + (event.payload as { text: string }).text).slice(-4000));
    if (/turn\.(succeeded|failed|cancelled|interrupted)/.test(event.type)) { setDelta(""); resource.reload(); }
  });
  // A short poll also handles a turn finishing before its subscription is established.
  useEffect(() => { if (!activeTurn) return; const timer = setInterval(resource.reload, 1500); return () => clearInterval(timer); }, [activeTurn?.id]);
  let graph: Workflow | undefined, layout: Layout = {};
  try { const candidate: unknown = JSON.parse(files["workflow.json"] ?? "null"); if (renderableWorkflow(candidate)) graph = candidate; layout = JSON.parse(files["layout.json"] ?? "{}"); } catch { /* The editor can temporarily contain invalid JSON. */ }
  const node = graph?.nodes?.find(n => n.id === selected) ?? graph?.nodes?.[0], providers = providerResource.data?.items ?? [];
  const selectedProvider = providers.find(provider => provider.id === choice.providerId);
  const modelAvailable = selectedProvider?.enabled && selectedProvider.models.some(model => model.id === choice.modelId && isModelEnabled(model));
  const currentConversation = draft?.conversations?.find(conversation => conversation.id === draft.currentConversation);
  const locked = !!activeTurn || draft?.status !== "draft" || currentConversation?.status === "needs_rebuild", canSend = !locked && !busy && !!modelAvailable && !!prompt.trim() && !dirty;
  const choose = (value: AgentChoice) => { setChoice(value); localStorage.setItem("orchard-workbench-agent", JSON.stringify(value)); };
  const editGraph = (change: (workflow: Workflow) => void) => {
    if (!graph) return; const next = structuredClone(graph); change(next);
    setFiles(current => ({ ...current, "workflow.json": JSON.stringify(next, null, 2) })); setDirty(true);
  };
  const selectNode = (nodeId: string) => {
    setSelected(nodeId);
    if (nodeId === "__end") { setDetailTab("output"); setMobileTab("details"); }
    else if (detailTab === "output") setDetailTab("config");
  };
  const selectDetailTab = (tab: string) => {
    setDetailTab(tab);
    if (tab === "output") setSelected("__end");
    else if (selected === "__end") setSelected(graph?.entryNodeId ?? "");
  };
  const act = async (name: string, action: () => Promise<void>) => { setBusy(name); setError(""); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(""); resource.reload(); } };
  const save = () => act("save", async () => { await api(`/drafts/${id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: draft!.revision, files }) }); resource.reload(); });
  const generate = () => act("generate", async () => {
    await send(`/drafts/${id}/turns`, { ...choice, conversationId: draft!.currentConversation ?? undefined, mode: currentConversation?.mode ?? "multi", prompt, expectedRevision: draft!.revision, requestId: requestId() });
    setPrompt(""); setDelta(""); resource.reload();
  });
  const publish = () => act("publish", async () => {
    const version = await send<Version>(`/drafts/${id}/publish`, { expectedRevision: draft!.revision, requestId: requestId() });
    window.location.assign(`/workflows/${version.workflowId}`);
  });
  if (!draft) return <><BackButton /><ErrorNotice message={resource.error} /><Loading /></>;
  return <div className="draft-page"><div className="workspace-heading"><div className="workspace-heading-name"><BackButton /><span className="heading-divider" /><div><span className="eyebrow">WORKFLOW STUDIO</span><h1>{graph?.name ?? "工作流草稿"}</h1></div><Status value={draft.status} /></div><div className="actions"><span className="revision">修订 {draft.revision}{dirty ? " · 未保存" : ""}</span><span className="field-hint">{currentConversation ? `${currentConversation.mode === "multi" ? "多轮" : "单次"} · ${currentConversation.transport}` : "尚未创建对话"}</span><Button variant="outline" disabled={locked || !!dirty || !!busy} onClick={() => void act("conversation", async () => { await send(`/drafts/${id}/conversations`, { ...choice, mode: "multi", expectedRevision: draft.revision, requestId: requestId() }); })}>新对话</Button><Button variant="outline" disabled={locked || !dirty || !!busy} onClick={() => void save()}><Save size={14} />保存修改</Button><RunButton draftId={id} revision={draft.revision} disabled={locked || dirty || !draft.validation.valid || !!busy} onRunningChange={running => setBusy(running ? "test" : "")} /><Button disabled={locked || dirty || !draft.validation.valid || !!busy} onClick={() => void publish()}><Check size={15} />{draft.workflowId ? "发布新版本" : "发布工作流"}</Button><DeleteWorkflowButton id={id} name={graph?.name ?? "未命名工作流"} kind="draft" compact disabled={locked || !!busy} /></div></div>
    <ErrorNotice message={error || resource.error || providerResource.error} />
    {dirty && <div className="notice">先保存修改，再运行测试或发布。</div>}{currentConversation?.status === "needs_rebuild" && <div className="notice warning">当前后端上下文已中断，需要重建会话后才能继续。<Button size="sm" onClick={() => void act("rebuild", async () => { await send(`/drafts/${id}/conversations`, { ...choice, mode: currentConversation.mode, expectedRevision: draft.revision, rebuildFromId: currentConversation.id, requestId: requestId() }); })}>重建上下文</Button></div>}
    {!draft.validation.valid && <div className="notice warning"><span>流程尚未通过校验，可以继续对话修复。</span>{draft.validation.diagnostics.map((d, i) => <pre key={i}>{d}</pre>)}</div>}
    {draft.workflowId && !draft.publishedVersionId && <div className="notice">正在编辑已有工作流，发布后将新增版本，历史版本保留。</div>}
    {draft.publishedVersionId && <div className="notice success">此草稿已发布。<a href={`/workflows/${graph?.id}`}>查看工作流 →</a></div>}
    <div className="mobile-workspace-tabs"><Button variant={mobileTab === "chat" ? "secondary" : "ghost"} onClick={() => setMobileTab("chat")}>对话</Button><Button variant={mobileTab === "flow" ? "secondary" : "ghost"} onClick={() => setMobileTab("flow")}>流程</Button><Button variant={mobileTab === "details" ? "secondary" : "ghost"} onClick={() => setMobileTab("details")}>节点</Button></div>
    <div className="studio-grid" data-mobile-tab={mobileTab}>
      <section className="chat-panel"><div className="panel-bar"><span><MessageSquare size={15} />与 Agent 创作</span><span>本地连接</span></div><div className="messages">
        {!draft.messages.length && <div className="chat-welcome"><div className="welcome-icon"><Sparkles size={22} /></div><h2>描述你想自动完成的工作</h2><p>例如：读取一份数据，用 Agent 分析是否需要处理，再按判断执行脚本。</p><span className="field-hint">生成过程不会执行业务脚本。</span></div>}
        {draft.messages.map(message => <article className={`message message-${message.role}`} key={message.id}><span className="message-role">{message.role === "user" ? "你" : message.role === "error" ? "执行诊断" : "Agent"}</span><p>{typeof message.content === "object" && message.content ? String((message.content as { text?: string; message?: string }).text ?? (message.content as { message?: string }).message ?? "") : String(message.content)}</p>{message.content && typeof message.content === "object" && "files" in message.content ? <div className="changed-files">{(message.content as { files: string[] }).files.map(name => <button key={name} onClick={() => { setFilePath(name); setDetailTab("source"); setMobileTab("details"); }}>{name}</button>)}</div> : null}</article>)}
        {activeTurn && <article className="message message-assistant"><span className="message-role">Agent · 生成中</span><p>{delta || "正在分析流程与上下文…"}</p></article>}<div ref={bottom} />
      </div><div className="chat-compose"><ProviderPicker providers={providers} value={choice} onChange={choose} disabled={locked || !!busy} /><label className="sr-only" htmlFor="workflow-prompt">描述工作流需求</label><Textarea id="workflow-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述需求，或继续修改流程…" disabled={locked || !!busy} rows={3} /><div className="compose-footer"><span>{dirty ? "先保存修改，再继续对话" : "工作流仅在手动运行时执行"}</span>{activeTurn ? <Button variant="outline" onClick={() => void act("cancel", async () => { await send(`/drafts/${id}/turns/${activeTurn.id}/cancel`); resource.reload(); })}><Square size={13} />{activeTurn.status === "cancel_requested" ? "正在停止…" : "取消生成"}</Button> : <Button disabled={!canSend} onClick={() => void generate()}><Send size={14} />发送</Button>}</div></div></section>
      <section className="canvas-panel"><div className="panel-bar"><span><GitBranch size={15} />流程预览</span><span>{graph?.nodes?.length ?? 0} 个节点</span></div>{graph?.nodes && Array.isArray(graph.edges) ? <FlowCanvas workflow={graph} layout={layout} onSelect={selectNode} /> : <div className="empty">流程定义暂时无法展示，请修复 JSON。</div>}</section>
      <aside className="node-panel"><div className="panel-bar">{graph && node ? <NodePicker nodes={graph.nodes} value={selected === "__end" ? "__end" : node.id} onChange={selectNode} includeOutput /> : <strong>流程详情</strong>}<span>{selected === "__end" ? "OUTPUT" : node?.type}</span></div><Tabs value={detailTab} onValueChange={selectDetailTab}><TabsList><TabsTrigger value="config">配置</TabsTrigger><TabsTrigger value="source">源码</TabsTrigger><TabsTrigger value="output">最终输出</TabsTrigger></TabsList><TabsContent value="config"><div className="detail-stack">
        <div className="field"><label htmlFor="workflow-name">工作流名称</label><Input id="workflow-name" value={graph?.name ?? ""} disabled={locked} onChange={e => editGraph(g => { g.name = e.target.value; })} /></div>
        <details><summary>工作流默认 Agent</summary><ProviderPicker providers={providers} value={graph?.defaults?.agent ?? {}} disabled={locked} onChange={value => editGraph(g => { g.defaults = { ...g.defaults, agent: value }; })} /></details>
        {node?.type === "agent" && <><label>此节点使用的 Agent</label><ProviderPicker providers={providers} value={{ providerId: node.config.providerId ?? graph?.defaults?.agent?.providerId, modelId: node.config.modelId ?? graph?.defaults?.agent?.modelId }} disabled={locked} onChange={value => editGraph(g => { const target = g.nodes.find(n => n.id === node.id)!; target.config.providerId = value.providerId; target.config.modelId = value.modelId; })} /><div className="field"><label htmlFor="agent-prompt">节点提示词</label><Textarea id="agent-prompt" value={node.config.prompt ?? ""} disabled={locked} onChange={e => editGraph(g => { g.nodes.find(n => n.id === node.id)!.config.prompt = e.target.value; })} rows={5} /></div></>}
        <label>输入绑定</label><Payload value={node?.input} /><label>输出约束</label><Payload value={node?.outputSchema} />{node?.config.script && <Button variant="outline" onClick={() => { setFilePath(node.config.script!); setDetailTab("source"); }}>源码文件：{node.config.script}</Button>}<details><summary>节点配置</summary><Payload value={node?.config} /></details>
      </div></TabsContent><TabsContent value="source"><SourceTabs files={files} path={filePath} onPath={setFilePath} onChange={locked ? undefined : (value, path) => { setFiles(current => ({ ...current, [path]: value })); setDirty(true); }} /></TabsContent><TabsContent value="output">{graph ? <WorkflowOutputEditor workflow={graph} disabled={locked || !!busy} onApply={(result, outputSchema) => editGraph(workflow => { workflow.result = result; workflow.outputSchema = outputSchema; })} /> : <p className="field-hint">请先修复流程定义 JSON。</p>}</TabsContent></Tabs></aside>
    </div>
  </div>;
}
