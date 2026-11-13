import { useState } from "react";
import { useLeaveGuard } from "../lib/navigation";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

export function UnsavedChanges({ dirty }: { dirty: boolean }) {
  const [proceed, setProceed] = useState<() => void>();
  useLeaveGuard(dirty, action => setProceed(() => action));
  return <Dialog open={!!proceed} onOpenChange={open => { if (!open) setProceed(undefined); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>有未保存的修改</DialogTitle>
        <DialogDescription>离开此页面会丢失未保存的修改。</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={() => setProceed(undefined)}>取消</Button>
        <Button variant="destructive" onClick={() => { setProceed(undefined); proceed?.(); }}>放弃修改并离开</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
