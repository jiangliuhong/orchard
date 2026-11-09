import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Menu, Plus, Reply, Send, Sparkles, Square, X } from "lucide-react";
import { Popover } from "radix-ui";
import { createPortal } from "react-dom";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { ErrorNotice, Loading } from "../components/common";
import { ProviderPicker } from "../features/ProviderPicker";
import { ConversationDrawer } from "../features/ConversationDrawer";
import type { AgentChatConfig } from "./types";
import { useAgentChat } from "./useAgentChat";
import { ChatHistory } from "./ChatHistory";

export function AgentChat<Context>({ config, context, resourceKey, className = "", onClose }: {
  config: AgentChatConfig<Context>; context: Context; resourceKey: string; className?: string; onClose?: () => void;
}) {
  return <AgentChatContent key={`${config.id}:${resourceKey}`} config={config} context={context} className={className} onClose={onClose} />;
}

function AgentChatContent<Context>({ config, context, className, onClose }: {
  config: AgentChatConfig<Context>; context: Context; className: string; onClose?: () => void;
}) {
  const chat = useAgentChat(config, context), { session } = chat;
  const promptId = useId(), transcript = useRef<HTMLDivElement>(null), atBottom = useRef(true);
  const messageKey = session.messages.map(message => `${message.id}:${message.text}:${message.pending}`).join("|");
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const [selectedQuote, setSelectedQuote] = useState<{ text: string; top: number; left: number } | null>(null);
  const captureSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { setSelectedQuote(null); return; }
    const range = selection.getRangeAt(0);
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
    const body = start?.closest<HTMLElement>(".message-body");
    const text = selection.toString();
    if (!body || !transcript.current?.contains(body) || !body.contains(range.endContainer) || !text.trim()) {
      setSelectedQuote(null); return;
    }
    const rect = range.getClientRects?.()[0] ?? range.getBoundingClientRect?.();
    if (!rect) { setSelectedQuote(null); return; }
    setSelectedQuote({ text, top: Math.max(40, rect.top - 8), left: Math.max(64, Math.min(window.innerWidth - 64, rect.left + rect.width / 2)) });
  };
  useEffect(() => {
    const dismiss = () => setSelectedQuote(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    document.addEventListener("selectionchange", captureSelection);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("selectionchange", captureSelection);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  useEffect(() => { setSelectedQuote(null); }, [session.conversationId]);
  const quoteSelection = () => {
    if (!selectedQuote || chat.locked) return;
    const quote = selectedQuote.text.split(/\r?\n/).map(line => `>${line}`).join("\n");
    chat.setPrompt(current => `${current ? `${current}\n\n` : ""}${quote}\n\n`);
    window.getSelection()?.removeAllRanges();
    setSelectedQuote(null);
    promptInput.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => { atBottom.current = true; }, [session.conversationId]);
  useLayoutEffect(() => {
    const element = transcript.current;
    if (!element) return;
    const follow = () => {
      if (atBottom.current) element.scrollTop = element.scrollHeight;
    };
    follow();
    // Track layout changes too: streaming content and clearing the composer can resize the viewport.
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [messageKey, session.conversationId, session.loading, chat.busy, chat.prompt]);
  const submit = () => {
    if (!chat.canSend) return;
    atBottom.current = true;
    void chat.submit();
  };
  const managementLocked = chat.busy || session.managementLocked;
  return <section className={`chat-panel agent-chat ${className}`} aria-label={config.label}>
    <div className="panel-bar conversation-heading">
      <Button variant="ghost" size="icon" aria-label="历史对话" aria-expanded={chat.historyOpen} onClick={() => chat.setHistoryOpen(value => !value)}><Menu size={16} /></Button>
      <h2 className="conversation-heading-title" title={session.title}>{session.title}</h2>
      <Button variant="ghost" size="sm" disabled={managementLocked} onClick={chat.newConversation}>新对话</Button>
      {onClose && <Button variant="ghost" size="icon" aria-label="关闭 Agent" onClick={onClose}><X size={15} /></Button>}
    </div>
    <ConversationDrawer open={chat.historyOpen} onOpenChange={chat.setHistoryOpen}>
      <ChatHistory key={session.conversationId} session={session} disabled={!!managementLocked} onSelect={chat.selectConversation} perform={chat.perform} onAction={() => chat.setHistoryOpen(false)} />
    </ConversationDrawer>
    <div className="messages agent-chat-messages" ref={transcript} aria-live="polite" onMouseUp={captureSelection} onKeyUp={captureSelection} onScroll={() => {
      const element = transcript.current;
      if (element) atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    }}>
      {session.notice}
      {session.noticeActions?.map(action => <Button key={action.label} variant="outline" size="sm" disabled={managementLocked} onClick={() => void chat.perform(action.run)}>{action.label}</Button>)}
      {session.loading && !session.messages.length ? <Loading /> : !session.messages.length && <div className="chat-welcome"><div className="welcome-icon"><Sparkles size={22} /></div><h2>{config.welcome.title}</h2><p>{config.welcome.description}</p>{config.welcome.hint && <span className="field-hint">{config.welcome.hint}</span>}</div>}
      {session.messages.map(message => <article className={`message message-${message.role}`} key={message.id}><div className="message-heading"><span className="message-role">{message.role === "user" ? "你" : message.role === "error" ? "执行诊断" : message.pending ? "Agent · 生成中" : "Agent"}</span></div><div className="message-body" data-message-id={message.id}>{message.text && <p>{message.text}</p>}{message.content}</div></article>)}
    </div>
    {selectedQuote && createPortal(<Button className="agent-chat-quote-action" variant="outline" size="sm" style={{ top: selectedQuote.top, left: selectedQuote.left }} disabled={chat.locked} onMouseDown={event => event.preventDefault()} onClick={quoteSelection}><Reply size={13} />引用回复</Button>, document.body)}
    <div className="chat-compose">
      <div className="chat-compose-body">
        <ProviderPicker providers={chat.providers} value={chat.choice} enabledOnly disabled={chat.locked} onChange={chat.choose} />
        <label className="sr-only" htmlFor={promptId}>{config.promptLabel}</label>
        <Textarea ref={promptInput} id={promptId} rows={3} value={chat.prompt} disabled={chat.locked} onChange={event => chat.setPrompt(event.target.value)} placeholder={config.placeholder} onKeyDown={event => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submit(); }
        }} />
        {!!chat.attachments.length && <div className="agent-chat-attachments">{chat.attachments.map(attachment => <div className="agent-chat-attachment" key={`${attachment.kind}:${attachment.id}`}><span>{attachment.label}</span><Button variant="ghost" size="icon-xs" disabled={chat.locked} aria-label={`移除引用：${attachment.label}`} onClick={() => chat.removeAttachment(attachment)}><X size={12} /></Button></div>)}</div>}
      </div>
      <div className="compose-footer">
        {chat.attachmentsEnabled && config.attachments && <Popover.Root open={chat.pickerOpen && !chat.locked} onOpenChange={chat.setPickerOpen}><Popover.Trigger asChild><Button variant="ghost" size="icon" disabled={chat.locked} aria-label="添加引用" title="添加引用"><Plus size={16} /></Button></Popover.Trigger><Popover.Portal><Popover.Content className="agent-chat-attachment-popover" side="top" align="start" sideOffset={8} collisionPadding={12} aria-label="添加引用"><h3>添加引用</h3>{config.attachments.renderPicker({ context, selected: chat.attachments, onAdd: chat.addAttachment, onClose: () => chat.setPickerOpen(false) })}</Popover.Content></Popover.Portal></Popover.Root>}
        <span>{session.hint || "⌘ / Ctrl + Enter 发送"}</span>
        {session.active && session.cancel ? <Button variant="outline" disabled={chat.busy || session.stopping} onClick={() => void chat.perform(session.cancel!)}><Square size={13} />{session.stopping ? "正在停止…" : "停止生成"}</Button> : <Button disabled={!chat.canSend} onClick={submit}><Send size={14} />{chat.busy ? "发送中…" : "发送"}</Button>}
      </div>
      <ErrorNotice message={chat.error} />
    </div>
  </section>;
}
