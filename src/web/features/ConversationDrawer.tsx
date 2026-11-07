import { useRef, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { Button } from "../components/ui/button";

export function ConversationDrawer({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const previousFocus = useRef<HTMLElement | null>(null);
  return <Dialog.Root open={open} onOpenChange={onOpenChange} modal={false}>
    <Dialog.Content className="conversation-drawer" aria-describedby={undefined}
      onInteractOutside={event => { if (event.target instanceof Element && event.target.closest("[data-conversation-archive-confirm]")) event.preventDefault(); }}
      onOpenAutoFocus={() => { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={event => { event.preventDefault(); previousFocus.current?.focus(); }}>
      <div className="conversation-drawer-header">
        <Dialog.Title>历史对话</Dialog.Title>
        <Dialog.Close asChild><Button variant="ghost" size="icon" aria-label="关闭历史对话"><X size={16} /></Button></Dialog.Close>
      </div>
      <div className="conversation-drawer-body">{children}</div>
    </Dialog.Content>
  </Dialog.Root>;
}
