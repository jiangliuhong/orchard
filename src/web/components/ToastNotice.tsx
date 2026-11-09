import { CheckCircle2, X } from "lucide-react";
import { Toast } from "radix-ui";
import { createPortal } from "react-dom";

export function ToastNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return <Toast.Provider duration={5000} swipeDirection="right" label="操作提示">
    {message && <Toast.Root key={message} open onOpenChange={open => { if (!open) onDismiss(); }} className="operation-toast">
      <CheckCircle2 size={16} aria-hidden="true" className="operation-toast-icon" />
      <Toast.Description className="operation-toast-message">{message}</Toast.Description>
      <Toast.Close aria-label="关闭操作提示" className="operation-toast-close"><X size={15} aria-hidden="true" /></Toast.Close>
    </Toast.Root>}
    {createPortal(<Toast.Viewport className="operation-toast-viewport" label="操作提示（F8）" />, document.body)}
  </Toast.Provider>;
}
