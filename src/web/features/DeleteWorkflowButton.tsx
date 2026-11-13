import { navigate } from "../lib/navigation";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { send } from "../lib/api";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { ErrorNotice } from "../components/common";

export function DeleteWorkflowButton({ id, name, kind = "workflow", compact = false, disabled = false, onDeleted }: {
  id: string; name: string; kind?: "workflow" | "draft"; compact?: boolean; disabled?: boolean; onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const label = kind === "draft" ? "删除草稿" : "删除工作流";
  const remove = async () => {
    setBusy(true); setError("");
    try {
      await send(`/${kind === "draft" ? "drafts" : "workflows"}/${id}`, undefined, "DELETE");
      setOpen(false);
      if (onDeleted) onDeleted(); else navigate("/", { skipGuard: true });
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return <><Button variant={compact ? "ghost" : "outline"} className="delete-workflow" size={compact ? "icon" : "default"} aria-label={`${label} ${name}`} title={label} disabled={disabled || busy} onClick={() => { setError(""); setOpen(true); }}><Trash2 size={14} />{!compact && label}</Button><Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent><DialogHeader><DialogTitle>{label}「{name}」？</DialogTitle><DialogDescription>{kind === "draft" ? "此草稿的对话、测试运行结果和日志将一并删除，已发布版本不受影响。" : "此工作流的全部历史版本、关联草稿、对话、运行结果和日志将一并删除。已复制出的独立工作流不受影响。"}此操作无法撤销。有生成、发布、排队或运行中的任务时，请先完成或取消任务。</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}><Trash2 size={14} />{busy ? "正在删除…" : "确认删除"}</Button></DialogFooter></DialogContent></Dialog></>;
}
