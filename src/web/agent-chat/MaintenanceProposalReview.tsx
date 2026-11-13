import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
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
const labels: Record<string, string> = { pending: "待审核", confirmed: "已确认，等待应用", queued: "已排队，等待维护进程停止",
  applied: "已应用 · 未发布", applied_projection_pending: "业务已应用，工作区待同步；不要重复创建变更", conflicted: "基线冲突，请重新生成提案",
  revoked: "已撤销，未应用", expired: "已过期，请重新生成提案", rejected: "应用被拒绝，请查看原因" };
function removed(before: Record<string, any>, after: Record<string, any>): string[] {
  if (Array.isArray(before.tools) && Array.isArray(after.tools)) return before.tools.filter((tool: { toolId: string }) => !after.tools.some((next: { toolId: string }) => next.toolId === tool.toolId)).map((tool: { toolId: string }) => tool.toolId);
  const oldFiles = before.files ?? before.definition?.files ?? {}, newFiles = after.files ?? after.definition?.files ?? {};
  return Object.keys(oldFiles).filter(path => !Object.hasOwn(newFiles, path));
}

const CodeDiffEditor = lazy(() => import("../features/CodeEditor").then(module => ({ default: module.CodeDiffEditor })));

function reviewFiles(snapshot: Record<string, unknown>): Record<string, string> {
  if (snapshot.files) return snapshot.files as Record<string, string>;
  if (snapshot.definition) {
    const { files, ...metadata } = snapshot.definition as { files: Record<string, string> };
    return { ...files, "$metadata.json": pretty(metadata) };
  }
  if (Array.isArray(snapshot.tools)) {
    return Object.fromEntries(snapshot.tools.map(tool => [`${tool.toolId}.json`, pretty(tool)]));
  }
  return { "snapshot.json": pretty(snapshot) };
}

function ProposalDiff({ before, after }: Proposal["diff"]) {
  const { original, modified, paths } = useMemo(() => {
    const original = reviewFiles(before), modified = reviewFiles(after);
    const paths = [...new Set([...Object.keys(original), ...Object.keys(modified)])]
      .filter(path => original[path] !== modified[path]).sort();
    return { original, modified, paths };
  }, [before, after]);
  const [selected, setSelected] = useState("");
  const selectId = useId();
  const path = paths.includes(selected) ? selected : paths.includes("workflow.json") ? "workflow.json" : paths[0];
  if (!path) return <p className="field-hint">内容没有差异。</p>;
  const action = (file: string) => !Object.hasOwn(original, file) ? "新增" : !Object.hasOwn(modified, file) ? "删除" : "修改";
  return <>
    <div className="maintenance-review-file">
      {paths.length > 1 ? <><label htmlFor={selectId}>变更文件（{paths.length}）</label>
        <select id={selectId} value={path} onChange={event => setSelected(event.target.value)}>
          {paths.map(file => <option key={file} value={file}>{action(file)} · {file}</option>)}
        </select></> : <span>{action(path)} · {path}</span>}
    </div>
    <div className="maintenance-review-diff">
      <Suspense fallback={<Loading />}><CodeDiffEditor path={path} original={original[path] ?? ""} modified={modified[path] ?? ""} compact /></Suspense>
    </div>
  </>;
}

export function MaintenanceProposalReview(props: { proposalId: string; client?: MaintenanceReviewClient; disabled?: boolean; onApplied?: () => void }) {
  return <Review key={props.proposalId} {...props} />;
}
function Review({ proposalId, client: transport = client, disabled, onApplied }: { proposalId: string; client?: MaintenanceReviewClient; disabled?: boolean; onApplied?: () => void }) {
  const [proposal, setProposal] = useState<Proposal>(), [receipt, setReceipt] = useState<Receipt>();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [open, setOpen] = useState(false), [reviewed, setReviewed] = useState(false);
  const [technical, setTechnical] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [visited, setVisited] = useState(false);
  const [keys] = useState(() => ({ confirm: requestId(), revoke: requestId(), apply: requestId() }));
  const alive = useRef(true), announced = useRef(false);
  useEffect(() => {
    if (!visited) return;
    alive.current = true; let current = true;
    void transport.get(proposalId).then(value => { if (current) setProposal(value); }).catch(error => { if (current) setError(error.message); });
    return () => { current = false; alive.current = false; };
  }, [proposalId, transport, visited]);
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
    if (!proposal || busy || disabled || (action === "confirm" && !reviewed)) return;
    const exact = proposal; setBusy(true); setError("");
    try {
      if (action !== "apply") {
        const updated = await transport.decide(exact.id, { action, contentHash: exact.contentHash, diffHash: exact.diffHash, requestId: keys[action] });
        if (!alive.current) return; setProposal(updated); setRejecting(false);
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
  const status = proposal && (["revoked", "expired"].includes(proposal.state) ? proposal.state : receipt?.status ?? proposal.state);
  const deletions = proposal ? removed(proposal.diff.before, proposal.diff.after) : [];
  const terminal = !!status && ["applied", "applied_projection_pending", "conflicted", "revoked", "expired", "rejected"].includes(status);
  const awaitingReview = status === "pending";
  const canApply = status === "confirmed";
  const setDialogOpen = (value: boolean) => {
    if (busy) return;
    if (value) {
      setVisited(true);
      setReviewed(false);
      setRejecting(false);
      setTechnical(false);
      if (visited) void refresh();
    }
    setOpen(value);
  };

  return <Dialog open={open} onOpenChange={setDialogOpen}>
    <DialogTrigger asChild><Button variant="outline" size="sm">审阅维护提案</Button></DialogTrigger>
    <DialogContent className="maintenance-review" showCloseButton={!busy}>
      <DialogHeader>
        <div className="maintenance-review-heading">
          <DialogTitle>审阅维护提案</DialogTitle>
          {status && <span role="status" data-state={status}>{status === "applied" && proposal?.target.kind === "browser_application" ? "已应用" : labels[status] ?? status}</span>}
        </div>
        <DialogDescription className="sr-only">查看 Agent 提案中的变更并决定是否应用。</DialogDescription>
      </DialogHeader>
      {proposal ? <>
        <div className="maintenance-review-overview">
          <p>{proposal.summary}</p>
          {!!deletions.length && <p role="note">应用后将删除 {deletions.join("、")}。</p>}
          <ErrorNotice message={error || receipt?.errorCode || ""} />
        </div>
        <div className="maintenance-review-body">
          {technical ? <div className="maintenance-review-technical" tabIndex={0} aria-label="提案技术详情">
            <dl>
              <dt>目标</dt><dd><code>{proposal.target.id}</code></dd>
              <dt>到期时间</dt><dd>{new Date(proposal.expiresAt).toLocaleString("zh-CN")}</dd>
              <dt>内容哈希</dt><dd><code>{proposal.contentHash}</code></dd>
              <dt>差异哈希</dt><dd><code>{proposal.diffHash}</code></dd>
            </dl>
            <h3>基线</h3><pre>{pretty(proposal.baseline)}</pre>
            <h3>修改前</h3><pre aria-label="提案修改前">{pretty(proposal.diff.before)}</pre>
            <h3>修改后</h3><pre aria-label="提案修改后">{pretty(proposal.diff.after)}</pre>
          </div> : <ProposalDiff {...proposal.diff} />}
        </div>
      </> : <div className="maintenance-review-overview"><ErrorNotice message={error} />{!error && <Loading />}</div>}
      <DialogFooter className="maintenance-review-footer">
        {proposal && <Button size="sm" variant="ghost" onClick={() => setTechnical(value => !value)} aria-pressed={technical}>{technical ? "返回差异" : "技术详情"}</Button>}
        <div className="maintenance-review-actions">
          {(!proposal && error || status === "queued" || status === "applied_projection_pending" || canApply) &&
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>刷新状态</Button>}
          {rejecting ? <>
            <span className="field-hint">拒绝后，此提案将无法应用。</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(false)}>取消</Button>
            <Button size="sm" variant="destructive" disabled={busy || disabled || terminal} onClick={() => void perform("revoke")}>确认拒绝</Button>
          </> : <>
            {proposal && !terminal && <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => setRejecting(true)}>拒绝</Button>}
            {awaitingReview && <>
              <label className="maintenance-review-confirm"><input type="checkbox" checked={reviewed} disabled={busy || disabled} onChange={event => setReviewed(event.target.checked)} />已核对变更</label>
              <Button size="sm" disabled={!reviewed || busy || disabled} onClick={() => void perform("confirm")}>{busy ? "正在提交…" : "确认并应用"}</Button>
            </>}
            {canApply && <Button size="sm" disabled={busy || disabled} onClick={() => void perform("apply")}>提交应用请求</Button>}
            {(terminal || !proposal) && <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialogOpen(false)}>关闭</Button>}
          </>}
        </div>
        {(awaitingReview || canApply) && !rejecting && <p className="field-hint maintenance-review-effect">{disabled ? "请先保存编辑或等待当前操作完成。" : proposal?.target.kind === "browser_application" ? "应用到当前浏览器应用配置。" : "应用到当前草稿，发布需另行操作。"}</p>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
