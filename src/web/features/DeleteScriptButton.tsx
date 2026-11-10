import { useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { ErrorNotice } from "../components/common";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";

export function DeleteScriptButton({ id, name, disabled, compact = false, onDeleted }: { id: string; name: string; disabled?: boolean; compact?: boolean; onDeleted: () => void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const remove = async () => {
    setBusy(true); setError("");
    try {
      await api(`/scripts/${encodeURIComponent(id)}`, { method: "DELETE" });
      setOpen(false); onDeleted();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <><Button variant={compact ? "ghost" : "outline"} size={compact ? "icon" : "default"} aria-label={`删除脚本 ${name}`} title="删除脚本" disabled={disabled || busy} onClick={() => { setError(""); setOpen(true); }}><Trash2 size={14} />{!compact && "删除脚本"}</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent><DialogHeader><DialogTitle>删除脚本「{name}」？</DialogTitle><DialogDescription>此脚本的全部版本、Agent 对话和测试记录将一并删除，且无法撤销。被工作流或草稿引用时无法删除，可改为归档；有生成、排队或执行中的任务时，请先完成或取消。</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}><Trash2 size={14} />{busy ? "正在删除…" : "确认删除"}</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
