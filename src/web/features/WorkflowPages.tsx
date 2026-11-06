import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, FileCode2, GitBranch, Play, Plus, Sparkles } from "lucide-react";
import type { SourceFiles, Version } from "../../domain/types.js";
import { requestId, send, useResource } from "../lib/api";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { BackButton, EmptyState, ErrorNotice, Loading, PageHeading, Payload } from "../components/common";
import FlowCanvas from "./FlowCanvas";
import { DeleteWorkflowButton } from "./DeleteWorkflowButton";
import { SourceTabs } from "./SourceTabs";
import { WorkflowOutputEditor } from "./WorkflowOutputEditor";
export { SourceTabs } from "./SourceTabs";
interface WorkflowSummary { id: string; name: string; currentVersionId: string; createdAt: number; updatedAt: number }
export async function newDraft(workflowId?: string, versionId?: string, mode: "edit" | "copy" | "restore" = "edit") {
  const draft = await send<{ id: string }>(workflowId ? `/workflows/${workflowId}/draft` : "/drafts", { ...(workflowId ? { versionId, mode } : {}), requestId: requestId() });
  window.location.assign(`/drafts/${draft.id}`);
}
type RunButtonProps = { workflowId: string; versionId: string } | { draftId: string; revision: number; disabled?: boolean; onRunningChange?: (busy: boolean) => void };
export function RunButton(props: RunButtonProps) {
  const [open, setOpen] = useState(false), [input, setInput] = useState("{}"), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const testing = "draftId" in props;
  const key = useRef(requestId());
  const run = async () => {
    setBusy(true); setError(""); if (testing) props.onRunningChange?.(true);
    try {
      const result = await send<{ id: string }>(testing ? `/drafts/${props.draftId}/runs` : `/workflows/${props.workflowId}/runs`, { ...(testing ? { expectedRevision: props.revision } : { versionId: props.versionId }), input: JSON.parse(input), requestId: key.current });
      window.location.assign(`/runs/${result.id}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); if (testing) props.onRunningChange?.(false); }
  };
  return <><Button variant={testing ? "outline" : "default"} disabled={busy || (testing && props.disabled)} onClick={() => { key.current = requestId(); setError(""); setOpen(true); }}><Play size={15} />{testing ? "运行测试" : "运行"}</Button><Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent><DialogHeader><DialogTitle>{testing ? "测试工作流草稿" : "运行工作流"}</DialogTitle><DialogDescription>{testing ? `使用已保存的草稿修订 ${props.revision} 创建独立测试，不发布工作流。测试会实际执行脚本和 Agent 调用。` : "使用该版本创建独立运行。输入须符合工作流的 JSON Schema。"}</DialogDescription></DialogHeader><label htmlFor="run-input">运行输入 JSON</label><Textarea id="run-input" value={input} disabled={busy} onChange={e => { setInput(e.target.value); key.current = requestId(); }} rows={8} className="font-mono" /><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button disabled={busy || (testing && props.disabled)} onClick={() => void run()}><Play size={15} />{busy ? "正在创建…" : testing ? "开始测试" : "开始运行"}</Button></DialogFooter></DialogContent></Dialog></>;
}
export function WorkflowsPage() {
  const { data, error, reload } = useResource<{ items: WorkflowSummary[] }>("/workflows"), drafts = useResource<{ items: { id: string; name: string; status: string; updatedAt: number }[] }>("/drafts");
  const [creating, setCreating] = useState(false), [actionError, setActionError] = useState("");
  const create = async () => { setCreating(true); try { await newDraft(); } catch (e) { setActionError((e as Error).message); setCreating(false); } };
  return <><PageHeading eyebrow="YOUR WORKSPACE" title="工作流" description="创建和编排流程，查看每次运行的结果。"><Button onClick={() => void create()} disabled={creating}><Plus size={15} />新建工作流</Button></PageHeading><ErrorNotice message={error || actionError} />
    <div className="section-label"><span>已发布工作流</span><span>{data?.items.length ?? 0} 个</span></div>
    {!data ? !error && <Loading /> : data.items.length ? <div className="panel workflow-list">{data.items.map(workflow =>
      <div className="workflow-row" key={workflow.id}><a className="workflow-row-link" href={`/workflows/${workflow.id}`}>
        <div className="workflow-row-icon"><GitBranch size={19} /></div>
        <div className="workflow-identity"><h2>{workflow.name}</h2><p>{workflow.id}</p></div>
        <span className="workflow-published"><span className="status-dot" />已发布</span>
        <time dateTime={new Date(workflow.updatedAt).toISOString()}>{new Date(workflow.updatedAt).toLocaleDateString("zh-CN")}</time>
        <ArrowUpRight size={15} className="row-arrow" />
      </a><DeleteWorkflowButton id={workflow.id} name={workflow.name} compact onDeleted={() => { reload(); drafts.reload(); }} /></div>)}</div> : <div className="panel"><EmptyState title="还没有已发布的工作流" description="与 Agent 对话创建一个流程，确认后发布。" action={<Button variant="outline" onClick={() => void create()} disabled={creating}><Sparkles size={14} />与 Agent 创建</Button>} /></div>}
    {!!drafts.data?.items.filter(draft => draft.status === "draft").length && <>
      <div className="section-label"><span>继续创作</span><span>{drafts.data.items.filter(draft => draft.status === "draft").length} 个草稿</span></div>
      <div className="panel draft-list">{drafts.data.items.filter(draft => draft.status === "draft").map(draft =>
        <div className="draft-row" key={draft.id}><a className="workflow-row-link" href={`/drafts/${draft.id}`}>
          <FileCode2 size={17} /><strong>{draft.name}</strong><span>草稿</span>
          <time dateTime={new Date(draft.updatedAt).toISOString()}>{new Date(draft.updatedAt).toLocaleDateString("zh-CN")}</time>
          <ArrowUpRight size={15} className="row-arrow" />
        </a><DeleteWorkflowButton id={draft.id} name={draft.name} kind="draft" compact onDeleted={drafts.reload} /></div>)}</div>
    </>}
  </>;
}
function VersionBody({ version }: { version: Version & { files: SourceFiles } }) {
  const [selected, setSelected] = useState(version.definition.entryNodeId), [path, setPath] = useState("workflow.json"), [tab, setTab] = useState("config");
  const selectNode = (id: string) => { setSelected(id); if (id === "__end") setTab("output"); else if (tab === "output") setTab("config"); };
  const node = version.definition.nodes.find(n => n.id === selected);
  return <div className="version-workspace"><section className="canvas-panel"><div className="panel-bar"><span><GitBranch size={15} />{version.definition.nodes.length} 个节点</span><span>只读版本 · v{version.number}</span></div><FlowCanvas workflow={version.definition} layout={version.layout} onSelect={selectNode} /></section><aside className="node-panel"><div className="panel-bar"><strong>{tab === "output" ? "工作流最终输出" : node?.name ?? "流程详情"}</strong></div><Tabs value={tab} onValueChange={setTab}><TabsList><TabsTrigger value="config">配置</TabsTrigger><TabsTrigger value="source">源码</TabsTrigger><TabsTrigger value="output">最终输出</TabsTrigger></TabsList><TabsContent value="config"><div className="detail-stack"><label>节点类型</label><code>{node?.type}</code><label>配置</label><Payload value={node?.config} /><label>输入绑定</label><Payload value={node?.input} /><label>输入约束</label><Payload value={node?.inputSchema ?? true} /><label>输出约束</label><Payload value={node?.outputSchema} /><details><summary>工作流输入 / 输出约束</summary><Payload value={{ inputSchema: version.definition.inputSchema, outputSchema: version.definition.outputSchema }} /></details><details><summary>完整流程定义</summary><Payload value={version.definition} /></details></div></TabsContent><TabsContent value="source"><SourceTabs files={version.files} path={path} onPath={setPath} /></TabsContent><TabsContent value="output"><WorkflowOutputEditor workflow={version.definition} disabled /></TabsContent></Tabs></aside></div>;
}
export function WorkflowPage({ id }: { id: string }) {
  const { data, error } = useResource<WorkflowSummary & { versions: Version[] }>(`/workflows/${id}`);
  const [versionId, setVersionId] = useState(() => new URLSearchParams(window.location.search).get("versionId") ?? ""), [actionError, setActionError] = useState(""), [busy, setBusy] = useState(false);
  const openDraft = async (mode: "edit" | "copy" | "restore") => {
    setBusy(true); setActionError("");
    try { await newDraft(id, mode === "edit" ? undefined : versionId, mode); }
    catch (e) { setActionError((e as Error).message); setBusy(false); }
  };
  useEffect(() => { if (data && !versionId) setVersionId(data.currentVersionId); }, [data, versionId]);
  const version = useResource<Version & { files: SourceFiles }>(`/workflows/${id}/versions/${encodeURIComponent(versionId || "pending")}`);
  return <><BackButton /><PageHeading eyebrow="WORKFLOW" title={data?.name ?? "工作流详情"} description={data?.id}><Select value={versionId} onValueChange={setVersionId}><SelectTrigger aria-label="选择工作流版本"><SelectValue placeholder="历史版本" /></SelectTrigger><SelectContent>{data?.versions.map(v => <SelectItem value={v.id} key={v.id}>v{v.number}{v.id === data.currentVersionId ? " · 当前发布" : ""} · {new Date(v.createdAt).toLocaleString("zh-CN")}</SelectItem>)}</SelectContent></Select><Button variant="outline" disabled={busy || !data} onClick={() => void openDraft("edit")}><Sparkles size={15} />编辑 / 发布新版本</Button><Button variant="outline" disabled={busy || !versionId} onClick={() => void openDraft("copy")}>复制为新工作流</Button><Button variant="outline" disabled={busy || !versionId || versionId === data?.currentVersionId} onClick={() => void openDraft("restore")}>还原到草稿</Button>{versionId && <RunButton workflowId={id} versionId={versionId} />}{data && <DeleteWorkflowButton id={id} name={data.name} disabled={busy} />}</PageHeading><ErrorNotice message={error || actionError || (versionId ? version.error : "")} />{versionId && versionId !== data?.currentVersionId && <div className="notice">正在查看历史版本。还原会创建同一工作流的草稿，发布后生成新版本并保留全部历史。</div>}{version.data && version.data.id === versionId ? <VersionBody key={versionId} version={version.data} /> : <Loading />}</>;
}
