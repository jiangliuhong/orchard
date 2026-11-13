import { useState } from "react";
import type { MaintenanceSessions } from "../../agent/maintenance-sessions";
import type { MaintenanceTarget } from "../../agent/maintenance-protocol";
import { api, send } from "../lib/api";
import { AgentChat } from "./AgentChat";
import { MaintenanceProposalReview } from "./MaintenanceProposalReview";
import type { AgentChatConfig, ChatMessage } from "./types";
import { useChatPolling } from "./useChatPolling";

type History = ReturnType<MaintenanceSessions["ownerHistory"]>;
type Task = History["tasks"][number];
type Context = {
  kind: MaintenanceTarget["kind"];
  ownerId: string;
  disabled?: boolean;
  onApplied: () => void;
};

const pending = (task: Task) => ["queued", "running", "stopping"].includes(task.status);
const labels = {
  queued: "等待维护任务…",
  running: "正在分析维护需求…",
  stopping: "正在停止…",
  succeeded: "维护任务已完成",
  failed: "维护任务失败，请重试",
  cancelled: "已停止生成",
  interrupted: "维护任务已中断",
};

const config: AgentChatConfig<Context> = {
  id: "maintenance",
  label: "维护 Agent 对话",
  promptLabel: "Agent 维护需求",
  placeholder: "描述需求，或继续修改…",
  welcome: { title: "描述维护需求", description: "可以从历史打开之前的维护对话，也可以选中回复中的文字进行引用。" },
  useSession({ kind, ownerId, disabled, onApplied }, choice) {
    const base = `/maintenance/owners/${kind}/${encodeURIComponent(ownerId)}`;
    const [selected, setSelected] = useState("");
    const [model, setModel] = useState<string>();
    const history = useChatPolling(base, async signal => {
      const data = await api<History>(`${base}/chat${selected ? `?sessionId=${encodeURIComponent(selected)}` : ""}`, { signal });
      if (!Array.isArray(data.conversations) || !Array.isArray(data.tasks)) throw new Error("维护对话加载失败");
      return data;
    },
      data => data.tasks.some(pending));
    const tasks = history.data?.tasks.filter(task => task.sessionId === selected) ?? [];
    const conversation = history.data?.conversations.find(item => item.id === selected);
    const active = tasks.find(pending);
    const readOnly = !!conversation && (conversation.mode === "single" || conversation.lifecycle !== "active" || !!conversation.readOnlyReason);
    const messages = tasks.flatMap<ChatMessage>(task => [
      { id: `${task.id}:user`, role: "user", text: task.prompt },
      {
        id: task.id, role: task.status === "failed" ? "error" : "assistant",
        pending: pending(task), text: task.text || labels[task.status],
        content: task.proposals.length > 0 && <div className="agent-chat-change">{task.proposals.map(({ id }) =>
          <MaintenanceProposalReview key={id} proposalId={id} disabled={!!disabled || !!active} onApplied={onApplied} />)}</div>,
      },
    ]);
    const select = (id: string) => { setSelected(id); setModel(undefined); history.reload(); };
    return {
      conversationId: selected || "new",
      backend: conversation && { providerId: conversation.providerId, modelId: model ?? conversation.modelId },
      chooseBackend: conversation && (value => setModel(value.modelId)),
      title: conversation?.title || messages[0]?.text || "新对话",
      conversations: (history.data?.conversations ?? []).map(item => ({
        id: item.id, title: item.title, meta: `${item.modelId} · ${new Date(item.updatedAt).toLocaleString("zh-CN")}`,
      })),
      messages, error: history.error,
      loading: !history.data && !history.error,
      locked: !!disabled || readOnly || (!!selected && !conversation),
      active: !!active, stopping: active?.status === "stopping",
      hint: disabled ? "请先保存编辑或等待当前操作完成"
        : readOnly ? "此维护会话可查阅，请新建对话继续"
        : conversation ? "可以为下一条消息切换模型，保留对话上下文"
        : "维护对话使用 Pi CLI，发送前可选择模型",
      newConversation: () => select(""),
      selectConversation: select,
      async send({ prompt, requestId }) {
        const task = await send<Task>(`${base}/tasks`, { prompt, requestId, ...(selected ? { sessionId: selected, modelId: model ?? conversation?.modelId } : choice) });
        select(task.sessionId);
      },
      cancel: active ? async () => {
        await send(`/maintenance/sessions/${encodeURIComponent(active.sessionId)}/tasks/${encodeURIComponent(active.id)}/cancel`);
        history.reload();
      } : undefined,
    };
  },
  providerId: "pi-cli",
  preferenceKey: "orchard-maintenance-agent",
};

export function MaintenanceChat({ className, onClose, ...context }: Context & { className?: string; onClose?: () => void }) {
  return <AgentChat config={config} context={context} resourceKey={`${context.kind}:${context.ownerId}`} className={className} onClose={onClose} />;
}
