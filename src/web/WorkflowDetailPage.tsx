import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, Button, Card, Descriptions, Empty, Popconfirm, Result, Spin, Table, Tabs, Tag, Typography } from "antd";
import { ArrowLeftOutlined, DeleteOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { MonacoWorkflowEditor } from "./MonacoWorkflowEditor.js";
import type { WorkflowDetail, WorkflowStepDescription } from "../server/workflow-detail.js";

export function WorkflowDetailPage({ workflowId, revision, onBack, onRun, onDelete, headerContainer }: { headerContainer: HTMLElement | null; workflowId: string; revision: number; onBack: () => void; onRun: (workflow: WorkflowDetail["workflow"]) => void; onDelete: (workflow: WorkflowDetail["workflow"]) => Promise<void> }) {
  const [detail, setDetail] = useState<WorkflowDetail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filePath, setFilePath] = useState("");
  const [activeTab, setActiveTab] = useState("steps");
  const [focusLine, setFocusLine] = useState<number>();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(undefined);
    void fetch(`/api/workflows/${workflowId}`, { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "工作流加载失败");
      return body as WorkflowDetail;
    }).then(body => {
      if (!controller.signal.aborted) { setDetail(body); setFilePath(body.entry ?? body.files[0]?.path ?? ""); setFocusLine(undefined); }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "工作流加载失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workflowId, revision]);
  const showSource = (step: WorkflowStepDescription) => { setActiveTab("code"); setFilePath(step.file); setFocusLine(step.line); };
  return <div className="workflow-detail-page">
    {loading ? <Card className="section-card"><Spin><div style={{ minHeight: 120 }} /></Spin></Card>
      : error ? <Card className="section-card"><Result status="warning" title="无法加载工作流" subTitle={error} /></Card>
      : detail && <>
        {detail.sourceWarning && <Alert type="warning" showIcon message={detail.sourceWarning} className="workflow-source-warning" />}
        {headerContainer && createPortal(<div className="workflow-detail-toolbar">
          <Button type="text" icon={<ArrowLeftOutlined />} aria-label="返回工作流" title="返回工作流" onClick={onBack} />
          <Typography.Title level={5} className="workflow-detail-title" title={detail.workflow.name}>{detail.workflow.name}</Typography.Title>
          <Tag>{detail.version ? `v${detail.version.number}` : "尚未发布"}</Tag>
          <Tag color={detail.workflow.status === "active" ? "green" : "default"}>{detail.workflow.status === "active" ? "已启用" : detail.workflow.status}</Tag>
          <Popconfirm title="删除工作流？" description="从工作台移除并停止触发，保留源码和运行历史。" okText="删除" cancelText="取消" onConfirm={() => onDelete(detail.workflow)}><Button danger icon={<DeleteOutlined />}>删除</Button></Popconfirm>
          <Button className="workflow-run-button" type="primary" icon={<PlayCircleOutlined />} disabled={!detail.version || detail.workflow.status !== "active"} onClick={() => onRun(detail.workflow)}>运行</Button>
        </div>, headerContainer)}
        <div className="workflow-detail-panel">
          <Tabs className="workflow-detail-tabs" activeKey={activeTab} onChange={setActiveTab} size="small" items={[
            { key: "info", label: "基本信息", children: <div className="workflow-info-panel"><Typography.Paragraph type="secondary">{detail.workflow.description || "暂无描述"}</Typography.Paragraph><Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
              <Descriptions.Item label="工作流 ID">{detail.workflow.id}</Descriptions.Item>
              <Descriptions.Item label="当前版本">{detail.version ? `v${detail.version.number}` : "尚未发布"}</Descriptions.Item>
              <Descriptions.Item label="触发器"><pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{detail.definition ? JSON.stringify(detail.definition.triggers, null, 2) : "—"}</pre></Descriptions.Item>
              <Descriptions.Item label="执行策略"><pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{detail.definition ? JSON.stringify({ ...detail.definition.policy, ...(detail.definition.concurrency === undefined ? {} : { concurrency: detail.definition.concurrency }) }, null, 2) : "—"}</pre></Descriptions.Item>
              <Descriptions.Item label="入口文件">{detail.entry || "—"}</Descriptions.Item>
              <Descriptions.Item label="发布时间">{detail.version ? new Date(detail.version.createdAt).toLocaleString("zh-CN") : "—"}</Descriptions.Item>
            </Descriptions></div> },
            { key: "steps", label: `步骤说明（${detail.steps.length}）`, children: <div className="workflow-steps-panel">
              <Typography.Paragraph type="secondary" className="workflow-step-hint">步骤说明来自源码中的 description 或步骤前的注释；按声明顺序展示，实际执行情况以运行日志为准。</Typography.Paragraph>
              <Table size="small" pagination={false} rowKey={step => `${step.file}:${step.line}:${step.id}`} dataSource={detail.steps} scroll={{ x: 850 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detail.version ? "未识别到显式步骤，请查看源码中的 run 函数。" : "发布工作流后可查看步骤。"} /> }} columns={[
                { title: "#", width: 42, render: (_: unknown, _step: WorkflowStepDescription, index: number) => index + 1 },
                { title: "步骤", dataIndex: "id", width: 240, ellipsis: true },
                { title: "节点类型", dataIndex: "type", width: 170 },
                { title: "说明", dataIndex: "description", render: (description: string) => description || "暂无描述" },
                { title: "源码位置", render: (_: unknown, step: WorkflowStepDescription) => <Button type="link" size="small" onClick={() => showSource(step)}>{step.file}:{step.line}</Button> },
              ]} />
            </div> },
            { key: "code", label: "工作流代码", children: detail.files.length ? <MonacoWorkflowEditor files={detail.files} filePath={filePath} focusLine={focusLine} visible={activeTab === "code"} onSelectFile={path => { setFilePath(path); setFocusLine(undefined); }} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detail.version ? "暂无可展示的源码" : "工作流尚未发布"} /> },
          ]} />
        </div>
      </>}
  </div>;
}
