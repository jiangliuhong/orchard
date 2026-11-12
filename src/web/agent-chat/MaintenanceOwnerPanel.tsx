import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MaintenanceTarget } from "../../agent/maintenance-protocol.js";
import { ErrorNotice, Loading } from "../components/common";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { api, requestId, send } from "../lib/api";
import { MaintenanceProposalReview } from "./MaintenanceProposalReview";

interface Item { id: string; state: string; createdAt: number }
interface Task { id: string; sessionId: string; status: string }
const activeTask = (task: Task) => ["queued", "running", "stopping"].includes(task.status);
const taskLabels: Record<string, string> = { queued: "等待维护任务", running: "Pi 正在生成提案", stopping: "正在结束维护任务",
  succeeded: "维护任务已完成", failed: "维护任务失败", cancelled: "维护任务已取消", interrupted: "维护任务已中断" };
const states: Record<string, string> = { pending: "待审阅", confirmed: "已确认", applied: "已应用", conflicted: "基线冲突", revoked: "已撤销", expired: "已过期" };

export function MaintenanceOwnerPanel({ kind, ownerId, children, onApplied, onClose, disabled }: {
  kind: MaintenanceTarget["kind"]; ownerId: string; children: ReactNode;
  onApplied?(): void; onClose?(): void; disabled?: boolean;
}) {
  const path = `/maintenance/owners/${kind}/${encodeURIComponent(ownerId)}/proposals`;
  const [items, setItems] = useState<Item[]>();
  const [legacy, setLegacy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [revision, refresh] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [task, setTask] = useState<Task>();
  const [submitting, setSubmitting] = useState(false);
  const [taskError, setTaskError] = useState("");
  const submitKey = useRef<{ prompt: string; id: string } | undefined>(undefined);
  const running = !!task && activeTask(task);
  useEffect(() => {
    if (!task || !running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await api<{ items: Task[] }>(`/maintenance/sessions/${encodeURIComponent(task.sessionId)}/tasks`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const latest = result.items.find(item => item.id === task.id);
        if (latest) {
          setTask(latest);
          if (!activeTask(latest)) { refresh(value => value + 1); return; }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setTaskError((error as Error).message);
      }
      timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [task?.id, task?.sessionId, running]);
  const start = async () => {
    const message = prompt.trim();
    if (!message || disabled || running || submitting) return;
    setSubmitting(true);
    setTaskError("");
    if (submitKey.current?.prompt !== message) submitKey.current = { prompt: message, id: requestId() };
    try {
      const next = await send<Task>(`/maintenance/owners/${kind}/${encodeURIComponent(ownerId)}/tasks`, { prompt: message, requestId: submitKey.current.id });
      setTask(next);
      setPrompt("");
      submitKey.current = undefined;
      if (!activeTask(next)) refresh(value => value + 1);
    } catch (error) { setTaskError((error as Error).message); }
    finally { setSubmitting(false); }
  };
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api<{ items: Item[] }>(path, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setItems(value.items);
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (["MAINTENANCE_RUNTIME_REQUIRED", "NOT_FOUND"].includes(error.code)) setLegacy(true);
      else setError(error.message);
    });
    return () => controller.abort();
  }, [path, revision]);
  if (legacy) return children;
  return <section className="agent-chat agent-chat-change maintenance-owner-panel" aria-label="维护提案">
    <div className="panel-bar">
      <strong>维护提案</strong>
      <Button size="sm" variant="ghost" onClick={() => refresh(value => value + 1)}>刷新</Button>
      {onClose && <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>}
    </div>
    <ErrorNotice message={error} />
    {items && <form onSubmit={event => { event.preventDefault(); void start(); }}>
      <label htmlFor="maintenance-prompt">维护需求</label>
      <Textarea id="maintenance-prompt" value={prompt} maxLength={100000} onChange={event => setPrompt(event.target.value)} />
      <Button type="submit" size="sm" disabled={disabled || running || submitting || !prompt.trim()}>生成提案</Button>
    </form>}
    {task && <p role="status">{taskLabels[task.status] ?? task.status}</p>}
    <ErrorNotice message={taskError} />
    {!items && !error && <Loading />}
    {items?.length === 0 && <p>暂无维护提案</p>}
    {!!items?.length && <label>选择提案
      <select value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">选择提案</option>
        {items.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {states[item.state] ?? item.state}</option>)}
      </select>
    </label>}
    {selected && (disabled ? <p>请先保存编辑或等待当前操作完成。</p>
      : <MaintenanceProposalReview proposalId={selected} onApplied={() => { refresh(value => value + 1); onApplied?.(); }} />)}
  </section>;
}
