import { useCallback, useEffect, useRef, useState } from "react";
import { ToastNotice } from "../components/ToastNotice";
import { RefreshCw, Sparkles } from "lucide-react";
import { api, pretty, requestId, send, useResource } from "../lib/api";
import { ConfigGitMessageAgentSettings, type MessageAgentSetting } from "./ConfigGitMessageAgentSettings";
import { useTheme, type Theme } from "../lib/theme";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { ErrorNotice, Loading } from "../components/common";

/** API_NOTES: Requests use remoteUrl/branch/configDir/identity; commit-preview uses
 * message,push,regenerate,theme,clientId,preferenceRevision; commit uses token plus
 * theme/clientId/preferenceRevision. restore-preview uses source,categories,mappings,
 * clientId,preferenceRevision; restore uses token. All writes carry requestId.
 * Repository status/history and commit/restore previews accept raw service shapes
 * via adapters below. History query uses source,startSha,offset. Optional normalized
 * diffs support GET previews/:token/diffs?cursor=. Async endpoints return 202
 * {operationId,statusUrl,phase}; operations/:id returns phase/result/error.
 * General pending GET ?clientId returns {items} with raw revision or preferenceRevision.
 * Claim POST {clientId,preferenceRevision,requestId} creates explicit pending snapshot.
 * Ack POST {clientId,operationId,decision,preferenceRevision,force,requestId} uses
 * the PRE-APPLICATION revision, persisted with decision/force for retries.
 * Parent mounts ConfigGitGeneralDelivery globally inside ThemeProvider.
 */
export const API_NOTES = "Raw repository responses are adapted locally; general delivery uses authoritative ThemeProvider state.";
export type Category = "general" | "providers" | "webBridge" | "workflows" | "scripts";
const categories: Record<Category, string> = { general: "常规", providers: "Provider", webBridge: "Web Bridge", workflows: "工作流", scripts: "脚本" };
export interface Binding { id: string; remoteUrl: string; branch: string; configDir: string; remote?: string; snapshotState?: "empty" | "missing" | "valid" | "invalid" | "unsupported" }
export interface RemoteCheck { branches: string[]; defaultBranch?: string; identity?: { name?: string; email?: string } }
export interface RepositoryStatus { localSha?: string; remoteSha?: string; ahead: number; behind: number; diverged: boolean; dirtyPaths: string[]; pendingCommits?: string[]; operationId?: string; remoteObservedAt?: string; message?: string }
export interface Diff { category: Category; objectId?: string; versionId?: string; path: string; changeType: string; detail?: string; before?: unknown; after?: unknown; sensitive?: boolean; blockingReason?: string }
export interface Preview { token: string; expiresAt: number; categories: Category[]; diffs: Diff[]; blockers: string[]; requiredMappings: { key: string; label: string }[]; nextCursor?: string; cumulativeDiffs?: Diff[]; sourceSha?: string; warnings?: string[]; noChanges?: boolean }
export interface History { items: { sha: string; message: string; author: string; date: string; categories?: Category[]; compatible?: boolean }[]; startSha: string; nextCursor?: string }
export interface RecoveryPoint { id: string; createdAt: string | number; sourceSha?: string; protected: boolean }
export interface PendingPreference { clientId: string; operationId: string; preferenceRevision: number; theme: Theme; requiresConfirmation?: boolean }
export interface Result { message?: string; sha?: string; committed?: boolean; pushed?: boolean; remoteUnknown?: boolean; remoteState?: string; pushError?: string; reconnect?: string[] }
export interface Operation { operationId: string; phase: string; result?: unknown; error?: string | { code: string; message: string } }
type Accepted = { operationId: string; statusUrl: string };
type Source = { kind: "git"; sha: string } | { kind: "recovery-point"; id: string };
const root = "/config-git";
const errorText = (e: unknown) => e instanceof Error ? `${"code" in e ? `${String(e.code)}: ` : ""}${e.message}` : String(e);

type RawFileDiff = { path: string; before: string | null; after: string | null };
function fileDiff(diff: RawFileDiff): Diff {
  const category: Category = diff.path.includes("providers/") ? "providers" : diff.path.includes("web-bridge") ? "webBridge" : diff.path.startsWith("workflows/") ? "workflows" : diff.path.startsWith("scripts/") ? "scripts" : "general";
  return { ...diff, category, changeType: diff.before === null ? "add" : diff.after === null ? "delete" : "update" };
}
export function adaptPreview(value: unknown): Preview {
  const raw = value as Partial<Preview> & { diff?: RawFileDiff[]; cumulativeDiff?: RawFileDiff[]; changes?: { category: Category; objectId: string; changeType: string; detail?: string }[]; source?: Source };
  if (!raw.token || raw.expiresAt === undefined) throw new Error("预览响应缺少 token 或 expiresAt");
  const diffs = raw.diffs ?? raw.diff?.map(fileDiff) ?? raw.changes?.map(change => ({ ...change, path: change.objectId })) ?? [];
  return { ...raw, token: raw.token, expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : Date.parse(String(raw.expiresAt)), categories: raw.categories ?? Object.keys(categories) as Category[], diffs,
    cumulativeDiffs: raw.cumulativeDiffs ?? raw.cumulativeDiff?.map(fileDiff), blockers: raw.blockers ?? [], requiredMappings: raw.requiredMappings ?? [], sourceSha: raw.source?.kind === "git" ? raw.source.sha : raw.sourceSha,
    noChanges: raw.noChanges ?? (raw.changes ? raw.changes.every(c => c.changeType === "same") : undefined) };
}
function adaptStatus(raw: RepositoryStatus & { head?: string; dirty?: boolean; dirtyReason?: string }): RepositoryStatus {
  return { ...raw, localSha: raw.localSha ?? raw.head, dirtyPaths: raw.dirtyPaths ?? (raw.dirty ? [raw.dirtyReason ?? "工作区不干净"] : []) };
}
const operationError = (error: Operation["error"]) => typeof error === "string" ? error : error ? `${error.code}: ${error.message}` : "操作未完成";

/** Parent mounts this once at application level, inside ThemeProvider. */
export function ConfigGitGeneralDelivery() {
  const theme = useTheme();
  const latest = useRef(theme); latest.current = theme;
  const [pending, setPending] = useState<PendingPreference>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const acknowledge = async (item: PendingPreference, decision: "apply" | "keep", force: boolean) => {
    const current = latest.current.getPreference();
    if (item.clientId !== current.clientId) throw new Error("偏好记录不属于当前浏览器");
    if (!force && !current.consumed[item.operationId] && current.preferenceRevision !== item.preferenceRevision) { setPending(item); return; }
    const receipt = latest.current.consumePreference(item.operationId, decision, item.theme, force);
    await send(`${root}/general/ack`, { clientId: current.clientId, operationId: item.operationId, decision: receipt.decision, preferenceRevision: receipt.revision, force: receipt.force, requestId: `${current.clientId}:${item.operationId}:ack` });
    localStorage.removeItem(`orchard-general-claim:${item.operationId}`);
    setPending(old => old?.operationId === item.operationId ? undefined : old);
  };
  const ackRef = useRef(acknowledge); ackRef.current = acknowledge;
  const claiming = useRef(false);
  useEffect(() => {
    const claim = () => {
      if (claiming.current) return;
      claiming.current = true; setBusy(true);
      const current = latest.current.getPreference();
      void send<PendingPreference & { revision: number }>(`${root}/general/claim`, { clientId: current.clientId, preferenceRevision: current.preferenceRevision, requestId: requestId() }).then(raw => {
        localStorage.setItem(`orchard-general-claim:${raw.operationId}`, "pending");
        setPending({ ...raw, preferenceRevision: raw.preferenceRevision ?? raw.revision, requiresConfirmation: true });
      }).catch(e => setError(errorText(e))).finally(() => { claiming.current = false; setBusy(false); });
    };
    window.addEventListener("orchard:claim-general", claim);
    return () => window.removeEventListener("orchard:claim-general", claim);
  }, []);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (claiming.current) return;
        const current = latest.current.getPreference();
        const response = await api<{ items: (PendingPreference & { revision?: number })[] } | (PendingPreference & { revision?: number })[]>(`${root}/general/pending?clientId=${encodeURIComponent(current.clientId)}`);
        if (disposed) return;
        if (claiming.current) return;
        for (const raw of Array.isArray(response) ? response : response.items) {
          if (raw.clientId !== current.clientId) continue;
          const item = { ...raw, preferenceRevision: raw.preferenceRevision ?? raw.revision ?? -1 };
          const now = latest.current.getPreference();
          const receipt = now.consumed[item.operationId];
          if (receipt) await ackRef.current(item, receipt.decision, receipt.force);
          else if (item.requiresConfirmation || localStorage.getItem(`orchard-general-claim:${item.operationId}`) || now.preferenceRevision !== item.preferenceRevision) { setPending(item); break; }
          else await ackRef.current(item, "apply", false);
        }
        setError("");
      } catch (e) { if (!disposed) setError(errorText(e)); }
      finally { if (!disposed) timer = setTimeout(() => void poll(), 5000); }
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, []);
  const choose = async (decision: "apply" | "keep") => {
    if (!pending) return;
    setBusy(true);
    try { await acknowledge(pending, decision, true); setError(""); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <>
    {error && <ErrorNotice message={`Git 外观交付：${error}`} />}
    <Dialog open={!!pending} onOpenChange={() => {}}><DialogContent showCloseButton={false}><DialogHeader><DialogTitle>确认恢复浏览器外观</DialogTitle><DialogDescription>外观已在恢复期间改变，或当前记录来自主动领取的快照。恢复值为 {pending?.theme}。</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => void choose("keep")}>保留当前外观</Button><Button disabled={busy} onClick={() => void choose("apply")}>应用恢复外观</Button></DialogFooter></DialogContent></Dialog>
  </>;
}

export function ConfigGitSettings({ sync = false }: { sync?: boolean }) {
  const themeState = useTheme();
  const preferenceRef = useRef(themeState); preferenceRef.current = themeState;
  const [binding, setBinding] = useState<Binding | null>();
  const [status, setStatus] = useState<RepositoryStatus>();
  const [remoteUrl, setRemoteUrl] = useState("");
  const [checked, setChecked] = useState<RemoteCheck>();
  const [branch, setBranch] = useState("main"), [configDir, setConfigDir] = useState("orchard-config");
  const [name, setName] = useState(""), [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [operation, setOperation] = useState<Operation>();
  const [preview, setPreview] = useState<Preview>();
  const [message, setMessage] = useState("备份配置");
  const messageAgent = useResource<MessageAgentSetting>(`${root}/message-agent`);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; action: () => Promise<void> }>();
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const retry = useRef<{ payload: string; id: string } | undefined>(undefined);
  const operationHandler = useRef<((result: unknown) => void) | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reload = useCallback(async () => {
    const results = await Promise.allSettled([
      api<{ binding: Binding | null }>(`${root}/repository`), api<RepositoryStatus>(`${root}/status`),
    ]);
    if (!mounted.current) return;
    const [repository, state] = results;
    if (repository.status === "fulfilled") setBinding(repository.value.binding);
    if (state.status === "fulfilled") { setStatus(adaptStatus(state.value)); if (state.value.operationId) setOperation(old => old?.operationId === state.value.operationId ? old : { operationId: state.value.operationId!, phase: "accepted" }); }
    const failed = results.find(r => r.status === "rejected");
    if (failed?.status === "rejected") setError(errorText(failed.reason));
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const run = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (e) { setError(errorText(e)); if ((e as { code?: string }).code === "PREVIEW_EXPIRED") setPreview(undefined); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const report = (value: unknown) => {
    const result = value as Result | undefined;
    setNotice([result?.message ?? "操作完成", result?.committed ? `本地已提交 ${result.sha ?? ""}` : result?.sha, result?.pushed ? "远程已推送" : "", result?.remoteUnknown || result?.remoteState === "unknown" ? "远端状态待确认，请重新生成预览后重试备份" : "", result?.pushError, result?.reconnect?.length ? `需要重新连接：${result.reconnect.join("、")}` : ""].filter(Boolean).join(" · "));
    if (result?.pushError || result?.remoteUnknown || result?.remoteState === "unknown") setError(`备份尚未完成：${result.pushError ?? "远端状态待确认"}。本地提交已保留，请重新生成预览后重试备份。`);
    setPreview(undefined); void reload();
  };
  const mutate = async (path: string, payload: Record<string, unknown>, done: (value: unknown) => void = report, method = "POST") => {
    const serialized = JSON.stringify({ path, payload, method });
    if (retry.current?.payload !== serialized) retry.current = { payload: serialized, id: requestId() };
    const response = await send<unknown>(`${root}${path}`, { ...payload, requestId: retry.current.id }, method);
    retry.current = undefined;
    if (response && typeof response === "object" && "operationId" in response && "statusUrl" in response) {
      const accepted = response as Accepted;
      operationHandler.current = done;
      localStorage.setItem("orchard-config-git-operation", accepted.operationId);
      setOperation({ operationId: accepted.operationId, phase: "accepted" });
    } else done(response);
  };
  useEffect(() => {
    const id = localStorage.getItem("orchard-config-git-operation");
    if (id) setOperation({ operationId: id, phase: "accepted" });
  }, []);
  const activeOperation = operation && !["completed", "failed", "interrupted", "recovery_required"].includes(operation.phase);
  useEffect(() => {
    if (!operation || !activeOperation) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Operation>(`${root}/operations/${encodeURIComponent(operation.operationId)}`);
        if (disposed) return;
        setOperation(next);
        if (next.phase === "completed") {
          localStorage.removeItem("orchard-config-git-operation");
          const handler = operationHandler.current; operationHandler.current = undefined;
          if (handler) handler(next.result); else report(next.result);
          return;
        }
        if (next.phase === "interrupted") {
          operationHandler.current = undefined;
          setPreview(undefined);
          setError("服务已重启，操作结果尚未确认。请核对仓库状态，再重新生成预览。");
          void reload();
          return;
        }
        if (["failed", "recovery_required"].includes(next.phase)) { setError(`${next.phase}: ${operationError(next.error)}`); return; }
      } catch (e) { if (!disposed) setError(`操作状态查询失败，将继续重试：${errorText(e)}`); }
      if (!disposed) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [operation?.operationId, !!activeOperation]);
  const locked = busy || !!activeOperation || operation?.phase === "recovery_required";
  const general = () => {
    const { theme, clientId, preferenceRevision } = preferenceRef.current.getPreference();
    if (!clientId || !Number.isSafeInteger(preferenceRevision)) throw new Error("全局浏览器偏好尚未就绪，请刷新后重试");
    return { theme, clientId, preferenceRevision };
  };
  const showPreview = (value: unknown) => { setPreview(adaptPreview(value)); setConfirmed(false); };
  const previewInitialized = useRef(false);
  const createPreview = () => run(async () => {
    setPreview(undefined);
    await mutate("/commit-preview", { message: message.trim(), push: true, ...general() }, showPreview);
  });
  useEffect(() => {
    if (sync && binding && !previewInitialized.current && !operation && !inFlight.current) {
      previewInitialized.current = true;
      if (binding.snapshotState !== "invalid" && binding.snapshotState !== "unsupported") void createPreview();
    }
  }, [sync, binding?.id]);
  const invalidate = () => { setPreview(undefined); setConfirmed(false); };
  const cannotConfirm = !preview || !confirmed || !!preview.nextCursor || preview.noChanges || preview.blockers.length > 0 || preview.diffs.some(d => d.blockingReason) || preview.expiresAt <= Date.now();
  const snapshotBlocked = binding?.snapshotState === "invalid" || binding?.snapshotState === "unsupported";
  return <section className={`config-git-settings${sync ? " config-git-sync" : ""}`} aria-label="Git 配置存储" aria-busy={locked}>
    <div className="settings-section-heading"><span className="field-hint">{sync ? "本地变更" : "管理配置备份仓库及描述生成方式"}</span><Button variant="outline" size={sync ? "icon-sm" : "sm"} aria-label="刷新状态" title="刷新状态" disabled={busy} onClick={() => void run(reload)}><RefreshCw size={14} className={busy ? "animate-spin" : ""} />{!sync && "刷新状态"}</Button></div>
    <div className="config-git-body"><ErrorNotice message={error || messageAgent.error} /><ToastNotice message={notice} onDismiss={() => setNotice("")} />
      {operation && <div role="status" className="config-git-operation"><p>{activeOperation ? "正在处理配置，请稍候…" : operation.phase === "completed" ? "操作已完成" : operation.phase === "recovery_required" ? "操作需要恢复" : "操作已结束"}</p><details><summary>操作详情</summary><code>{operation.operationId} · {operation.phase}</code></details>{operation.phase === "interrupted" && <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await reload(); })}>核对仓库状态</Button>}{operation.phase === "recovery_required" && <Button disabled={busy} onClick={() => void run(() => mutate(`/operations/${encodeURIComponent(operation.operationId)}/recover`, {}))}>重试恢复未完成阶段</Button>}</div>}
      {binding === undefined && !error && <Loading />}
      {!sync && messageAgent.data && <ConfigGitMessageAgentSettings setting={messageAgent.data} onSaved={messageAgent.reload} />}
      {sync && binding === null && <p>请先在<a href="/settings?section=config-git">设置 → Git 仓库配置</a>中配置仓库。</p>}
      {!sync && binding === null && <fieldset disabled={locked} className="config-git-binding"><legend>绑定远端仓库</legend>
        <label className="field">仓库地址<Input value={remoteUrl} placeholder="git@github.com:team/config.git 或 https://…" onChange={e => { setRemoteUrl(e.target.value); setChecked(undefined); }} /></label>
        <p className="field-hint">复用服务端系统用户的 SSH key/agent 或 Git credential helper。请勿在地址中填写密码或 Token；未知 SSH 主机需先在服务端验证密钥。</p>
        <Button variant="outline" disabled={!remoteUrl.trim()} onClick={() => void run(() => mutate("/remote/check", { remoteUrl: remoteUrl.trim() }, value => { const check = value as RemoteCheck; check.branches = check.branches.map(b => typeof b === "string" ? b : (b as { name: string }).name); setChecked(check); setBranch(check.defaultBranch ?? check.branches[0] ?? "main"); setName(check.identity?.name ?? ""); setEmail(check.identity?.email ?? ""); }))}>检测连接</Button>
        {checked && <><p role="status">连接成功，推送权限尚未验证。</p>
          <label className="field">分支<Input list="config-git-branches" value={branch} onChange={e => setBranch(e.target.value)} /><datalist id="config-git-branches">{checked.branches.map(b => <option key={b} value={b} />)}</datalist></label>
          <label className="field">配置目录<Input value={configDir} onChange={e => setConfigDir(e.target.value)} /></label>
          <label className="field">提交姓名<Input value={name} onChange={e => setName(e.target.value)} /></label><label className="field">提交邮箱<Input type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
          <p className="field-hint">提交身份只保存到专用副本。绑定将检查目录，不自动提交或恢复。</p>
          <Button disabled={!branch.trim() || !configDir.trim() || !name.trim() || !email.trim()} onClick={() => void run(() => mutate("/bind", { remoteUrl: remoteUrl.trim(), branch: branch.trim(), configDir: configDir.trim(), identity: { name: name.trim(), email: email.trim() } }))}>创建副本并绑定</Button>
        </>}
      </fieldset>}
      {binding && <>
        {sync ? <div className="config-git-sync-repository"><span title={binding.remoteUrl}>{binding.remoteUrl}</span><code>{binding.branch}</code><span>{status ? `领先 ${status.ahead} · 落后 ${status.behind}${status.diverged ? " · 已分叉" : ""}` : "正在读取"}</span></div> : <><dl className="config-git-repository"><dt>仓库</dt><dd>{binding.remoteUrl}</dd><dt>分支 / remote / 配置目录</dt><dd>{binding.branch} / {binding.remote ?? "origin"} / {binding.configDir}</dd><dt>本地 / 远程 SHA</dt><dd>{status?.localSha ?? "无"} / {status?.remoteSha ?? "未知"}</dd><dt>同步状态</dt><dd>{status ? `领先 ${status.ahead} · 落后 ${status.behind}${status.diverged ? " · 已分叉" : ""}` : "正在读取"}</dd></dl>
        <p className="field-hint">远端最近观测：{status?.remoteObservedAt ?? "尚未获取"}。本地历史可离线使用；远端状态可能过期。</p></>}
        {status?.message && <p>{status.message}</p>}
        {!!status?.dirtyPaths.length && <ErrorNotice message={`工作区不干净，请先处理：${status.dirtyPaths.join("、")}`} />}
        {!!status?.pendingCommits?.length && <details><summary>待推送提交（{status.pendingCommits.length}）</summary><pre className="overflow-auto">{status.pendingCommits.join("\n")}</pre></details>}
        {binding.snapshotState === "empty" || binding.snapshotState === "missing" ? <p className="field-hint">{sync ? "首次备份将创建完整配置快照。" : "仓库尚无配置快照，请通过左下角“配置同步”进行首次备份。"}</p> : binding.snapshotState === "valid" ? !sync && <p className="field-hint">仓库已有配置快照。通过左下角“配置同步”备份当前变更。</p> : snapshotBlocked ? <ErrorNotice message="配置目录格式无效或版本不兼容，不能覆盖。请修复目录或升级 Orchard。" /> : null}
        {!sync && <Button variant="ghost" disabled={locked} onClick={() => setConfirmation({ title: "解除仓库绑定", description: "应用配置、本地副本和未推送提交都会保留。", action: () => mutate("/unbind", {}) })}>解除绑定</Button>}
      </>}
      {sync && preview && <section className="management-section config-git-preview" aria-label="配置差异预览"><h3>配置差异 · {preview.diffs.length}</h3>
        {preview.warnings?.map((warning, i) => <p key={i}>{warning}</p>)}{preview.blockers.map((blocker, i) => <ErrorNotice key={i} message={blocker} />)}
        {(Object.keys(categories) as Category[]).map(category => { const diffs = preview.diffs.filter(d => d.category === category); return diffs.length ? <div key={category}><h4>{categories[category]}</h4>{diffs.map((diff, i) => <details key={`${diff.path}:${i}`} className="my-2"><summary className="break-all">{diff.changeType} · {diff.path} {diff.objectId} {diff.versionId}</summary>{diff.detail && <p>{diff.detail}</p>}{diff.blockingReason && <ErrorNotice message={diff.blockingReason} />}{diff.sensitive ? <p>敏感字段已隐藏，仅显示变化状态。</p> : <div className="grid gap-3 md:grid-cols-2"><div><h5>之前</h5><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">{typeof diff.before === "string" ? diff.before : pretty(diff.before)}</pre></div><div><h5>之后</h5><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">{typeof diff.after === "string" ? diff.after : pretty(diff.after)}</pre></div></div>}</details>)}</div> : null; })}
        {!!preview.cumulativeDiffs?.length && <details><summary>累计待推送差异（相对已获取远端）</summary>{preview.cumulativeDiffs.map((diff, i) => <details key={i}><summary>{diff.path}</summary><h5>之前</h5><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">{diff.sensitive ? "敏感字段已隐藏" : diff.before == null ? "—" : String(diff.before)}</pre><h5>之后</h5><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">{diff.sensitive ? "敏感字段已隐藏" : diff.after == null ? "—" : String(diff.after)}</pre></details>)}</details>}
        {preview.nextCursor && <Button disabled={locked} variant="outline" onClick={() => void run(async () => { const page = await api<{ diffs: Diff[]; cumulativeDiffs?: Diff[]; nextCursor?: string }>(`${root}/previews/${encodeURIComponent(preview.token)}/diffs?cursor=${encodeURIComponent(preview.nextCursor!)}`); setPreview(old => old?.token === preview.token ? { ...old, diffs: [...old.diffs, ...page.diffs], cumulativeDiffs: [...(old.cumulativeDiffs ?? []), ...(page.cumulativeDiffs ?? [])], nextCursor: page.nextCursor } : old); })}>加载剩余差异（全部加载后可确认）</Button>}
        {preview.noChanges && <p>没有配置变更，无需备份。</p>}
      </section>}
    </div>
    {sync && binding && <section className="config-git-commit" aria-label="提交信息"><fieldset disabled={locked}>
      <div className="config-git-message-row">
        <label className="field" htmlFor="config-git-commit-message">变更描述</label>
        <Button size="icon-sm" variant="ghost" aria-label="用 Agent 生成描述" title={busy ? "处理中…" : "用 Agent 生成描述"} disabled={locked || !messageAgent.data?.available || !preview || !!preview.nextCursor || preview.noChanges || preview.expiresAt <= Date.now() || preview.blockers.length > 0} onClick={() => void run(async () => {
          const result = await send<{ message: string }>(`${root}/generate-message`, { token: preview!.token });
          setMessage(result.message); setPreview(undefined);
          await mutate("/commit-preview", { message: result.message, push: true, ...general() }, showPreview);
        })}><Sparkles size={14} className={busy ? "animate-pulse" : ""} /></Button>
      </div>
      <Textarea id="config-git-commit-message" value={message} maxLength={4000} placeholder="填写提交信息…" onChange={e => { setMessage(e.target.value); invalidate(); }} />
      <p className="field-hint">{messageAgent.data?.available ? `使用「${messageAgent.data.name}」生成描述。` : messageAgent.data?.agentConfigId ? messageAgent.data.unavailableReason ?? "生成描述的 Agent 暂不可用。" : "尚未配置生成描述的 Agent，可手动填写。"} <a href="/settings?section=config-git">前往设置</a></p>
      {preview && !preview.noChanges && <label className="config-git-confirm"><input type="checkbox" disabled={locked} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已查看完整变更，确认备份到远端仓库。</label>}
      <div className="config-git-commit-actions"><span className="field-hint">提交并推送到远端</span><div className="actions"><Button size="sm" variant="outline" disabled={locked || !message.trim() || snapshotBlocked} onClick={() => void createPreview()}>生成提交预览</Button><Button size="sm" aria-label="进行备份（commit + push）" disabled={locked || !!cannotConfirm} onClick={() => void run(() => mutate("/commit", { token: preview!.token, ...general() }))}>提交并推送</Button></div></div>
    </fieldset></section>}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !locked) setConfirmation(undefined); }}><DialogContent><DialogHeader><DialogTitle>{confirmation?.title}</DialogTitle><DialogDescription>{confirmation?.description}</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={locked} onClick={() => setConfirmation(undefined)}>取消</Button><Button variant="destructive" disabled={locked} onClick={() => void run(async () => { await confirmation?.action(); setConfirmation(undefined); })}>确认</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
