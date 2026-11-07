import { useId, useRef, useState } from "react";
import { Archive } from "lucide-react";
import { Popover } from "radix-ui";
import { Button } from "../components/ui/button";

export function ArchiveConversationButton({ disabled, label, onConfirm }: { disabled: boolean; label?: string; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  const [boundary, setBoundary] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId(), descriptionId = useId();
  return <Popover.Root open={open} onOpenChange={value => { if (value) setBoundary(trigger.current?.closest<HTMLElement>(".conversation-drawer") ?? null); setOpen(value); }}>
    <Popover.Trigger asChild><Button ref={trigger} size="xs" variant="ghost" disabled={disabled} aria-label={label}><Archive size={12} />归档</Button></Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="conversation-archive-popover" data-conversation-archive-confirm side="top" align="center" sideOffset={8} collisionBoundary={boundary} collisionPadding={12} sticky="always" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <h3 id={titleId}>确认归档此对话？</h3>
        <p id={descriptionId}>历史消息保留，归档后无法继续发送消息。</p>
        <div className="conversation-archive-popover-actions">
          <Popover.Close asChild><Button size="xs" variant="ghost">取消</Button></Popover.Close>
          <Button size="xs" variant="destructive" disabled={disabled} onClick={() => { setOpen(false); onConfirm(); }}>确认归档</Button>
        </div>
        <Popover.Arrow className="conversation-archive-popover-arrow" />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
