import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
const CodeEditor = lazy(() => import("./CodeEditor"));
interface WorkflowSummary { id: string; name: string; currentVersionId: string; createdAt: number; updatedAt: number }
export async function newDraft(workflowId?: string) {
  const draft = await send<{ id: string }>("/drafts", { ...(workflowId ? { workflowId } : {}), requestId: requestId() });
  window.location.assign(`/drafts/${draft.id}`);
}
export function RunButton({ workflowId, versionId }: { workflowId: string; versionId: string }) {
  const [open, setOpen] = useState(false), [input, setInput] = useState("{}"), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const key = useRef(requestId());
  const run = async () => {
    setBusy(true); setError("");
    try {
      const result = await send<{ id: string }>(`/workflows/${workflowId}/runs`, { versionId, input: JSON.parse(input), requestId: key.current });
      window.location.assign(`/runs/${result.id}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <><Button onClick={() => setOpen(true)}><Play size={15} />运行</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>运行工作流</DialogTitle><DialogDescription>使用该版本创建独立运行。输入须符合工作流的 JSON Schema。</DialogDescription></DialogHeader><label htmlFor="run-input">运行输入 JSON</label><Textarea id="run-input" value={input} onChange={e => { setInput(e.target.value); key.current = requestId(); }} rows={8} className="font-mono" /><ErrorNotice message={error} /><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button disabled={busy} onClick={() => void run()}><Play size={15} />{busy ? "正在创建…" : "开始运行"}</Button></DialogFooter></DialogContent></Dialog></>;
}
export function WorkflowsPage() {
  const { data, error } = useResource<{ items: WorkflowSummary[] }>("/workflows"), drafts = useResource<{ items: { id: string; name: string; status: string; updatedAt: number }[] }>("/drafts");
  const [creating, setCreating] = useState(false), [actionError, setActionError] = useState("");
  const create = async () => { setCreating(true); try { await newDraft(); } catch (e) { setActionError((e as Error).message); setCreating(false); } };
  return <><PageHeading eyebrow="YOUR WORKSPACE" title="工作流" description="创建和编排流程，查看每次运行的结果。"><Button onClick={() => void create()} disabled={creating}><Plus size={15} />新建工作流</Button></PageHeading><ErrorNotice message={error || actionError} />
    <div className="section-label"><span>已发布工作流</span><span>{data?.items.length ?? 0} 个</span></div>
    {!data ? !error && <Loading /> : data.items.length ? <div className="panel workflow-list">{data.items.map(workflow =>
      <a className="workflow-row" href={`/workflows/${workflow.id}`} key={workflow.id}>
        <div className="workflow-row-icon"><GitBranch size={19} /></div>
        <div className="workflow-identity"><h2>{workflow.name}</h2><p>{workflow.id}</p></div>
        <span className="workflow-published"><span className="status-dot" />已发布</span>
        <time dateTime={new Date(workflow.updatedAt).toISOString()}>{new Date(workflow.updatedAt).toLocaleDateString("zh-CN")}</time>
        <ArrowUpRight size={15} className="row-arrow" />
      </a>)}</div> : <div className="panel"><EmptyState title="还没有已发布的工作流" description="与 Agent 对话创建一个流程，确认后发布。" action={<Button variant="outline" onClick={() => void create()} disabled={creating}><Sparkles size={14} />与 Agent 创建</Button>} /></div>}
    {!!drafts.data?.items.filter(draft => draft.status === "draft").length && <>
      <div className="section-label"><span>继续创作</span><span>{drafts.data.items.filter(draft => draft.status === "draft").length} 个草稿</span></div>
      <div className="panel draft-list">{drafts.data.items.filter(draft => draft.status === "draft").map(draft =>
        <a className="draft-row" href={`/drafts/${draft.id}`} key={draft.id}>
          <FileCode2 size={17} /><strong>{draft.name}</strong><span>草稿</span>
          <time dateTime={new Date(draft.updatedAt).toISOString()}>{new Date(draft.updatedAt).toLocaleDateString("zh-CN")}</time>
          <ArrowUpRight size={15} className="row-arrow" />
        </a>)}</div>
    </>}
  </>;
}
function VersionBody({ version }: { version: Version & { files: SourceFiles } }) {
  const [selected, setSelected] = useState(version.definition.entryNodeId), [path, setPath] = useState("workflow.json");
  const node = version.definition.nodes.find(n => n.id === selected);
  return <div className="version-workspace"><section className="canvas-panel"><div className="panel-bar"><span><GitBranch size={15} />{version.definition.nodes.length} 个节点</span><span>只读版本 · v{version.number}</span></div><FlowCanvas workflow={version.definition} layout={version.layout} onSelect={setSelected} /></section><aside className="node-panel"><div className="panel-bar"><strong>{node?.name ?? "流程详情"}</strong></div><Tabs defaultValue="config"><TabsList><TabsTrigger value="config">配置</TabsTrigger><TabsTrigger value="source">源码</TabsTrigger></TabsList><TabsContent value="config"><div className="detail-stack"><label>节点类型</label><code>{node?.type}</code><label>配置</label><Payload value={node?.config} /><label>输入绑定</label><Payload value={node?.input} /><label>输入约束</label><Payload value={node?.inputSchema ?? true} /><label>输出约束</label><Payload value={node?.outputSchema} /><details><summary>工作流输入 / 输出约束</summary><Payload value={{ inputSchema: version.definition.inputSchema, outputSchema: version.definition.outputSchema }} /></details><details><summary>完整流程定义</summary><Payload value={version.definition} /></details></div></TabsContent><TabsContent value="source"><SourceTabs files={version.files} path={path} onPath={setPath} /></TabsContent></Tabs></aside></div>;
}
export function SourceTabs({ files, path, onPath, onChange }: { files: SourceFiles; path: string; onPath: (path: string) => void; onChange?: (value: string, path: string) => void }) {
  const selected = Object.hasOwn(files, path) ? path : Object.keys(files)[0]!;
  return <div className="source-view"><Select value={selected} onValueChange={onPath}><SelectTrigger className="w-full" aria-label="选择源码文件"><SelectValue /></SelectTrigger><SelectContent>{Object.keys(files).map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select><Suspense fallback={<Loading />}><CodeEditor path={selected} value={files[selected] ?? ""} onChange={onChange ? value => onChange(value, selected) : undefined} /></Suspense></div>;
}
export function WorkflowPage({ id }: { id: string }) {
  const { data, error } = useResource<WorkflowSummary & { versions: Version[] }>(`/workflows/${id}`);
  const [versionId, setVersionId] = useState(""), [actionError, setActionError] = useState("");
  useEffect(() => { if (data && !versionId) setVersionId(data.currentVersionId); }, [data, versionId]);
  const version = useResource<Version & { files: SourceFiles }>(`/workflows/${id}/versions/${versionId || "pending"}`);
  return <><BackButton /><PageHeading eyebrow="WORKFLOW" title={data?.name ?? "工作流详情"} description={data?.id}><Select value={versionId} onValueChange={setVersionId}><SelectTrigger aria-label="选择工作流版本"><SelectValue placeholder="版本" /></SelectTrigger><SelectContent>{data?.versions.map(v => <SelectItem value={v.id} key={v.id}>v{v.number}</SelectItem>)}</SelectContent></Select><Button variant="outline" onClick={() => void newDraft(id).catch(e => setActionError(e.message))}><Sparkles size={15} />Agent 修改</Button>{versionId && <RunButton workflowId={id} versionId={versionId} />}</PageHeading><ErrorNotice message={error || actionError || (versionId ? version.error : "")} />{version.data && version.data.id === versionId ? <VersionBody key={versionId} version={version.data} /> : <Loading />}</>;
}
