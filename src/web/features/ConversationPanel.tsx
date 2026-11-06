import { useState } from "react";
import { Archive, Check, MessageSquare, Pencil, RotateCcw, Undo2 } from "lucide-react";
import type { AgentChoice, ConversationView } from "../../domain/types.js";
import { Button } from "../components/ui/button";
import { requestId, send } from "../lib/api";

const statusLabels: Record<ConversationView["status"], string> = {
  current: "当前对话", idle: "历史", archived: "已归档", needs_rebuild: "需要重建",
};

export interface ConversationPanelProps {
  draftId: string;
  revision: number;
  conversations: ConversationView[];
  currentId: string | null;
  /** 有活动轮次（queued/running/cancel_requested）时锁定全部管理操作。 */
  locked: boolean;
  busy: string;
  choice: AgentChoice;
  viewedId: string | null;
  onView: (id: string | null) => void;
  /** 与 DraftPage.act 相同：busy 标记、错误处理与刷新。 */
  run: (name: string, action: () => Promise<void>) => Promise<void>;
}

/** 创作区对话选择器：当前 / 历史 / 需要重建 / 已归档（history-feature.md）。 */
export function ConversationPanel({ draftId, revision, conversations, currentId, locked, busy, choice, viewedId, onView, run }: ConversationPanelProps) {
  const [pendingArchive, setPendingArchive] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const disabled = locked || !!busy;
  const command = (name: string, conversationId: string, body?: Record<string, unknown>) =>
    run(name, async () => {
      const view = await send<ConversationView>(`/drafts/${draftId}/conversations/${conversationId}/${name}`, { expectedRevision: revision, requestId: requestId(), ...body });
      if (view.status === "current") onView(view.id);
    });
  const row = (conversation: ConversationView) => {
    const viewed = viewedId === conversation.id;
    return <article className="conversation-item" data-status={conversation.status} data-viewed={viewed} key={conversation.id}>
      {renaming === conversation.id
        ? <div className="conversation-rename">
          <input aria-label="对话标题" value={titleDraft} onChange={event => setTitleDraft(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setRenaming(null); }} />
          <Button size="icon-xs" variant="ghost" aria-label="保存标题" disabled={disabled || !titleDraft.trim()} onClick={() => { void command("rename", conversation.id, { title: titleDraft.trim() }); setRenaming(null); }}><Check size={13} /></Button>
          <Button size="icon-xs" variant="ghost" aria-label="取消改名" disabled={disabled} onClick={() => setRenaming(null)}><Undo2 size={13} /></Button>
        </div>
        : <button className="conversation-item-title" onClick={() => onView(viewed ? null : conversation.id)} title={conversation.title ?? "未命名对话"}>{conversation.title ?? "未命名对话"}</button>}
      <span className="conversation-item-meta">
        {statusLabels[conversation.status]} · {conversation.mode === "multi" ? "多轮" : "单次"} · {conversation.providerId} / {conversation.modelId} · {new Date(conversation.updatedAt).toLocaleString("zh-CN")}
      </span>
      {conversation.lastUserMessage && <span className="conversation-item-excerpt">{conversation.lastUserMessage}</span>}
      {conversation.status === "needs_rebuild" && <span className="conversation-item-excerpt warning">后端上下文已中断，仅可阅读；重建会开启新上下文并保留此对话作诊断历史。</span>}
      {pendingArchive === conversation.id
        ? <div className="conversation-item-actions"><span className="conversation-item-excerpt">确认归档？消息与审计记录保留，对话停止接收新消息。</span>
          <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setPendingArchive(null)}>取消</Button>
          <Button size="xs" variant="destructive" disabled={disabled} onClick={() => { void command("archive", conversation.id); setPendingArchive(null); }}>确认归档</Button></div>
        : <div className="conversation-item-actions">
          {conversation.status === "idle" && <Button size="xs" variant="outline" disabled={disabled} onClick={() => void command("resume", conversation.id)}><MessageSquare size={12} />继续</Button>}
          {conversation.status === "archived" && <Button size="xs" variant="outline" disabled={disabled} onClick={() => void command("restore", conversation.id)}><Undo2 size={12} />恢复</Button>}
          {conversation.status === "needs_rebuild" && <Button size="xs" variant="outline" disabled={disabled} onClick={() => void command("rebuild", conversation.id, { ...choice, mode: conversation.mode })}><RotateCcw size={12} />重建上下文</Button>}
          {(conversation.status === "current" || conversation.status === "idle") && <>
            <Button size="xs" variant="ghost" disabled={disabled} aria-label={`重命名对话 ${conversation.title ?? conversation.id}`} onClick={() => { setRenaming(conversation.id); setTitleDraft(conversation.title ?? ""); }}><Pencil size={12} />改名</Button>
            <Button size="xs" variant="ghost" disabled={disabled} aria-label={`归档对话 ${conversation.title ?? conversation.id}`} onClick={() => setPendingArchive(conversation.id)}><Archive size={12} />归档</Button>
          </>}
        </div>}
    </article>;
  };
  const history = conversations.filter(conversation => conversation.status === "idle");
  const broken = conversations.filter(conversation => conversation.status === "needs_rebuild");
  const archived = conversations.filter(conversation => conversation.status === "archived");
  const current = conversations.find(conversation => conversation.id === currentId);
  if (!conversations.length) return <div className="conversation-panel"><span className="conversation-item-excerpt">首次发送后自动创建对话；历史对话在此列表管理。</span></div>;
  return <div className="conversation-panel">
    {current ? row(current) : <span className="conversation-item-excerpt warning">没有进行中的对话，请新建或继续历史对话。</span>}
    {!!history.length && <><span className="conversation-group-label">历史对话</span>{history.map(row)}</>}
    {!!broken.length && <><span className="conversation-group-label">需要重建</span>{broken.map(row)}</>}
    {!!archived.length && <details className="conversation-archived"><summary>已归档 · {archived.length}</summary>{archived.map(row)}</details>}
  </div>;
}
