import { useId, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { send, useCommandKey } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ErrorNotice } from "../components/common";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";

export function DeleteDictionaryButton({ dictionary, compact = false, disabled = false, onDeleted }: {
  dictionary: { id: string; name: string; revision: number; deletedAt?: number | null };
  compact?: boolean; disabled?: boolean; onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [name, setName] = useState("");
  const inFlight = useRef(false), commandKey = useCommandKey(), inputId = useId();
  const permanent = dictionary.deletedAt != null, label = permanent ? "彻底删除" : "删除字典";
  const remove = async () => {
    if (inFlight.current || (permanent && name !== dictionary.name)) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const input = { expectedRevision: dictionary.revision, permanent, ...(permanent ? { confirmationName: name } : {}) };
      await send(`/dictionaries/${encodeURIComponent(dictionary.id)}`, { ...input, requestId: commandKey(input) }, "DELETE");
      setOpen(false); onDeleted();
    } catch (error) { setError((error as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <><Button variant={compact ? "ghost" : "outline"} className="delete-workflow" size={compact ? "icon" : "default"} aria-label={`${label} ${dictionary.name}`} title={label} disabled={disabled || busy}
    onClick={() => { setError(""); setName(""); setOpen(true); }}><Trash2 size={14} />{!compact && label}</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent>
      <DialogHeader><DialogTitle className="pr-5 leading-snug [overflow-wrap:anywhere]">{label}「{dictionary.name}」？</DialogTitle><DialogDescription>{permanent
        ? "将永久删除字典及全部历史版本，无法撤销。存在当前或历史引用、运行或测试绑定时无法删除。外部 Git 历史与备份不会被清除。"
        : "字典将移入“已删除”，不可编辑或新增引用，历史运行不受影响。存在当前工作流、草稿或脚本引用时无法删除。软删除仍占用名称。"}</DialogDescription></DialogHeader>
      {permanent && <><label htmlFor={inputId}>输入完整字典名称确认</label><Input id={inputId} autoComplete="off" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></>}
      <ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
        <Button variant="destructive" disabled={busy || (permanent && name !== dictionary.name)} onClick={() => void remove()}>{busy ? "正在删除…" : permanent ? "确认彻底删除" : "确认删除"}</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  </>;
}
