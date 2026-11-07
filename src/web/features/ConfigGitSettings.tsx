import { useCallback, useEffect, useRef, useState } from "react";
import { api, pretty, requestId, send } from "../lib/api";
import { useTheme, type Theme } from "../lib/theme";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
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
function adaptHistory(raw: History & { commits?: History["items"]; nextOffset?: number | null }): History {
  return { items: raw.items ?? raw.commits ?? [], startSha: raw.startSha, nextCursor: raw.nextCursor ?? (raw.nextOffset == null ? undefined : String(raw.nextOffset)) };
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

export function ConfigGitSettings() {
  const themeState = useTheme();
  const preferenceRef = useRef(themeState); preferenceRef.current = themeState;
  const [binding, setBinding] = useState<Binding | null>();
  const [status, setStatus] = useState<RepositoryStatus>();
  const [points, setPoints] = useState<RecoveryPoint[]>([]);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [checked, setChecked] = useState<RemoteCheck>();
  const [branch, setBranch] = useState("main"), [configDir, setConfigDir] = useState("orchard-config");
  const [name, setName] = useState(""), [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [operation, setOperation] = useState<Operation>();
  const [history, setHistory] = useState<History>(), [scope, setScope] = useState<"local" | "remote">("local");
  const [source, setSource] = useState<Source>();
  const [selected, setSelected] = useState<Category[]>(Object.keys(categories) as Category[]);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [mappingFields, setMappingFields] = useState<Preview["requiredMappings"]>([]);
  const [mappingKey, setMappingKey] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [mode, setMode] = useState<"commit" | "restore">("commit");
  const [message, setMessage] = useState("");
  const [push, setPush] = useState(true), [regenerate, setRegenerate] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; action: () => Promise<void> }>();
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const retry = useRef<{ payload: string; id: string } | undefined>(undefined);
  const operationHandler = useRef<((result: unknown) => void) | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reload = useCallback(async () => {
    const results = await Promise.allSettled([
      api<{ binding: Binding | null }>(`${root}/repository`), api<RepositoryStatus>(`${root}/status`), api<{ items: RecoveryPoint[] }>(`${root}/recovery-points`),
    ]);
    if (!mounted.current) return;
    const [repository, state, recovery] = results;
    if (repository.status === "fulfilled") setBinding(repository.value.binding);
    if (state.status === "fulfilled") { setStatus(adaptStatus(state.value)); if (state.value.operationId) setOperation(old => old?.operationId === state.value.operationId ? old : { operationId: state.value.operationId!, phase: "accepted" }); }
    if (recovery.status === "fulfilled") setPoints(Array.isArray(recovery.value) ? recovery.value : recovery.value.items);
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
    setNotice([result?.message ?? "操作完成", result?.committed ? `本地已提交 ${result.sha ?? ""}` : result?.sha, result?.pushed ? "远程已推送" : "", result?.remoteUnknown || result?.remoteState === "unknown" ? "远端状态待确认，请获取后重试推送" : "", result?.pushError, result?.reconnect?.length ? `需要重新连接：${result.reconnect.join("、")}` : ""].filter(Boolean).join(" · "));
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
          setError("服务已重启，操作结果尚未确认。请核对当前状态和本地历史，再重新操作。");
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
  const showPreview = (value: unknown) => { const next = adaptPreview(value); setPreview(next); setMappingFields(old => [...old.filter(field => !next.requiredMappings.some(nextField => nextField.key === field.key)), ...next.requiredMappings]); setConfirmed(false); };
  const createPreview = () => run(async () => {
    setPreview(undefined);
    if (mode === "commit") await mutate("/commit-preview", { message: message.trim(), push, regenerate, ...general() }, showPreview);
    else { const { clientId, preferenceRevision } = general(); await mutate("/restore-preview", { source, categories: selected, mappings, clientId, preferenceRevision }, showPreview); }
  });
  const loadHistory = async (nextScope: "local" | "remote", more = false) => {
    const query = new URLSearchParams({ source: nextScope });
    if (more && history) { query.set("startSha", history.startSha); if (history.nextCursor) query.set("offset", history.nextCursor); }
    const page = adaptHistory(await api<History>(`${root}/commits?${query}`));
    setScope(nextScope); setHistory(old => more && old ? { ...page, items: [...old.items, ...page.items] } : page);
  };
  const chooseSource = (value: Source) => { setSource(value); setMode("restore"); setPreview(undefined); setMappingFields([]); setMappings({}); };
  const invalidate = () => { setPreview(undefined); setConfirmed(false); };
  const cannotConfirm = !preview || !confirmed || !!preview.nextCursor || preview.noChanges || preview.blockers.length > 0 || preview.diffs.some(d => d.blockingReason) || preview.requiredMappings.some(m => !mappings[m.key]?.trim()) || preview.expiresAt <= Date.now();
  const snapshotBlocked = binding?.snapshotState === "invalid" || binding?.snapshotState === "unsupported";
  return <section className="panel" aria-label="Git 配置存储" aria-busy={locked}>
    <div className="preference-row"><div><h2>Git 配置存储</h2><p>手动备份设置、工作流和脚本定义；普通保存不会提交或推送。</p></div><Button variant="outline" disabled={busy} onClick={() => void run(reload)}>刷新状态</Button></div>
    <div className="management-section"><ErrorNotice message={error} />{notice && <p role="status" className="success-note">{notice}</p>}
      {operation && <div role="status"><p>操作 {operation.operationId} · {operation.phase}</p>{operation.phase === "interrupted" && <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await reload(); if (binding) await loadHistory("local"); })}>核对状态与本地历史</Button>}{operation.phase === "recovery_required" && <Button disabled={busy} onClick={() => void run(() => mutate(`/operations/${encodeURIComponent(operation.operationId)}/recover`, {}))}>重试恢复未完成阶段</Button>}</div>}
      {binding === undefined && !error && <Loading />}
      {binding === null && <fieldset disabled={locked} className="space-y-3"><legend>绑定远端仓库</legend>
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
        <dl className="space-y-2 break-all"><dt>仓库</dt><dd>{binding.remoteUrl}</dd><dt>分支 / remote / 配置目录</dt><dd>{binding.branch} / {binding.remote ?? "origin"} / {binding.configDir}</dd><dt>本地 / 远程 SHA</dt><dd>{status?.localSha ?? "无"} / {status?.remoteSha ?? "未知"}</dd><dt>同步状态</dt><dd>{status ? `领先 ${status.ahead} · 落后 ${status.behind}${status.diverged ? " · 已分叉" : ""}` : "正在读取"}</dd></dl>
        <p className="field-hint">远端最近观测：{status?.remoteObservedAt ?? "尚未获取"}。本地历史可离线使用；远端状态可能过期。</p>
        {status?.message && <p>{status.message}</p>}
        {!!status?.dirtyPaths.length && <ErrorNotice message={`工作区不干净，请先处理：${status.dirtyPaths.join("、")}`} />}
        {!!status?.pendingCommits?.length && <details><summary>待推送提交（{status.pendingCommits.length}）</summary><pre className="overflow-auto">{status.pendingCommits.join("\n")}</pre></details>}
        {binding.snapshotState === "empty" || binding.snapshotState === "missing" ? <p>仓库尚无配置快照，请预览并提交当前配置。</p> : binding.snapshotState === "valid" ? <p>仓库已有配置，可选择预览恢复或提交当前配置。</p> : snapshotBlocked ? <ErrorNotice message="配置目录格式无效或版本不兼容，不能覆盖。请修复目录或升级 Orchard。" /> : null}
        <div className="actions flex-wrap my-4">
          <Button disabled={locked || snapshotBlocked} onClick={() => { setMode("commit"); setPush(true); setRegenerate(false); invalidate(); }}>提交并推送</Button>
          <Button variant="outline" disabled={locked || snapshotBlocked} onClick={() => { setMode("commit"); setPush(false); setRegenerate(false); invalidate(); }}>仅本地提交</Button>
          <Button variant="outline" disabled={locked} onClick={() => void run(() => mutate("/push", {}))}>推送</Button>
          <Button variant="outline" disabled={locked} onClick={() => void run(() => mutate("/fetch", {}))}>获取远程版本</Button>
          <Button variant="outline" disabled={locked} onClick={() => void run(() => mutate("/fetch", {}, () => { void loadHistory("remote").catch(e => setError(errorText(e))); }))}>从远端恢复</Button>
          <Button variant="outline" disabled={locked} onClick={() => void run(() => loadHistory("local"))}>本地历史</Button>
          <Button variant="ghost" disabled={locked} onClick={() => setConfirmation({ title: "解除仓库绑定", description: "应用配置、本地副本、未推送提交和恢复资料都会保留。重新绑定将创建新的副本。", action: () => mutate("/unbind", {}, value => { setHistory(undefined); setSource(undefined); report(value); }) })}>解除绑定</Button>
        </div>
        {status?.diverged && <Button variant="outline" disabled={locked} onClick={() => { setMode("commit"); setPush(true); setRegenerate(true); invalidate(); }}>基于最新远端重新生成提交</Button>}
        {history && <section className="management-section"><h3>{scope === "local" ? "已获取的本地历史（远端未刷新）" : "远端配置历史"}</h3>{history.items.map(item => <div className="py-3 border-b" key={item.sha}><strong>{item.message}</strong><p className="field-hint break-all">{item.author} · {item.date} · {item.sha} · {item.categories?.map(c => categories[c]).join("、") ?? "类别与兼容性将在预览中校验"}</p><Button variant="outline" disabled={locked || item.compatible === false} onClick={() => chooseSource({ kind: "git", sha: item.sha })}>{item.compatible === false ? "格式不兼容" : "选择此提交恢复"}</Button></div>)}{!history.items.length && <p>没有可恢复的配置提交。</p>}{history.nextCursor && <Button variant="outline" disabled={locked} onClick={() => void run(() => loadHistory(scope, true))}>加载更多历史</Button>}</section>}
      </>}
      {(binding || source?.kind === "recovery-point") && <section className="management-section"><fieldset disabled={locked} className="space-y-3"><legend>{mode === "commit" ? push ? "提交并推送预览" : "仅本地提交预览" : "恢复预览"}</legend>
        {mode === "commit" ? <><label className="field">提交说明<Input value={message} onChange={e => { setMessage(e.target.value); invalidate(); }} /></label><p className="field-hint">{regenerate ? "先保留旧提交备份引用，再基于最新远端生成当前配置；确认差异后普通推送。" : push ? "先获取远端并检查差异，确认后创建提交并推送。" : "离线提交以本地 HEAD 为基准，远端状态可能过期。"}</p></> : <>
          <p className="break-all">来源：{source ? source.kind === "git" ? source.sha : `恢复点 ${source.id}` : "请从历史或恢复点选择"}</p>
          <div className="flex flex-wrap gap-4">{(Object.keys(categories) as Category[]).map(c => <label key={c}><input type="checkbox" checked={selected.includes(c)} onChange={e => { setSelected(old => e.target.checked ? [...old, c] : old.filter(v => v !== c)); invalidate(); }} /> {categories[c]}</label>)}</div>
          <div className="space-y-2"><label className="field">本机映射引用键<Input value={mappingKey} placeholder="填写预览错误中需要补充的 localRef" onChange={e => setMappingKey(e.target.value)} /></label><Button variant="outline" disabled={!mappingKey.trim()} onClick={() => { const key = mappingKey.trim(); setMappingFields(old => old.some(field => field.key === key) ? old : [...old, { key, label: key }]); setMappingKey(""); invalidate(); }}>添加本机映射</Button></div>
          {mappingFields.map(field => <label className="field" key={field.key}>{field.label}<Input value={mappings[field.key] ?? ""} onChange={e => { setMappings(old => ({ ...old, [field.key]: e.target.value })); invalidate(); }} /><code>{field.key}</code></label>)}
          <p className="field-hint">恢复前保存恢复点；保留目标独有对象和历史版本。缺失依赖可能扩展所选类别，需确认最终范围。恢复后需重新连接相关服务。</p>
        </>}
        <Button disabled={mode === "commit" ? !message.trim() || snapshotBlocked : !source || !selected.length} onClick={() => void createPreview()}>生成{mode === "commit" ? "提交" : "恢复"}预览</Button>
      </fieldset></section>}
      {preview && <section className="management-section" aria-label="配置差异预览"><h3>确认差异</h3><p>最终范围：{preview.categories.map(c => categories[c]).join("、")} · 有效至 {new Date(preview.expiresAt).toLocaleString()}</p>{preview.sourceSha && <p className="break-all">来源 SHA：{preview.sourceSha}</p>}
        {preview.warnings?.map((warning, i) => <p key={i}>{warning}</p>)}{preview.blockers.map((blocker, i) => <ErrorNotice key={i} message={blocker} />)}
        {(Object.keys(categories) as Category[]).map(category => { const diffs = preview.diffs.filter(d => d.category === category); return diffs.length ? <div key={category}><h4>{categories[category]}</h4>{diffs.map((diff, i) => <details key={`${diff.path}:${i}`} className="my-2"><summary className="break-all">{diff.changeType} · {diff.path} {diff.objectId} {diff.versionId}</summary>{diff.detail && <p>{diff.detail}</p>}{diff.blockingReason && <ErrorNotice message={diff.blockingReason} />}{diff.sensitive ? <p>敏感字段已隐藏，仅显示变化状态。</p> : <div className="grid gap-3 md:grid-cols-2"><div><h5>之前</h5><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">{typeof diff.before === "string" ? diff.before : pretty(diff.before)}</pre></div><div><h5>之后</h5><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">{typeof diff.after === "string" ? diff.after : pretty(diff.after)}</pre></div></div>}</details>)}</div> : null; })}
        {!!preview.cumulativeDiffs?.length && <details><summary>累计待推送差异（相对已获取远端）</summary>{preview.cumulativeDiffs.map((diff, i) => <details key={i}><summary>{diff.path}</summary><h5>之前</h5><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">{diff.sensitive ? "敏感字段已隐藏" : diff.before == null ? "—" : String(diff.before)}</pre><h5>之后</h5><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">{diff.sensitive ? "敏感字段已隐藏" : diff.after == null ? "—" : String(diff.after)}</pre></details>)}</details>}
        {preview.nextCursor && <Button disabled={locked} variant="outline" onClick={() => void run(async () => { const page = await api<{ diffs: Diff[]; cumulativeDiffs?: Diff[]; nextCursor?: string }>(`${root}/previews/${encodeURIComponent(preview.token)}/diffs?cursor=${encodeURIComponent(preview.nextCursor!)}`); setPreview(old => old?.token === preview.token ? { ...old, diffs: [...old.diffs, ...page.diffs], cumulativeDiffs: [...(old.cumulativeDiffs ?? []), ...(page.cumulativeDiffs ?? [])], nextCursor: page.nextCursor } : old); })}>加载剩余差异（全部加载后可确认）</Button>}
        {preview.noChanges ? <p>没有变化，不创建空提交或重复恢复。</p> : <><label className="flex gap-2 my-4"><input type="checkbox" disabled={locked} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已查看完整差异并确认最终类别、本机映射及依赖范围。</label><div className="actions"><Button variant="outline" disabled={locked} onClick={invalidate}>取消预览</Button><Button disabled={locked || !!cannotConfirm} onClick={() => void run(() => mutate(mode === "commit" ? "/commit" : "/restore", { token: preview.token, ...(mode === "commit" ? general() : {}) }))}>确认{mode === "commit" ? push ? "提交并推送" : "本地提交" : "应用恢复"}</Button></div></>}
      </section>}
      <section className="management-section"><h3>服务端外观快照</h3><p className="field-hint">可领取 CLI 保存的外观或在清除浏览器存储后重新领取；应用前会请求确认。</p><Button variant="outline" onClick={() => window.dispatchEvent(new Event("orchard:claim-general"))}>领取服务端外观快照</Button></section>
      <section className="management-section"><h3>本地恢复点</h3>{!points.length && <p className="field-hint">暂无恢复点。</p>}{points.map(point => <div key={point.id} className="py-3 border-b"><p className="break-all">{new Date(point.createdAt).toLocaleString()} · {point.id} {point.sourceSha}</p><div className="actions"><Button variant="outline" disabled={locked} onClick={() => chooseSource({ kind: "recovery-point", id: point.id })}>预览恢复点</Button><Button variant="ghost" disabled={locked || point.protected} onClick={() => setConfirmation({ title: "删除恢复点", description: `删除 ${point.id} 的独立恢复资料，此操作不可撤销。`, action: () => mutate(`/recovery-points/${encodeURIComponent(point.id)}`, {}, report, "DELETE") })}>{point.protected ? "未完成操作正在引用" : "删除恢复点"}</Button></div></div>)}</section>
    </div>
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !locked) setConfirmation(undefined); }}><DialogContent><DialogHeader><DialogTitle>{confirmation?.title}</DialogTitle><DialogDescription>{confirmation?.description}</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={locked} onClick={() => setConfirmation(undefined)}>取消</Button><Button variant="destructive" disabled={locked} onClick={() => void run(async () => { await confirmation?.action(); setConfirmation(undefined); })}>确认</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
