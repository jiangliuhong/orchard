import { useEffect, useRef, useState } from "react";
import type { AgentChoice, ConversationView, Draft, Message, SourceFiles, Turn } from "../../../domain/types.js";
import { requestId, send, useStream } from "../../lib/api";
import type { AgentChatConfig, ChatConversation, ChatMessage, ChatSession } from "../types";

export interface WorkflowChatDraft extends Draft {
  files: SourceFiles;
  messages: Message[];
  turns: Turn[];
  conversations: ConversationView[];
  currentConversation: string | null;
}

export interface WorkflowChatContext {
  draft: WorkflowChatDraft;
  dirty: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  reload: () => void;
  onOpenFile: (path: string) => void;
}

function useWorkflowSession(context: WorkflowChatContext, choice: AgentChoice, choose: (choice: AgentChoice) => void): ChatSession {
  const { draft, dirty, busy, reload, onOpenFile } = context;
  const records = draft.conversations ?? [];
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [newId, setNewId] = useState<string | null>(requestId);
  const [draftKey, setDraftKey] = useState<string>(requestId);
  const [stream, setStream] = useState({ turnId: "", text: "" });
  const [newMode, setNewMode] = useState<"single" | "multi">("multi");
  const createdConversation = useRef<ConversationView | undefined>(undefined);
  const activeTurn = draft.turns.find(turn => ["queued", "running", "cancel_requested"].includes(turn.status));
  const delta = stream.turnId === activeTurn?.id ? stream.text : "";
  useStream("turns", activeTurn?.id, event => {
    if (event.type === "provider.text" && activeTurn) setStream(current => ({ turnId: activeTurn.id, text: (current.turnId === activeTurn.id ? current.text : "") + (event.payload as { text: string }).text }));
    if (/turn\.(succeeded|failed|cancelled|interrupted)/.test(event.type)) { setStream({ turnId: "", text: "" }); reload(); }
  });
  useEffect(() => {
    if (!activeTurn) { setStream({ turnId: "", text: "" }); return; }
    const timer = setInterval(reload, 1500);
    return () => clearInterval(timer);
  }, [activeTurn?.id]);
  const activeView = viewedId ?? draft.currentConversation ?? null;
  const conversation = records.find(item => item.id === activeView);
  const visibleMessages = newId ? [] : draft.messages.filter(message => (message.conversationId ?? null) === activeView);
  const selectConversation = (id: string) => {
    const selectedId = !newId && viewedId === id ? draft.currentConversation : id;
    setDraftKey(requestId());
    setViewedId(selectedId); setNewId(null); createdConversation.current = undefined;
    const target = records.find(item => item.id === selectedId);
    if (target) choose({ providerId: target.providerId, modelId: target.modelId });
  };
  const command = async (name: string, target: ConversationView, title?: string) => {
    context.setBusy(true);
    try {
      const result = await send<ConversationView>(`/drafts/${draft.id}/conversations/${target.id}/${name}`, {
        expectedRevision: draft.revision, requestId: requestId(),
        ...(name === "rename" ? { title } : {}),
        ...(name === "rebuild" ? { ...choice, mode: target.mode } : {}),
      });
      if (["resume", "restore", "rebuild"].includes(name) || result.status === "current") {
        if (["resume", "restore"].includes(name)) setDraftKey(requestId());
        setViewedId(name === "rebuild" ? null : target.id); setNewId(null);
        choose({ providerId: result.providerId ?? target.providerId, modelId: result.modelId ?? target.modelId });
      }
    } finally { context.setBusy(false); reload(); }
  };
  const statusLabels: Record<ConversationView["status"], string> = { current: "当前对话", idle: "历史", archived: "已归档", needs_rebuild: "需要重建" };
  const conversations: ChatConversation[] = records.map(item => ({
    id: item.id, title: item.title || "未命名对话",
    meta: `${statusLabels[item.status]} · ${item.mode === "multi" ? "多轮" : "单次"} · ${item.providerId} / ${item.modelId} · ${new Date(item.updatedAt).toLocaleString("zh-CN")}`,
    excerpt: item.lastUserMessage ?? undefined,
    group: item.status === "idle" ? "历史对话" : item.status === "needs_rebuild" ? "需要重建" : undefined,
    archived: item.status === "archived",
    notice: item.status === "needs_rebuild" ? "后端上下文已中断，仅可阅读；重建会开启新上下文并保留此对话作诊断历史。" : undefined,
    actions: [
      ...(item.status === "current" ? [{ id: "continue", label: "继续对话", run: async () => selectConversation(item.id) }] : []),
      ...(item.status === "idle" ? [{ id: "resume", label: "继续", run: async () => command("resume", item) }] : []),
      ...(item.status === "archived" ? [{ id: "restore", label: "恢复", run: async () => command("restore", item) }] : []),
      ...(item.status === "needs_rebuild" ? [{ id: "rebuild", label: "重建上下文", run: async () => command("rebuild", item) }] : []),
      ...(["current", "idle"].includes(item.status) ? [
        { id: "rename", label: "改名", accessibleLabel: `重命名对话 ${item.title ?? item.id}`, run: async (title?: string) => command("rename", item, title) },
        { id: "archive", label: "归档", accessibleLabel: `归档对话 ${item.title ?? item.id}`, run: async () => command("archive", item) },
      ] : []),
    ],
  }));
  const messages: ChatMessage[] = visibleMessages.map(message => {
    const content = message.content;
    const text = typeof content === "object" && content ? String((content as { text?: string; message?: string }).text ?? (content as { message?: string }).message ?? "") : String(content);
    const files = content && typeof content === "object" && "files" in content && Array.isArray(content.files) ? content.files as string[] : [];
    return {
      id: message.id, role: message.role === "user" ? "user" : message.role === "error" ? "error" : "assistant", text,
      content: !!files.length && <div className="agent-chat-change"><span className="field-hint">已更新草稿</span><div className="changed-files">{files.map(path => <button key={path} onClick={() => onOpenFile(path)}>{path}</button>)}</div></div>,
    };
  });
  if (activeTurn && !newId && (activeTurn.conversationId ?? null) === activeView) messages.push({ id: `${activeTurn.id}:pending`, role: "assistant", text: delta || "正在分析流程与上下文…", pending: true });
  const broken = records.filter(item => item.status === "needs_rebuild").at(-1);
  return {
    conversationId: newId ?? activeView ?? `${draft.id}:legacy`, draftKey,
    title: newId ? "新对话" : conversation?.title?.trim() || messages.find(message => message.role === "user")?.text.trim() || "新对话",
    conversations, messages, active: !!activeTurn, stopping: activeTurn?.status === "cancel_requested",
    locked: dirty || busy || draft.status !== "draft" || (!newId && (!!records.length && (!draft.currentConversation || activeView !== draft.currentConversation))),
    managementLocked: busy || !!activeTurn || draft.status !== "draft",
    connectionState: !newId ? conversation?.connectionState : undefined,
    mode: { value: newId ? newMode : conversation?.mode ?? newMode, disabled: dirty || busy || !!activeTurn || draft.status !== "draft", change: mode => { setNewMode(mode); setNewId(requestId()); createdConversation.current = undefined; } },
    hint: dirty ? "先保存修改，再继续对话" : "工作流仅在手动运行时执行",
    historyHint: records.length && !draft.currentConversation ? "没有进行中的对话，请新建或继续历史对话。" : undefined,
    notice: broken && !draft.currentConversation ? <div className="notice warning">对话「{broken.title ?? "未命名对话"}」的后端上下文已中断，仅可阅读；重建会开启新上下文并保留原对话作诊断历史。</div> : undefined,
    noticeActions: broken && !draft.currentConversation ? [{ label: "重建上下文", run: async () => command("rebuild", broken) }] : undefined,
    newConversation: () => { setNewId(requestId()); setDraftKey(requestId()); setViewedId(null); createdConversation.current = undefined; },
    selectConversation,
    send: async submission => {
      context.setBusy(true);
      try {
        let target = conversation;
        if (newId) {
          target = createdConversation.current ?? await send<ConversationView>(`/drafts/${draft.id}/conversations`, {
            ...choice, mode: newMode, expectedRevision: draft.revision, requestId: `${submission.requestId}:conversation`,
          });
          createdConversation.current = target;
        }
        await send(`/drafts/${draft.id}/turns`, {
          ...choice, conversationId: target?.id, mode: target?.mode ?? "multi",
          prompt: submission.prompt, expectedRevision: draft.revision, requestId: submission.requestId,
        });
        setViewedId(target?.id ?? null); setNewId(null); createdConversation.current = undefined;
      } finally { context.setBusy(false); reload(); }
    },
    cancel: activeTurn ? async () => { await send(`/drafts/${draft.id}/turns/${activeTurn.id}/cancel`); reload(); } : undefined,
  };
}

export const workflowChatConfig: AgentChatConfig<WorkflowChatContext> = {
  id: "workflow", label: "工作流 Agent 对话", promptLabel: "描述工作流需求",
  placeholder: "描述需求，或继续修改流程…",
  welcome: { title: "描述你想自动完成的工作", description: "例如：读取一份数据，用 Agent 分析是否需要处理，再按判断执行脚本。", hint: "生成过程不会执行业务脚本。" },
  useSession: useWorkflowSession,
};
