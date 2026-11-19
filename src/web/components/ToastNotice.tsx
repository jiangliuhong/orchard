import { AlertCircle, AlertTriangle, Bell, CheckCircle2, X } from "lucide-react";
import { Toast } from "radix-ui";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { serviceUnavailableMessage } from "../lib/api";

const RestoreMessages = createContext<((id: string, reopen?: () => void) => void) | null>(null);
const MessageViewport = createContext<{ node: HTMLOListElement | null; inDialog: boolean } | null>(null);
const OwnsConnectionNotice = createContext(false);
export function ConnectionNoticeOwner({ children }: { children: ReactNode }) {
  return <OwnsConnectionNotice.Provider value>{children}</OwnsConnectionNotice.Provider>;
}

export function MessageLayer({ children, inDialog = false }: { children: ReactNode; inDialog?: boolean }) {
  const [dismissed, setDismissed] = useState<Record<string, () => void>>({});
  const [register] = useState(() => (id: string, reopen?: () => void) => {
    setDismissed(current => {
      if (reopen) return { ...current, [id]: reopen };
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  });
  const viewport = useRef<HTMLOListElement>(null);
  const [viewportNode, setViewportNode] = useState<HTMLOListElement | null>(null);
  useEffect(() => {
    if (!inDialog || !viewportNode) return;
    const dialog = viewportNode.closest("[data-slot=dialog-content]");
    const focusMessages = (event: Event) => {
      if (!(event instanceof window.KeyboardEvent) || event.code !== "F8" || !viewportNode.childElementCount) return;
      event.preventDefault();
      event.stopPropagation();
      viewportNode.focus();
    };
    dialog?.addEventListener("keydown", focusMessages);
    return () => dialog?.removeEventListener("keydown", focusMessages);
  }, [inDialog, viewportNode]);
  const attachViewport = useCallback((node: HTMLOListElement | null) => {
    viewport.current = node;
    setViewportNode(node);
  }, []);
  const hidden = Object.values(dismissed);
  const layer = <div className={`operation-message-layer${inDialog ? " operation-message-layer-dialog" : ""}`}>
    {inDialog ? <ol ref={attachViewport} tabIndex={-1} aria-label="操作提示（F8）" className="operation-toast-viewport" />
      : <Toast.Viewport ref={attachViewport} className="operation-toast-viewport" label="操作提示（F8）" />}
    {hidden.length > 0 && <button type="button" className="operation-message-restore" onClick={() => {
      hidden.forEach(reopen => reopen());
      viewport.current?.focus();
    }}><Bell size={14} aria-hidden="true" />查看已关闭消息（{hidden.length}）</button>}
  </div>;
  return <RestoreMessages.Provider value={register}>
    <Toast.Provider duration={5000} swipeDirection="right" label="操作提示">
      <MessageViewport.Provider value={{ node: viewportNode, inDialog }}>{children}</MessageViewport.Provider>
      {inDialog ? layer : createPortal(layer, document.body)}
    </Toast.Provider>
  </RestoreMessages.Provider>;
}

type MessageProps = {
  message: string;
  tone?: "success" | "warning" | "error";
  details?: readonly string[];
  description?: string;
  action?: { label: string; run: () => void };
  link?: { label: string; href: string };
};

function MessageCard({ message, tone = "success", details, description, action, link, onDismiss }: MessageProps & { onDismiss?: () => void }) {
  const register = useContext(RestoreMessages);
  const viewport = useContext(MessageViewport);
  const useRadixToast = tone === "success" && !viewport?.inDialog;
  const id = useId();
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (open || onDismiss || !register) return;
    register(id, () => setOpen(true));
    return () => register(id);
  }, [id, onDismiss, open, register]);
  const close = () => {
    if (viewport?.node?.contains(document.activeElement)) viewport.node.focus();
    setOpen(false);
    onDismiss?.();
  };
  useEffect(() => {
    if (!viewport?.inDialog || !open || tone !== "success") return;
    const timer = window.setTimeout(() => { setOpen(false); onDismiss?.(); }, 5000);
    return () => window.clearTimeout(timer);
  }, [viewport?.inDialog, onDismiss, open, tone]);
  const Icon = tone === "error" ? AlertCircle : tone === "warning" ? AlertTriangle : CheckCircle2;
  const className = `operation-toast operation-toast-${tone}`;
  const body = <>
    <Icon size={16} aria-hidden="true" className="operation-toast-icon" />
    <div className="operation-toast-message">
      <p role={!useRadixToast ? tone === "error" && !details?.length ? "alert" : "status" : undefined}>{message}</p>
      {description && <p className="operation-toast-description">{description}</p>}
      {!!details?.length && <details className="operation-toast-details">
        <summary>查看详情</summary>
        <ul tabIndex={0} aria-label="消息详情" data-radix-toast-announce-exclude="">{details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>
      </details>}
      {(action || link) && <div className="operation-toast-actions">
        {action && <button type="button" className="operation-message-restore" onClick={action.run}>{action.label}</button>}
        {link && <a className="operation-message-restore" href={link.href}>{link.label}</a>}
      </div>}
    </div>
  </>;
  if (!useRadixToast) return open && viewport?.node ? createPortal(<li className={className}>
    {body}<button type="button" aria-label="关闭操作提示" className="operation-toast-close" onClick={close}><X size={15} aria-hidden="true" /></button>
  </li>, viewport.node) : null;
  return <Toast.Root open={open} type={tone === "success" ? "foreground" : "background"}
    duration={tone === "success" ? 5000 : Infinity} onOpenChange={next => { if (!next) close(); }} className={className}>
    {body}<Toast.Close aria-label="关闭操作提示" className="operation-toast-close"><X size={15} aria-hidden="true" /></Toast.Close>
  </Toast.Root>;
}

function Message(props: MessageProps & { onDismiss?: () => void }) {
  const register = useContext(RestoreMessages);
  if (!props.message) return null;
  const card = <MessageCard key={JSON.stringify([props.tone, props.message, props.details, props.description])} {...props} />;
  return register ? card : <MessageLayer>{card}</MessageLayer>;
}

export function ToastNotice(props: { message: string; onDismiss: () => void }) {
  return <Message {...props} />;
}

export function WorkspaceMessage(props: MessageProps & { tone: "warning" | "error" }) {
  return <Message {...props} />;
}

export function WorkspaceError({ message, title = "操作未完成" }: { message?: string; title?: string }) {
  return <ErrorMessage message={message} title={title} />;
}

export function ErrorMessage({ message, title }: { message?: string; title?: string }) {
  const ownsConnectionNotice = useContext(OwnsConnectionNotice);
  if (!message || (ownsConnectionNotice && message.endsWith(serviceUnavailableMessage))) return null;
  const heading = title ?? (message.length > 160 || message.includes("\n") ? "操作未完成" : undefined);
  return <WorkspaceMessage tone="error" message={heading ?? message} details={heading ? [message] : undefined} />;
}
