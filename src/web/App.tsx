import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { Button, Card, ConfigProvider, Descriptions, Divider, Empty, Form, Input, Layout, List, Menu, Modal, Popconfirm, Result, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Typography, message } from "antd";
import { AppstoreOutlined, ArrowLeftOutlined, DashboardOutlined, DeleteOutlined, DownloadOutlined, FilterOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, SettingOutlined, UploadOutlined, UserAddOutlined } from "@ant-design/icons";
import "antd/dist/reset.css";
import { WorkflowDetailPage } from "./WorkflowDetailPage.js";

const { Sider, Content } = Layout;
type Workflow = { id: string; name: string; description?: string; status: string; workspaceId?: string };
type DiscoveredWorkflow = { workspace: string; id: string; name: string; description?: string; relativePath: string; entry: string };
type Run = { id: string; status: string; workflowVersionId?: string; inputRef?: string; createdAt?: number };
type RunEvent = { id: string; sequenceNo: number; type: string; stepId?: string; attemptId?: string; payload?: unknown; createdAt: number };
type Agent = { id: string; name: string; provider: string; model: string };
type Page = "overview" | "workflows" | "runs" | "settings";
const pagePaths: Record<Page, string> = { overview: "/", workflows: "/workflows", runs: "/runs", settings: "/settings" };
function pageFromPath(pathname: string): Page { if (pathname === "/workflows" || pathname.startsWith("/workflows/")) return "workflows"; if (pathname === "/runs" || pathname.startsWith("/runs/")) return "runs"; if (pathname === "/settings") return "settings"; return "overview"; }
async function api<T>(url: string, options?: RequestInit): Promise<T> { const response = await fetch(url, options); if (response.ok && response.status === 204) return undefined as T; const body = await response.json(); if (!response.ok) throw new Error(body.message || "请求失败"); return body; }
const statusColor: Record<string, string> = { active: "green", succeeded: "green", completed: "green", running: "blue", queued: "gold", failed: "red", cancelled: "default" };
const statusLabel: Record<string, string> = { active: "已启用", succeeded: "成功", completed: "已完成", running: "运行中", queued: "排队中", failed: "失败", cancelled: "已取消" };
function StatusTag({ status }: { status: string }) { return <Tag color={statusColor[status] || "default"}>{statusLabel[status] || status}</Tag>; }
function formatDate(value?: number) { return value ? new Date(value).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "—"; }

export default function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname); const [workflows, setWorkflows] = useState<Workflow[]>([]); const [discovered, setDiscovered] = useState<DiscoveredWorkflow[]>([]); const [runs, setRuns] = useState<Run[]>([]); const [agents, setAgents] = useState<Agent[]>([]); const [loading, setLoading] = useState(false); const [open, setOpen] = useState(false); const [agentOpen, setAgentOpen] = useState(false); const [form] = Form.useForm(); const [agentForm] = Form.useForm(); const [messageApi, contextHolder] = message.useMessage();
  const [runWorkflow, setRunWorkflow] = useState<Workflow | null>(null);
  const [runInput, setRunInput] = useState("{}");
  const [runInputError, setRunInputError] = useState<string>();
  const [submittingRun, setSubmittingRun] = useState(false);
  const load = async () => { setLoading(true); try { const [workflowBody, runBody, agentBody] = await Promise.all([api<{ items: Workflow[] }>("/api/workflows?limit=100&offset=0"), api<{ items: Run[] }>("/api/runs?limit=100&offset=0"), api<{ items: Agent[] }>("/api/agents")]); setWorkflows(workflowBody.items); setRuns(runBody.items); setAgents(agentBody.items); } catch (error) { messageApi.error(error instanceof Error ? error.message : "加载失败"); } finally { setLoading(false); } };
  const page = pageFromPath(pathname);
  const detailRunId = /^\/runs\/([^/]+)$/.exec(pathname)?.[1];
  const detailWorkflowId = /^\/workflows\/([^/]+)$/.exec(pathname)?.[1];
  const [detailHeaderContainer, setDetailHeaderContainer] = useState<HTMLDivElement | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  useEffect(() => { const onPopState = () => setPathname(window.location.pathname); window.addEventListener("popstate", onPopState); return () => window.removeEventListener("popstate", onPopState); }, []);
  const navigatePath = (path: string) => { if (window.location.pathname !== path) window.history.pushState({}, "", path); setPathname(path); };
  const navigate = (nextPage: Page) => navigatePath(pagePaths[nextPage]);
  const openWorkflow = (workflow: Workflow) => navigatePath(`/workflows/${encodeURIComponent(workflow.id)}`);
  const openRun = (run: Run) => navigatePath(`/runs/${encodeURIComponent(run.id)}`);
  useEffect(() => { void load(); }, []);
  const create = async (values: { name: string; description?: string }) => { try { await api("/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) }); messageApi.success("工作流已创建"); setOpen(false); form.resetFields(); void load(); } catch (error) { messageApi.error(error instanceof Error ? error.message : "创建失败"); } };
  const createAgent = async (values: { name: string; provider: string; model: string }) => { try { const agent = await api<Agent>("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) }); setAgents((items) => [...items, agent]); setAgentOpen(false); agentForm.resetFields(); messageApi.success("Agent 已创建"); } catch (error) { messageApi.error(error instanceof Error ? error.message : "Agent 创建失败"); } };
  const exportWorkflow = async (workflow: Workflow) => { try { const response = await fetch(`/api/workflows/${encodeURIComponent(workflow.id)}/export`); if (!response.ok) throw new Error("导出服务不可用"); const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `${workflow.name || "workflow"}.orchard.json`; link.click(); URL.revokeObjectURL(url); } catch (error) { messageApi.error(error instanceof Error ? error.message : "导出失败"); } };
  const deleteWorkflow = async (workflow: Workflow) => {
    try {
      await api<void>(`/api/workflows/${encodeURIComponent(workflow.id)}`, { method: "DELETE" });
      setWorkflows(items => items.filter(item => item.id !== workflow.id));
      if (runWorkflow?.id === workflow.id) setRunWorkflow(null);
      if (detailWorkflowId === workflow.id) navigate("workflows");
      messageApi.success("工作流已删除");
    } catch (error) { messageApi.error(error instanceof Error ? error.message : "删除失败"); }
  };
  const importWorkflow = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; try { await api("/api/workflows/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() }); messageApi.success("工作流已导入"); void load(); } catch (error) { messageApi.error(error instanceof Error ? error.message : "导入失败"); } };
  const scanWorkflows = async () => { try { const body = await api<{ items: DiscoveredWorkflow[] }>("/api/workflows/discovered"); setDiscovered(body.items); if (!body.items.length) messageApi.info("没有发现新的工作流"); } catch (error) { messageApi.error(error instanceof Error ? error.message : "扫描失败"); } };
  const addDiscovered = async (item: DiscoveredWorkflow) => { try { await api("/api/workflows/discovered", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: item.workspace, id: item.id }) }); messageApi.success(`已添加工作流：${item.name}`); setDiscovered((items) => items.filter((candidate) => candidate !== item)); void load(); } catch (error) { messageApi.error(error instanceof Error ? error.message : "添加失败"); } };
  const run = (workflow: Workflow) => { setRunWorkflow(workflow); setRunInput("{}"); setRunInputError(undefined); };
  const submitRun = async () => {
    if (!runWorkflow || submittingRun) return;
    let input: unknown;
    try { input = runInput.trim() ? JSON.parse(runInput) : null; }
    catch { setRunInputError("JSON 格式有误，请检查引号、逗号和括号。"); return; }
    setRunInputError(undefined);
    setSubmittingRun(true);
    try {
      await api(`/api/workflows/${encodeURIComponent(runWorkflow.id)}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
      setRunWorkflow(null);
      messageApi.success("已加入运行队列");
      void load();
    } catch (error) { messageApi.error(error instanceof Error ? error.message : "运行失败"); }
    finally { setSubmittingRun(false); }
  };
  const title = detailWorkflowId ? "工作流 / 详情" : detailRunId ? "运行记录 / 详情" : { overview: "总览", workflows: "工作流", runs: "运行记录", settings: "设置" }[page];
  return <ConfigProvider componentSize="small" theme={{ token: { colorPrimary: "#1677ff", borderRadius: 6, fontSize: 13, controlHeight: 28, fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif" } }}>{contextHolder}<Layout className="orchard-layout"><Sider theme="light" width={168} breakpoint="lg" collapsedWidth={56} className="orchard-sider"><div className="orchard-brand"><span>✦</span><b>Orchard</b></div><Menu mode="inline" selectedKeys={[page]} onClick={({ key }) => navigate(key as Page)} items={[{ key: "overview", icon: <DashboardOutlined />, label: "总览" }, { key: "workflows", icon: <AppstoreOutlined />, label: "工作流" }, { key: "runs", icon: <PlayCircleOutlined />, label: "运行记录" }, { key: "settings", icon: <SettingOutlined />, label: "设置" }]} /><div className="sider-status"><i />本地服务运行中</div></Sider><Content className="orchard-content"><div className={`content-header${detailWorkflowId || detailRunId ? " content-header--detail" : ""}`}><Typography.Text strong className="page-title">{title}</Typography.Text>{(detailWorkflowId || detailRunId) && <div className="detail-header-slot" ref={setDetailHeaderContainer} />}{page === "workflows" && !detailWorkflowId && <Space className="workflow-page-actions"><Button onClick={scanWorkflows}>扫描本地工作流</Button><label className="import-button"><Button icon={<UploadOutlined />} htmlType="button">导入</Button><input aria-label="导入工作流文件" type="file" accept=".json,.orchard.json,application/json" onChange={importWorkflow} /></label><Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建工作流</Button></Space>}<Button icon={<ReloadOutlined />} onClick={() => { if (detailRunId || detailWorkflowId) setDetailRevision(value => value + 1); else void load(); }} loading={loading && !detailRunId && !detailWorkflowId}>刷新</Button></div><div className={`workspace-body${detailWorkflowId || detailRunId ? " workspace-body--detail" : ""}`}>{page === "overview" && <Overview workflows={workflows} runs={runs} loading={loading} onCreate={() => setOpen(true)} onRun={run} onOpen={navigate} onOpenRun={openRun} onOpenWorkflow={openWorkflow} />}{page === "workflows" && (detailWorkflowId ? <WorkflowDetailPage headerContainer={detailHeaderContainer} key={detailWorkflowId} workflowId={detailWorkflowId} revision={detailRevision} onBack={() => navigate("workflows")} onRun={run} onDelete={deleteWorkflow} /> : <WorkflowPage workflows={workflows} discovered={discovered} loading={loading} onAddDiscovered={addDiscovered} onRun={run} onDelete={deleteWorkflow} onExport={exportWorkflow} onOpenWorkflow={openWorkflow} />)}{page === "runs" && (detailRunId ? <RunDetailPage headerContainer={detailHeaderContainer} key={detailRunId} runId={detailRunId} revision={detailRevision} onBack={() => navigate("runs")} /> : <RunsPage runs={runs} loading={loading} onOpen={openRun} />)}{page === "settings" && <><RuntimeControls /><SettingsPage messageApi={messageApi} /></>}</div></Content><Modal title="运行工作流" centered open={Boolean(runWorkflow)} width={600} okText="开始运行" cancelText="取消" confirmLoading={submittingRun} cancelButtonProps={{ disabled: submittingRun }} closable={!submittingRun} maskClosable={!submittingRun} keyboard={!submittingRun} onCancel={() => { if (!submittingRun) setRunWorkflow(null); }} onOk={() => void submitRun()}>
    <Typography.Title level={5}>{runWorkflow?.name}</Typography.Title>
    {runWorkflow?.description && <Typography.Paragraph type="secondary">{runWorkflow.description}</Typography.Paragraph>}
    <Form layout="vertical"><Form.Item label="运行输入（JSON）" validateStatus={runInputError ? "error" : ""} help={runInputError || "请输入工作流所需的参数；无需参数时使用 {}，留空将传入 null。"}>
      <Input.TextArea aria-label="运行输入（JSON）" value={runInput} onChange={(event) => { setRunInput(event.target.value); setRunInputError(undefined); }} rows={8} spellCheck={false} disabled={submittingRun} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }} />
    </Form.Item></Form>
  </Modal><Modal title="新建工作流" open={open} onCancel={() => setOpen(false)} footer={null}><Form form={form} layout="vertical" onFinish={create}><Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}><Input placeholder="例如：每周报告" maxLength={200} /></Form.Item><Form.Item label="Agent（可选）" name="agentId"><Select allowClear placeholder="选择执行 Agent" options={agents.map((agent) => ({ value: agent.id, label: `${agent.name} · ${agent.model}` }))} /></Form.Item><Button type="link" icon={<UserAddOutlined />} onClick={() => setAgentOpen(true)} block>创建 Agent</Button><Button type="primary" htmlType="submit" block>创建工作流</Button></Form></Modal><Modal title="创建 Agent" open={agentOpen} onCancel={() => setAgentOpen(false)} footer={null}><Form form={agentForm} layout="vertical" onFinish={createAgent}><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input placeholder="例如：报告助手" /></Form.Item><Form.Item name="provider" label="Provider" rules={[{ required: true }]}><Input placeholder="例如：openai" /></Form.Item><Form.Item name="model" label="模型" rules={[{ required: true }]}><Input placeholder="例如：gpt-4o-mini" /></Form.Item><Button type="primary" htmlType="submit" block>保存 Agent</Button></Form></Modal></Layout></ConfigProvider>;
}
function Overview({ workflows, runs, loading, onCreate, onRun, onOpen, onOpenRun, onOpenWorkflow }: { workflows: Workflow[]; runs: Run[]; loading: boolean; onCreate: () => void; onRun: (workflow: Workflow) => void; onOpen: (page: Page) => void; onOpenRun: (run: Run) => void; onOpenWorkflow: (workflow: Workflow) => void }) { return <><Card className="welcome-card" bordered={false}><Typography.Title level={4}>工作区总览</Typography.Title><Typography.Paragraph>管理工作流并跟踪执行状态。</Typography.Paragraph></Card><div className="stat-grid"><Card><Statistic title="工作流" value={workflows.length} suffix={<small>已创建</small>} /></Card><Card><Statistic title="近期运行" value={runs.length} suffix={<small>最近记录</small>} /></Card><Card><Statistic title="服务状态" value="正常" valueStyle={{ color: "#34a853" }} suffix={<small>仅本机可用</small>} /></Card></div><Card title={<SectionTitle eyebrow="YOUR AUTOMATIONS" title="工作流" />} extra={<Space><Button type="link" onClick={() => onOpen("workflows")}>查看全部</Button><Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>新建工作流</Button></Space>} className="section-card"><WorkflowList workflows={workflows.slice(0, 5)} loading={loading} onRun={onRun} onOpen={onOpenWorkflow} /></Card><Card title={<SectionTitle eyebrow="ACTIVITY" title="最近运行" />} extra={<Button type="link" onClick={() => onOpen("runs")}>查看全部</Button>} className="section-card"><RunList runs={runs.slice(0, 5)} loading={loading} onOpen={onOpenRun} /></Card></> }
function WorkflowList({ workflows, loading, onRun, onExport, onOpen, onDelete }: { workflows: Workflow[]; loading: boolean; onRun: (workflow: Workflow) => void; onExport?: (workflow: Workflow) => void; onOpen: (workflow: Workflow) => void; onDelete?: (workflow: Workflow) => Promise<void> }) { return <List loading={loading} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有工作流，创建第一个吧。" /> }} dataSource={workflows} renderItem={(workflow) => <List.Item actions={[<StatusTag key="status" status={workflow.status} />, onDelete && <Popconfirm key="delete" title="删除工作流？" description="从工作台移除并停止触发，保留源码和运行历史。" okText="删除" cancelText="取消" onConfirm={() => onDelete(workflow)}><Button danger icon={<DeleteOutlined />}>删除</Button></Popconfirm>, onExport && <Button key="export" size="small" icon={<DownloadOutlined />} onClick={() => onExport(workflow)}>导出</Button>, <Button key="run" size="small" disabled={workflow.status !== "active"} onClick={() => onRun(workflow)}>运行</Button>]}><List.Item.Meta title={<Button className="workflow-title-link" type="link" onClick={() => onOpen(workflow)}>{workflow.name}</Button>} description={workflow.description || "暂无描述"} /></List.Item>} /> }
function WorkflowPage({ workflows, discovered, loading, onAddDiscovered, onRun, onDelete, onExport, onOpenWorkflow }: {
  workflows: Workflow[]; discovered: DiscoveredWorkflow[]; loading: boolean;
  onAddDiscovered: (item: DiscoveredWorkflow) => void; onRun: (workflow: Workflow) => void;
  onDelete: (workflow: Workflow) => Promise<void>; onExport: (workflow: Workflow) => void;
  onOpenWorkflow: (workflow: Workflow) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => workflows.filter(item => `${item.name} ${item.description || ""}`.toLowerCase().includes(query.toLowerCase())), [workflows, query]);
  return <Card className="section-card page-card">
    <div className="toolbar"><Input allowClear prefix={<FilterOutlined />} placeholder="搜索工作流" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {discovered.length > 0 && <Card size="small" title="发现的本地工作流" style={{ marginBottom: 16 }}><List size="small" dataSource={discovered} renderItem={item => <List.Item actions={[<Button key="add" type="link" onClick={() => onAddDiscovered(item)}>添加到工作台</Button>]}><List.Item.Meta title={item.name} description={`${item.workspace}/${item.id} · ${item.relativePath}`} /></List.Item>} /></Card>}
    <WorkflowList workflows={filtered} loading={loading} onRun={onRun} onDelete={onDelete} onExport={onExport} onOpen={onOpenWorkflow} />
  </Card>;
}
function RunList({ runs, loading, onOpen }: { runs: Run[]; loading: boolean; onOpen: (run: Run) => void }) { return <List loading={loading} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运行记录" /> }} dataSource={runs} renderItem={(item) => <List.Item className="run-item" onClick={() => onOpen(item)}><div><Typography.Text strong>{item.id}</Typography.Text><Typography.Text type="secondary" className="run-time">{formatDate(item.createdAt)}</Typography.Text></div><StatusTag status={item.status} /></List.Item>} /> }
function RunsPage({ runs, loading, onOpen }: { runs: Run[]; loading: boolean; onOpen: (run: Run) => void }) { return <Card className="section-card page-card" title={<SectionTitle eyebrow="ACTIVITY" title={`${runs.length} 条运行记录`} />}><Table size="small" rowKey="id" loading={loading} dataSource={runs} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运行记录" /> }} onRow={(record) => ({ onClick: () => onOpen(record), style: { cursor: "pointer" } })} columns={[{ title: "运行 ID", dataIndex: "id", ellipsis: true }, { title: "状态", dataIndex: "status", render: (status: string) => <StatusTag status={status} /> }, { title: "工作流版本", dataIndex: "workflowVersionId", ellipsis: true, responsive: ["md"] }, { title: "创建时间", dataIndex: "createdAt", render: (value?: number) => formatDate(value) }, { title: '操作', render: (_: unknown, record: Run) => <Space><RunAction run={record} operation="cancel" /><RunAction run={record} operation="rerun" /></Space> }]} /></Card> }
function RunDetailPage({ runId, revision, onBack, headerContainer }: { headerContainer: HTMLElement | null; runId: string; revision: number; onBack: () => void }) {
  const [activeTab, setActiveTab] = useState("logs");
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void Promise.all([
      api<Run>(`/api/runs/${runId}`, { signal: controller.signal }),
      api<{ items: RunEvent[] }>(`/api/runs/${runId}/events`, { signal: controller.signal }),
    ]).then(([detail, logs]) => {
      if (!controller.signal.aborted) { setRun(detail); setEvents(logs.items); }
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "运行详情加载失败");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [runId, revision]);
  return <div className="run-detail-page">
    {headerContainer && createPortal(<div className="workflow-detail-toolbar">
      <Button type="text" icon={<ArrowLeftOutlined />} aria-label="返回运行记录" title="返回运行记录" onClick={onBack} />
      <Typography.Text strong className="run-detail-id" title={run?.id ?? runId}>{run?.id ?? runId}</Typography.Text>
      {run && <span className="run-header-status"><StatusTag status={run.status} /></span>}
    </div>, headerContainer)}
    {loading ? <Card className="section-card"><div className="run-detail-loading"><Spin tip="正在加载运行详情"><div style={{ minHeight: 80 }} /></Spin></div></Card>
      : error ? <Card className="section-card"><Result status="warning" title="无法加载运行详情" subTitle={error} extra={<Button onClick={onBack}>返回运行记录</Button>} /></Card>
      : run && <div className="run-detail-panel">
        <Tabs className="run-detail-tabs" activeKey={activeTab} onChange={setActiveTab} size="small" items={[
          { key: "info", label: "基本信息", children: <div className="run-info-panel"><Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
            <Descriptions.Item label="运行 ID"><Typography.Text copyable>{run.id}</Typography.Text></Descriptions.Item>
            <Descriptions.Item label="状态"><StatusTag status={run.status} /></Descriptions.Item>
            <Descriptions.Item label="工作流版本">{run.workflowVersionId || "—"}</Descriptions.Item>
            <Descriptions.Item label="创建时间">{formatDate(run.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="输入引用" span={2}><pre className="run-detail-payload">{run.inputRef || "—"}</pre></Descriptions.Item>
          </Descriptions></div> },
          { key: "logs", label: `运行日志（${events.length}）`, children: <div className="run-logs-panel"><List locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运行日志" /> }} dataSource={events} renderItem={(event) => <List.Item>
            <List.Item.Meta title={<Space wrap><Typography.Text strong>{event.type}</Typography.Text><Typography.Text type="secondary">{formatDate(event.createdAt)}</Typography.Text></Space>} description={<>
              {(event.stepId || event.attemptId) && <Typography.Text type="secondary">{event.stepId ? `步骤：${event.stepId}` : ""}{event.attemptId ? ` · 尝试：${event.attemptId}` : ""}</Typography.Text>}
              {event.payload !== undefined && <pre className="run-detail-payload">{JSON.stringify(event.payload, null, 2)}</pre>}
            </>} />
          </List.Item>} /></div> },
        ]} />
      </div>}
  </div>;
}

function SettingsPage({ messageApi }: { messageApi: { success: (content: string) => void } }) { const [saved, setSaved] = useState(() => localStorage.getItem("orchard.settings") === "saved"); const save = () => { localStorage.setItem("orchard.settings", "saved"); setSaved(true); messageApi.success("设置已保存到本机"); }; return <div className="settings-grid"><Card className="section-card" title={<SectionTitle eyebrow="WORKSPACE" title="工作区设置" />}><Form layout="vertical"><Form.Item label="工作区名称"><Input defaultValue="我的 Orchard 工作区" /></Form.Item><Form.Item label="默认时区"><Select defaultValue="Asia/Shanghai" options={[{ value: "Asia/Shanghai", label: "中国标准时间（Asia/Shanghai）" }, { value: "UTC", label: "协调世界时（UTC）" }]} /></Form.Item><Form.Item label="运行完成后保留记录"><Select defaultValue="forever" options={[{ value: "forever", label: "永久保留" }, { value: "90", label: "保留 90 天" }, { value: "30", label: "保留 30 天" }]} /></Form.Item><Button type="primary" onClick={save}>{saved ? "已保存" : "保存设置"}</Button></Form></Card><Card className="section-card" title={<SectionTitle eyebrow="RUNTIME" title="运行服务" />}><div className="setting-row"><div><Typography.Text strong>本地运行服务</Typography.Text><Typography.Paragraph type="secondary">工作流仅在当前设备运行和存储。</Typography.Paragraph></div><Switch defaultChecked /></div><Divider /><div className="setting-row"><div><Typography.Text strong>并发运行数</Typography.Text><Typography.Paragraph type="secondary">同时执行的工作流数量。</Typography.Paragraph></div><Select defaultValue="2" style={{ width: 92 }} options={["1", "2", "4", "8"].map((value) => ({ value, label: value }))} /></div><Divider /><Typography.Text type="secondary">版本 0.1.0 · Orchard Workbench</Typography.Text></Card></div> }
function RunAction({ run, operation }: { run: Run; operation: 'cancel' | 'rerun' }) {
  const [busy, setBusy] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [stepId, setStepId] = useState("");
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api<{ id?: string; runId?: string }>(`/api/runs/${encodeURIComponent(run.id)}/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation === 'rerun' && stepId.trim() ? { stepId: stepId.trim() } : {}) });
      setReplayOpen(false);
      message.success(`已接受：${result.id ?? result.runId ?? run.id}`);
    } catch (error) { message.error(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  };
  return <span onClick={event => event.stopPropagation()}>
    <Button loading={busy} onClick={() => { if (operation === 'rerun') { setStepId(""); setReplayOpen(true); } else void submit(); }}>{operation === 'cancel' ? '取消' : '重放'}</Button>
    <Modal title="重放运行" centered open={replayOpen} okText="开始重放" cancelText="取消" confirmLoading={busy} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy} onCancel={() => { if (!busy) setReplayOpen(false); }} onOk={() => void submit()}>
      <Form layout="vertical"><Form.Item label="起始步骤（可选）" extra="留空将重放整次运行，填写步骤 ID 可从指定步骤开始。"><Input value={stepId} disabled={busy} onChange={event => setStepId(event.target.value)} placeholder="例如：submit-metric-task" /></Form.Item></Form>
    </Modal>
  </span>;
}

function RuntimeControls() {
  const [health, setHealth] = useState<unknown>();
  const [schedules, setSchedules] = useState<{ id: string; expression: string; enabled: boolean }[]>([]);
  const request = async (action: () => Promise<void>) => { try { await action(); } catch (error) { message.error(error instanceof Error ? error.message : '请求失败'); } };
  const refresh = () => request(async () => { setHealth(await api('/api/worker/health')); setSchedules((await api<{ items: typeof schedules }>('/api/schedules')).items); });
  return <Card title="运行管理" extra={<Button onClick={() => void refresh()}>查询 Worker / Schedule</Button>}>
    {health !== undefined && <pre>{JSON.stringify(health, null, 2)}</pre>}
    <List dataSource={schedules} renderItem={schedule => <List.Item actions={[<Switch key="enabled" checked={schedule.enabled} onChange={enabled => void request(async () => { await api(`/api/schedules/${encodeURIComponent(schedule.id)}/enabled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }); await refresh(); })} />]}>{schedule.id} · {schedule.expression}</List.Item>} />
    <Form layout="vertical" onFinish={(values: { source: string; id: string; name: string; data: string }) => void request(async () => { const result = await api('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, data: JSON.parse(values.data) }) }); message.success(JSON.stringify(result)); })} initialValues={{ source: 'workbench', data: '{}' }}>
      <Form.Item name="source" label="事件来源" rules={[{ required: true }]}><Input /></Form.Item>
      <Form.Item name="id" label="事件幂等 ID" rules={[{ required: true }]}><Input /></Form.Item>
      <Form.Item name="name" label="事件名称" rules={[{ required: true }]}><Input /></Form.Item>
      <Form.Item name="data" label="JSON 数据" rules={[{ required: true }]}><Input.TextArea /></Form.Item>
      <Button htmlType="submit">发送事件</Button>
    </Form>
  </Card>;
}

function SectionTitle({ eyebrow, title }: { eyebrow: string; title: string }) { return <div><Typography.Text strong>{title}</Typography.Text></div>; }
const root = document.getElementById("root"); if (!root) throw new Error("Workbench root element is missing"); createRoot(root).render(<App />);
