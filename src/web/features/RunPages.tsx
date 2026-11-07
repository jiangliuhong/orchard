import { useEffect, useRef, useState } from "react";
import { Clock3, GitBranch, RefreshCw, Square } from "lucide-react";
import type { NodeRun, Run, RunAgentBinding, RunExecution, StreamEvent, Version } from "../../domain/types.js";
import { mergeEvents, send, useResource, useStream } from "../lib/api";
import { Button } from "../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { BackButton, EmptyState, ErrorNotice, Loading, NodePicker, PageHeading, Payload, Status } from "../components/common";
import FlowCanvas from "./FlowCanvas";
import { applyEventStatus } from "./graph";
import { RunButton } from "./WorkflowPages";
import { FinalResult } from "./FinalResult";

interface RunDetail extends Run { version: Version | null; execution: RunExecution; agentBindings?: RunAgentBinding[]; nodes: NodeRun[]; lastSequence: number; attempts: { id: string; nodeRunId: string; execution: unknown; status: string }[] }
export function RunsPage() {
  const { data, error, reload } = useResource<{ items: Run[] }>("/runs");
  useEffect(() => { const timer = setInterval(reload, 3000); return () => clearInterval(timer); }, []);
  return <><PageHeading eyebrow="ACTIVITY" title="运行记录" description="正式运行和草稿测试独立保存，结果对应创建运行时的流程快照。"><Button variant="outline" onClick={reload}><RefreshCw size={15} />刷新</Button></PageHeading><ErrorNotice message={error} />{!data ? <Loading /> : data.items.length ? <div className="panel run-table"><div className="run-table-header"><span>运行</span><span>状态</span><span>开始时间</span></div>{data.items.map(run => <a href={`/runs/${run.id}`} className="run-table-row" key={run.id}><div><strong>{run.id.slice(0, 8)}</strong><small>{run.draftId ? `草稿测试 · 修订 ${run.draftRevision}` : run.workflowVersionId?.slice(0, 12)}</small></div><Status value={run.status} /><span>{new Date(run.createdAt).toLocaleString("zh-CN")}</span></a>)}</div> : <EmptyState title="还没有运行记录" description="可以在草稿中运行测试，或运行已发布的工作流。" />}</>;
}
export function RunPage({ id }: { id: string }) {
  const resource = useResource<RunDetail>(`/runs/${id}`), [selected, setSelected] = useState(""), [events, setEvents] = useState<StreamEvent[]>([]), [error, setError] = useState("");
  const [liveNodes, setLiveNodes] = useState<NodeRun[]>([]), refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [view, setView] = useState("details"), manualView = useRef(false);
  const run = resource.data, active = run && ["queued", "running", "cancel_requested"].includes(run.status);
  useEffect(() => { if (run && !active && !manualView.current) setView("result"); }, [run?.id, run?.status]);
  useEffect(() => { if (run) { setLiveNodes(run.nodes); setSelected(value => value || run.activeNodeId || run.execution.definition.entryNodeId); } }, [run]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  useEffect(() => { if (!active) return; const timer = setInterval(resource.reload, 2000); return () => clearInterval(timer); }, [active]);
  useStream("runs", id, event => {
    setEvents(current => mergeEvents(current, event));
    if (event.sequence > (run?.lastSequence ?? 0)) setLiveNodes(current => applyEventStatus(current, event));
    if (event.type !== "node.log" && event.type !== "provider.text") {
      clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(resource.reload, 120);
    }
  });
  const node = liveNodes.find(n => n.nodeId === selected);
  const agentBinding = run?.agentBindings?.find(binding => binding.nodeId === selected);
  const selectNode = (nodeId: string) => {
    manualView.current = true;
    if (nodeId === "__end") setView("result");
    else setSelected(nodeId);
  };
  const logs = events.filter(e => e.nodeId === selected && ["node.log", "node.process", "provider.diagnostic", "provider.text"].includes(e.type));
  return <><BackButton href={run?.draftId ? `/drafts/${run.draftId}` : "/runs"} /><PageHeading eyebrow="RUN DETAIL" title={run?.execution.definition.name ?? "运行详情"} description={id}>{run && <Status value={run.status} />}{run?.draftId && <Button variant="outline" asChild><a href={`/drafts/${run.draftId}`}>返回草稿继续编辑 / 测试</a></Button>}{active ? <Button variant="outline" disabled={run?.status === "cancel_requested"} onClick={() => void send(`/runs/${id}/cancel`).then(resource.reload).catch(e => setError(e.message))}><Square size={14} />取消运行</Button> : run?.version && <RunButton workflowId={run.version.workflowId} versionId={run.version.id} />}</PageHeading><ErrorNotice message={error || resource.error || run?.error?.message} />
    {run ? <><div className="run-summary"><span><GitBranch size={14} />{run.draftId ? `草稿测试 · 修订 ${run.draftRevision}` : `v${run.version?.number}`}</span><span><Clock3 size={14} />{new Date(run.createdAt).toLocaleString("zh-CN")}</span><span>{liveNodes.filter(n => n.status === "succeeded").length} / {liveNodes.length} 节点成功</span></div><Tabs value={view} onValueChange={value => { manualView.current = true; setView(value); }}><TabsList className="run-view-tabs"><TabsTrigger value="result">最终结果</TabsTrigger><TabsTrigger value="details">执行详情</TabsTrigger></TabsList><TabsContent value="result"><FinalResult runId={id} status={run.status} value={run.output} /></TabsContent><TabsContent value="details"><div className="run-workspace">
      <section className="canvas-panel"><div className="panel-bar"><span>执行路径</span><span>点击节点查看结果，点击结束查看最终输出</span></div><FlowCanvas workflow={run.execution.definition} layout={run.execution.layout} records={liveNodes} onSelect={selectNode} /></section>
      <aside className="node-panel run-node-panel"><div className="panel-bar"><NodePicker nodes={run.execution.definition.nodes} value={selected} onChange={selectNode} includeOutput />{node && <Status value={node.status} />}</div><Tabs defaultValue="output"><TabsList><TabsTrigger value="output">结果</TabsTrigger><TabsTrigger value="input">输入</TabsTrigger><TabsTrigger value="logs">日志</TabsTrigger><TabsTrigger value="attempts">执行信息</TabsTrigger></TabsList>
        <TabsContent value="output"><div className="detail-stack">{node?.skipReason && <div className="notice">{({ branch_not_selected: "条件未选择此分支", upstream_failed: "上游失败，未启动此节点", run_terminated: "运行已终止" } as Record<string, string>)[node.skipReason] ?? node.skipReason}</div>}<ErrorNotice message={node?.error?.message} />{node?.startedAt && <p className="field-hint">耗时：{((Number(node.endedAt ?? Date.now()) - node.startedAt) / 1000).toFixed(2)} 秒</p>}{node?.route && <><label>路由决策</label><Payload value={node.route} /></>}<label>节点输出</label><Payload value={node?.output} /></div></TabsContent>
        <TabsContent value="input"><div className="detail-stack"><label>节点实际输入</label><Payload value={node?.input} /><label>工作流输入</label><Payload value={run.input} /></div></TabsContent>
        <TabsContent value="logs"><div className="logs"><p className="field-hint">展示最近 500 个事件中的此节点日志；完整记录可通过事件接口分页读取。</p>{logs.length ? logs.map(event => <div className="log-line" key={event.sequence}><time>{new Date(event.createdAt).toLocaleTimeString("zh-CN")}</time><pre>{String((event.payload as { text?: string }).text ?? JSON.stringify(event.payload))}</pre></div>) : <p className="field-hint">此节点暂无日志。</p>}</div></TabsContent>
        <TabsContent value="attempts"><div className="detail-stack">{agentBinding && <div className="run-agent-binding"><strong>{agentBinding.name} · 修订 {agentBinding.configRevision}</strong><p>{agentBinding.providerId} · {agentBinding.modelId}</p><span className="field-hint">创建运行时固定的模型配置</span></div>}<Payload value={run.attempts.filter(a => a.nodeRunId === node?.id)} /></div></TabsContent>
      </Tabs></aside>
    </div></TabsContent></Tabs></> : <Loading />}
  </>;
}
