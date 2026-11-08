import { useState } from "react";
import { Button } from "../components/ui/button";
import { ArchiveConversationButton } from "../features/ArchiveConversationButton";
import type { ChatConversation, ChatSession } from "./types";

export function ChatHistory({ session, disabled, onSelect, perform, onAction }: {
  session: ChatSession;
  disabled: boolean;
  onSelect: (id: string) => void;
  perform: (action: () => Promise<void>) => Promise<void>;
  onAction: () => void;
}) {
  const [renaming, setRenaming] = useState(""), [title, setTitle] = useState("");
  const row = (conversation: ChatConversation) => <article className="conversation-item" key={conversation.id} data-viewed={conversation.id === session.conversationId}>
    {renaming === conversation.id ? <form className="conversation-rename" onSubmit={event => {
      event.preventDefault();
      const action = conversation.actions?.find(item => item.id === "rename");
      if (action && title.trim()) void perform(async () => { await action.run(title.trim()); setRenaming(""); });
    }}><input aria-label="对话标题" value={title} onChange={event => setTitle(event.target.value)} /><Button type="submit" size="xs" disabled={disabled || !title.trim()}>保存标题</Button><Button type="button" variant="ghost" size="xs" onClick={() => setRenaming("")}>取消改名</Button></form>
      : <button className="conversation-item-title" onClick={() => onSelect(conversation.id)}>{conversation.title}</button>}
    {conversation.meta && <span className="conversation-item-meta">{conversation.meta}</span>}
    {conversation.excerpt && <span className="conversation-item-excerpt">{conversation.excerpt}</span>}
    {conversation.notice && <span className="conversation-item-excerpt warning">{conversation.notice}</span>}
    <div className="conversation-item-actions">{conversation.actions?.map(action => action.id === "archive"
      ? <ArchiveConversationButton key={action.id} disabled={disabled || !!action.disabled} label={action.accessibleLabel} onConfirm={() => void perform(() => action.run())} />
      : <Button key={action.id} variant="ghost" size="xs" aria-label={action.accessibleLabel} disabled={disabled || action.disabled} onClick={() => {
        if (action.id === "rename") { setRenaming(conversation.id); setTitle(conversation.title); }
        else void perform(async () => { await action.run(); onAction(); });
      }}>{action.label}</Button>)}</div>
  </article>;
  const visible = session.conversations.filter(item => !item.archived);
  const groups = [...new Set(visible.map(item => item.group ?? ""))];
  const archived = session.conversations.filter(item => item.archived);
  return <div className="conversation-panel" aria-label="历史对话记录">
    {session.historyHint && <span className="conversation-item-excerpt warning">{session.historyHint}</span>}
    {!session.conversations.length && <p className="field-hint">暂无历史对话，首次发送后自动保存。</p>}
    {groups.map(group => <div className="agent-chat-history-group" key={group}>{group && <span className="conversation-group-label">{group}</span>}{visible.filter(item => (item.group ?? "") === group).map(row)}</div>)}
    {!!archived.length && <details className="conversation-archived"><summary>已归档 · {archived.length}</summary>{archived.map(row)}</details>}
  </div>;
}
