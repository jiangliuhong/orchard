import { useEffect, useState } from "react";
import type { ScriptAgentService } from "../../authoring/script-agent.js";
import { send, useCommandKey, useResource } from "../lib/api";
import { ErrorNotice, Loading, Payload, Status } from "../components/common";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { ScriptDiff, versionFiles } from "./ScriptVersionPanels";
import type { ScriptDetail } from "./ScriptPages";

type AgentTurn = ReturnType<ScriptAgentService["get"]>;

export function ScriptAgentPreview({ script, turnId, disabled, onApplied, onTestInput }: { script: ScriptDetail; turnId: string; disabled: boolean; onApplied: () => void; onTestInput: (input: unknown) => void }) {
  const resource = useResource<AgentTurn>(`/scripts/${script.id}/agent/turns/${turnId}`);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const commandKey = useCommandKey(), turn = resource.data;
  useEffect(() => {
    if (!turn || !["queued", "running"].includes(turn.status)) return;
    const timer = setTimeout(resource.reload, 750);
    return () => clearTimeout(timer);
  }, [turn]);
  const apply = async () => {
    setBusy(true); setError("");
    try {
      const input = { turnId, expectedRevision: turn!.baseRevision };
      await send(`/scripts/${script.id}/agent/apply`, { ...input, requestId: commandKey(input) });
      setConfirm(false); resource.reload(); onApplied();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  if (!turn) return <><ErrorNotice message={resource.error} /><Loading /></>;
  const stale = script.currentDraftVersionId !== turn.draftVersionId || script.draft?.revision !== turn.baseRevision;
  const hasChanges = !!turn.proposal && (!!turn.proposal.changes.length || !!Object.keys(turn.proposal.metadata).length);
  return <div className="detail-stack"><h3>{hasChanges ? `变更详情 · 修订 ${turn.baseRevision}` : "回复详情"}</h3><Status value={turn.status} /><ErrorNotice message={error || resource.error || turn.error?.message} />
    {turn.proposal && <><p>{turn.proposal.summary}</p>{hasChanges && turn.base && turn.candidate && <ScriptDiff original={versionFiles(turn.base)} modified={versionFiles(turn.candidate)} />}
      {hasChanges && !turn.validation?.valid && <div className="notice warning"><div>提案源码存在校验错误，可应用为待修复草稿。{turn.validation?.diagnostics.map((message, index) => <pre key={index}>{message}</pre>)}</div></div>}
      {Object.hasOwn(turn.proposal, "testInput") && <><label>建议测试输入</label><Payload value={turn.proposal.testInput} /><Button variant="outline" disabled={disabled} onClick={() => onTestInput(turn.proposal!.testInput)}>使用建议测试输入</Button></>}
      {hasChanges && (turn.appliedRevision !== null ? <div className="notice success">已应用为草稿修订 {turn.appliedRevision}。</div> : stale ? <div className="notice warning">草稿已改变，此提案只读保留。请基于当前草稿重新生成。</div> : <Button disabled={disabled || busy} onClick={() => setConfirm(true)}>确认应用变更…</Button>)}
    </>}
    <Dialog open={confirm} onOpenChange={setConfirm}><DialogContent><DialogHeader><DialogTitle>应用脚本 Agent 变更</DialogTitle><DialogDescription>把预览中的 {turn.proposal?.changes.length ?? 0} 项文件变更及元数据修改，以单次修订保存到当前草稿 {turn.baseRevision}。应用后请手动测试并发布。</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>取消</Button><Button disabled={busy || disabled || stale} onClick={() => void apply()}>确认并保存草稿</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
