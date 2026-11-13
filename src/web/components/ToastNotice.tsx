import { AlertCircle, AlertTriangle, Bell, CheckCircle2, X } from "lucide-react";
import { Toast } from "radix-ui";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const RestoreMessages = createContext<((id: string, reopen?: () => void) => void) | null>(null);

export function MessageLayer({ children }: { children: ReactNode }) {
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
  const hidden = Object.values(dismissed);
  return <RestoreMessages.Provider value={register}>
    <Toast.Provider duration={5000} swipeDirection="right" label="操作提示">
      {children}
      {createPortal(<div className="operation-message-layer">
        <Toast.Viewport ref={viewport} className="operation-toast-viewport" label="操作提示（F8）" />
        {hidden.length > 0 && <button type="button" className="operation-message-restore" onClick={() => {
          hidden.forEach(reopen => reopen());
          viewport.current?.focus();
        }}><Bell size={14} aria-hidden="true" />查看已关闭消息（{hidden.length}）</button>}
      </div>, document.body)}
    </Toast.Provider>
  </RestoreMessages.Provider>;
}

type MessageProps = {
  message: string;
  tone?: "success" | "warning" | "error";
  details?: readonly string[];
  description?: string;
};

function MessageCard({ message, tone = "success", details, description, onDismiss }: MessageProps & { onDismiss?: () => void }) {
  const register = useContext(RestoreMessages);
  const id = useId();
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (open || onDismiss || !register) return;
    register(id, () => setOpen(true));
    return () => register(id);
  }, [id, onDismiss, open, register]);
  const Icon = tone === "error" ? AlertCircle : tone === "warning" ? AlertTriangle : CheckCircle2;
  return <Toast.Root
    open={open}
    type={tone === "success" ? "foreground" : "background"}
    duration={tone === "success" ? 5000 : Infinity}
    onOpenChange={next => {
      setOpen(next);
      if (!next) onDismiss?.();
    }}
    className={`operation-toast operation-toast-${tone}`}
  >
    <Icon size={16} aria-hidden="true" className="operation-toast-icon" />
    <div className="operation-toast-message">
      <Toast.Description>{message}</Toast.Description>
      {description && <p className="operation-toast-description">{description}</p>}
      {!!details?.length && <details className="operation-toast-details">
        <summary>查看详情</summary>
        <ul tabIndex={0} aria-label="消息详情" data-radix-toast-announce-exclude="">{details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>
      </details>}
    </div>
    <Toast.Close aria-label="关闭操作提示" className="operation-toast-close"><X size={15} aria-hidden="true" /></Toast.Close>
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
  return message ? <WorkspaceMessage tone="error" message={title} details={[message]} /> : null;
}
