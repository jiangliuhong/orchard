import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { ErrorNotice, Loading } from "../components/common";
import { api, pretty, requestId, send } from "../lib/api";
import type { MaintenanceService } from "../../agent/maintenance-service.js";

type Proposal = ReturnType<MaintenanceService["view"]>;
type Receipt = ReturnType<MaintenanceService["receipt"]>;
export interface MaintenanceReviewClient {
  get(id: string): Promise<Proposal>;
  decide(id: string, value: { action: "confirm" | "revoke"; contentHash: string; diffHash: string; requestId: string }): Promise<Proposal>;
  apply(id: string, requestId: string): Promise<Receipt>;
  receipt(id: string): Promise<Receipt>;
}
const client: MaintenanceReviewClient = {
  get: id => api(`/maintenance/proposals/${encodeURIComponent(id)}`),
  decide: (id, value) => send(`/maintenance/proposals/${encodeURIComponent(id)}/decision`, value),
  apply: (id, requestId) => send(`/maintenance/proposals/${encodeURIComponent(id)}/apply`, { requestId }),
  receipt: id => api(`/maintenance/applications/${encodeURIComponent(id)}`),
};
const labels: Record<string, string> = { pending: "等待审阅确认", confirmed: "已确认，等待应用", queued: "已排队，等待维护进程停止",
  applied: "已应用（未自动发布）", applied_projection_pending: "业务已应用，工作区待同步；不要重复创建变更", conflicted: "基线冲突，请重新生成提案",
  revoked: "已撤销，未应用", expired: "已过期，请重新生成提案", rejected: "应用被拒绝，请查看原因" };
function removed(before: Record<string, any>, after: Record<string, any>): string[] {
  if (Array.isArray(before.tools) && Array.isArray(after.tools)) return before.tools.filter((tool: { toolId: string }) => !after.tools.some((next: { toolId: string }) => next.toolId === tool.toolId)).map((tool: { toolId: string }) => tool.toolId);
  const oldFiles = before.files ?? before.definition?.files ?? {}, newFiles = after.files ?? after.definition?.files ?? {};
  return Object.keys(oldFiles).filter(path => !Object.hasOwn(newFiles, path));
}

/** Shared three-scenario review surface. Mounted by the new maintenance chat
 * adapter after runtime cutover, not by the legacy direct-apply adapters. */
export function MaintenanceProposalReview(props: { proposalId: string; client?: MaintenanceReviewClient; onApplied?: () => void }) {
  return <Review key={props.proposalId} {...props} />;
}
function Review({ proposalId, client: transport = client, onApplied }: { proposalId: string; client?: MaintenanceReviewClient; onApplied?: () => void }) {
  const [proposal, setProposal] = useState<Proposal>(), [receipt, setReceipt] = useState<Receipt>();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [open, setOpen] = useState(false), [reviewed, setReviewed] = useState(false);
  const [keys] = useState(() => ({ confirm: requestId(), revoke: requestId(), apply: requestId() }));
  const alive = useRef(true), announced = useRef(false);
  useEffect(() => {
    alive.current = true; let current = true;
    void transport.get(proposalId).then(value => { if (current) setProposal(value); }).catch(error => { if (current) setError(error.message); });
    return () => { current = false; alive.current = false; };
  }, [proposalId, transport]);
  const acceptReceipt = (value: Receipt) => {
    if (!alive.current) return; setReceipt(value);
    if (["applied", "applied_projection_pending"].includes(value.status) && !announced.current) { announced.current = true; onApplied?.(); }
  };
  useEffect(() => {
    if (!receipt || !["queued", "applied_projection_pending"].includes(receipt.status)) return;
    let current = true;
    const timer = setInterval(() => {
      void transport.receipt(receipt.id).then(value => { if (current) acceptReceipt(value); }).catch(error => { if (current) setError(error.message); });
    }, 2000);
    return () => { current = false; clearInterval(timer); };
  }, [receipt?.id, receipt?.status, transport]);
  const perform = async (action: "confirm" | "revoke" | "apply") => {
    if (!proposal || busy || (action === "confirm" && !reviewed)) return;
    const exact = proposal; setBusy(true); setError("");
    try {
      if (action !== "apply") {
        const updated = await transport.decide(exact.id, { action, contentHash: exact.contentHash, diffHash: exact.diffHash, requestId: keys[action] });
        if (!alive.current) return; setProposal(updated); setOpen(false);
      }
      if (action !== "revoke") acceptReceipt(await transport.apply(exact.id, keys.apply));
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : "操作失败，请刷新状态"); }
    finally { if (alive.current) setBusy(false); }
  };
  const refresh = async () => {
    setBusy(true); setError("");
    try {
      const value = await transport.get(proposalId); if (alive.current) setProposal(value);
      if (receipt) acceptReceipt(await transport.receipt(receipt.id));
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : "刷新失败"); }
    finally { if (alive.current) setBusy(false); }
  };
  if (!proposal) return <section aria-label="维护提案审阅"><ErrorNotice message={error} />{!error && <Loading />}</section>;
  const status = ["revoked", "expired"].includes(proposal.state) ? proposal.state : receipt?.status ?? proposal.state;
  const deletions = removed(proposal.diff.before, proposal.diff.after);
  const terminal = ["applied", "applied_projection_pending", "conflicted", "revoked", "expired", "rejected"].includes(status);
  return <section className="agent-chat-change" aria-label="维护提案审阅" style={{ minWidth: 0 }}>
    <div className="panel-bar" style={{ padding: 0, gap: 8, flexWrap: "wrap" }}><strong>变更提案</strong><span role="status">{labels[status] ?? status}</span><Button size="sm" variant="ghost" disabled={busy || open} onClick={() => void refresh()}>刷新状态</Button></div>
    <p style={{ margin: 0, overflowWrap: "anywhere" }}>{proposal.summary}</p>
    <span className="field-hint" style={{ overflowWrap: "anywhere" }}>固定目标：{proposal.target.id} · 基线 {pretty(proposal.baseline)} · 到期 {new Date(proposal.expiresAt).toLocaleString()}</span>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(260px,100%),1fr))", gap: 8, minWidth: 0 }}>
      <label style={{ minWidth: 0 }}>修改前<Textarea aria-label="提案修改前" readOnly value={pretty(proposal.diff.before)} rows={12} style={{ width: "100%", fontFamily: "var(--font-code)", fontSize: 12, maxHeight: 380, overflow: "auto" }} /></label>
      <label style={{ minWidth: 0 }}>修改后<Textarea aria-label="提案修改后" readOnly value={pretty(proposal.diff.after)} rows={12} style={{ width: "100%", fontFamily: "var(--font-code)", fontSize: 12, maxHeight: 380, overflow: "auto" }} /></label>
    </div>
    {!!deletions.length && <p role="note" style={{ overflowWrap: "anywhere" }}>将删除：{deletions.join("、")}。应用后这些文件或工具将不再保留在当前定义中。</p>}
    <details><summary>确切内容标识</summary><code style={{ overflowWrap: "anywhere" }}>{proposal.contentHash}<br />{proposal.diffHash}</code></details>
    <ErrorNotice message={error || receipt?.errorCode || ""} />
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {!terminal && proposal.state === "pending" && <Button size="sm" disabled={busy} onClick={() => { setReviewed(false); setOpen(true); }}>审阅并确认应用</Button>}
      {!terminal && proposal.state === "confirmed" && !receipt && <Button size="sm" disabled={busy} onClick={() => void perform("apply")}>提交应用请求</Button>}
      {!terminal && <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform("revoke")}>撤销提案</Button>}
    </div>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent showCloseButton={!busy} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>确认这份确切变更</DialogTitle><DialogDescription>仅应用当前展示的提案；不会自动发布或执行业务。维护任务仍运行时先排队，进程停止后再应用。取消或 Esc 不会改变提案。</DialogDescription></DialogHeader>
        <p style={{ overflowWrap: "anywhere" }}>目标：{proposal.target.id}{deletions.length > 0 && `；将删除 ${deletions.join("、")}`}</p>
        <label><input type="checkbox" checked={reviewed} disabled={busy} onChange={event => setReviewed(event.target.checked)} /> 我已审阅修改前后内容及删除后果</label>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button disabled={!reviewed || busy} onClick={() => void perform("confirm")}>{busy ? "正在提交…" : "确认并应用"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
