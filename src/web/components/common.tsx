import type { ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { AlertCircle, LoaderCircle, Plus } from "lucide-react";
import type { WorkflowNode } from "../../domain/types.js";

export const statuses: Record<string, string> = { archived: "已归档", draft: "草稿", publishing: "发布中", published: "已发布", pending: "未执行", queued: "排队中", running: "运行中", cancel_requested: "正在取消", succeeded: "成功", failed: "失败", cancelled: "已取消", interrupted: "已中断", skipped: "已跳过" };
export function Status({ value }: { value: string }) { return <Badge variant="outline" className={`status status-${value}`}><span className="status-dot" />{statuses[value] ?? value}</Badge>; }
export function ErrorNotice({ message }: { message?: string }) { return message ? <div role="alert" className="notice error"><AlertCircle size={16} /><span>{message}</span></div> : null; }
export function Loading() { return <div className="empty"><LoaderCircle className="animate-spin" /><span>正在加载…</span></div>; }
export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) { return <div className="empty"><div className="empty-symbol"><Plus size={25} /></div><h2>{title}</h2><p>{description}</p>{action}</div>; }
export function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description?: string; children?: ReactNode }) { return <header className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{description && <p>{description}</p>}</div><div className="heading-actions">{children}</div></header>; }
export function BackButton({ href = "/" }: { href?: string }) { return <Button variant="ghost" asChild><a href={href}>← 返回</a></Button>; }
export function Payload({ value }: { value: unknown }) {
  const artifact = value && typeof value === "object" && "artifact" in value ? (value as { artifact: { id: string; byteSize: number } }).artifact : null;
  return artifact ? <a className="artifact-link" href={`/api/artifacts/${artifact.id}`} target="_blank" rel="noreferrer">查看完整产物 · {(artifact.byteSize / 1024).toFixed(1)} KiB ↗</a> : <pre className="payload">{JSON.stringify(value, null, 2) ?? "—"}</pre>;
}
export function NodePicker({ nodes, value, onChange, includeOutput = false, includeGlobal = false }: { nodes: WorkflowNode[]; value: string; onChange: (id: string) => void; includeOutput?: boolean; includeGlobal?: boolean }) {
  return <select aria-label="选择节点" className="node-picker" value={value} onChange={e => onChange(e.target.value)}>{includeGlobal && <option value="__global">全局配置</option>}{nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}{includeOutput && <option value="__end">工作流最终输出</option>}</select>;
}
