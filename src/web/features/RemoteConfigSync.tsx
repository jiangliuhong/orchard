import { useEffect, useRef, useState } from "react";
import { api, pretty, requestId, send } from "../lib/api";
import { useTheme } from "../lib/theme";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ErrorNotice } from "../components/common";
import { adaptPreview, categories, type Binding, type Category, type Diff, type Operation, type Preview, type RecoveryPoint, type RepositoryStatus } from "./ConfigGitSettings";

export interface RemoteSource { bindingId: string; branch: string; sourceSha: string; fetchedAt: string; commit: { subject: string; author: string; committedAt: string }; snapshotState: string; supportedCategories: Category[] }
type Source = { kind: "git"; sha: string } | { kind: "recovery-point"; id: string };
type Kind = "fetch" | "preview" | "apply";
interface PendingRequest { kind: Kind; path: string; payload: Record<string, unknown>; requestId: string; operationId?: string }
function isPendingRequest(value: unknown): value is PendingRequest {
  if (!value || typeof value !== "object") return false;
  const saved = value as PendingRequest;
  const fields = saved.kind === "fetch" && saved.path === "/remote-sync-source" ? []
    : saved.kind === "preview" && saved.path === "/restore-preview" ? ["source", "categories", "mappings", "theme", "clientId", "preferenceRevision"]
    : saved.kind === "apply" && saved.path === "/restore" ? ["token"]
    : saved.kind === "apply" && /^\/operations\/[^/]+\/recover$/.test(saved.path) ? [] : undefined;
  return !!fields && typeof saved.requestId === "string" && !!saved.requestId && !!saved.payload && typeof saved.payload === "object" && !Array.isArray(saved.payload)
    && Object.keys(saved.payload).every(key => fields.includes(key));
}
const storageKey = "orchard-config-git-remote-operation";
const root = "/config-git";
export function canApplyRemote(preview: Preview | undefined, confirmed: boolean, mappings: Record<string, string>, stale: boolean, now = Date.now()) {
  return !!preview && confirmed && !stale && !preview.nextCursor && !preview.noChanges && preview.expiresAt > now && !preview.blockers.length && !preview.diffs.some(d => d.blockingReason) && preview.requiredMappings.every(m => !!mappings[m.key]?.trim());
}
export function RemoteConfigSync({ visible, binding, status, onApplied, onLeave }: { visible: boolean; binding?: Binding | null; status?: RepositoryStatus; onApplied: () => unknown; onLeave: () => void }) {
  const theme = useTheme(), [source, setSource] = useState<RemoteSource>(), [restoreSource, setRestoreSource] = useState<Source>();
  const [scope, setScope] = useState<Category[]>([]), [mappings, setMappings] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview>(), [confirmed, setConfirmed] = useState(false), [stale, setStale] = useState(true);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [operation, setOperation] = useState<Operation>();
  const [result, setResult] = useState<Record<string, unknown>>(), [points, setPoints] = useState<RecoveryPoint[]>([]);
  const [clock, setClock] = useState(Date.now());
  const running = useRef(false), kind = useRef<Kind>("fetch");
  const pendingRequest = useRef<PendingRequest | undefined>(undefined);
  const [unacknowledged, setUnacknowledged] = useState(false);
  const latest = useRef({ binding, theme, onApplied }); latest.current = { binding, theme, onApplied };
  const invalidate = () => { setPreview(undefined); setConfirmed(false); };
  const receive = (value: unknown, action: Kind) => {
    if (action === "fetch") {
      const next = value as RemoteSource;
      setSource(next); setRestoreSource({ kind: "git", sha: next.sourceSha }); setScope(next.supportedCategories.filter(c => c in categories)); setMappings({});
      setStale(next.snapshotState !== "valid" || next.bindingId !== latest.current.binding?.id); setResult(undefined); invalidate();
    } else if (action === "preview") { setPreview(adaptPreview(value)); setConfirmed(false); }
    else { setResult(value as Record<string, unknown>); invalidate(); setStale(true); void latest.current.onApplied(); window.dispatchEvent(new Event("orchard:config-restored")); }
  };
  const receiveRef = useRef(receive); receiveRef.current = receive;
  const acceptResponse = (response: unknown, saved: PendingRequest) => {
    if (response && typeof response === "object" && "operationId" in response && "statusUrl" in response) {
      const accepted = response as unknown as Operation;
      localStorage.setItem(storageKey, JSON.stringify({ ...saved, operationId: accepted.operationId }));
      kind.current = saved.kind;
      setOperation({ operationId: accepted.operationId, phase: "accepted" });
    } else {
      receiveRef.current(response, saved.kind);
      localStorage.removeItem(storageKey);
    }
    pendingRequest.current = undefined; setUnacknowledged(false);
  };
  const resendPending = async () => {
    const saved = pendingRequest.current;
    if (!saved) return;
    // This is the already confirmed request, including its original token and ID.
    // Never generate an identity or rebuild payload from the current UI here.
    try {
      const response = await send<unknown>(`${root}${saved.path}`, { ...saved.payload, requestId: saved.requestId });
      acceptResponse(response, saved);
    } catch (error) {
      // Validation/authentication rejections have no accepted operation to recover.
      // Keep ambiguous failures (network errors, timeouts, conflicts and 5xx)
      // pinned to the original request, so retry cannot duplicate accepted work.
      if ([400, 401, 403, 404, 413, 415, 422, 429].includes((error as { httpStatus?: number }).httpStatus ?? 0)) {
        localStorage.removeItem(storageKey);
        pendingRequest.current = undefined; setUnacknowledged(false);
      }
      throw error;
    }
  };
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (saved?.operationId && ["fetch", "preview", "apply"].includes(saved.kind)) {
        kind.current = saved.kind; setOperation({ operationId: saved.operationId, phase: "accepted" });
      } else if (isPendingRequest(saved)) {
        pendingRequest.current = saved; setUnacknowledged(true);
        running.current = true; setBusy(true);
        void resendPending().catch(e => setError(`请求回执尚未确认，请重试查询原请求：${(e as Error).message}`))
          .finally(() => { running.current = false; setBusy(false); });
      }
    } catch { setError("无法读取待确认请求，请检查浏览器存储后重试。"); }
    const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer);
  }, []);
  useEffect(() => { if (!visible) { invalidate(); setMappings({}); } }, [visible]);
  useEffect(() => { invalidate(); setStale(true); }, [binding?.id, binding?.branch, theme.preferenceRevision]);
  const active = !!operation && !["completed", "failed", "interrupted", "recovery_required"].includes(operation.phase);
  useEffect(() => {
    if (!active || !operation) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Operation>(`${root}/operations/${encodeURIComponent(operation.operationId)}`);
        if (disposed) return; setOperation(next);
        if (next.phase === "completed") { localStorage.removeItem(storageKey); receiveRef.current(next.result, kind.current); return; }
        if (["failed", "interrupted", "recovery_required"].includes(next.phase)) { if (kind.current === "fetch") setStale(true); invalidate(); setError(typeof next.error === "object" ? `${next.error.code}: ${next.error.message}` : next.error ?? "操作中断，请重新预览。已受理应用请先查询恢复状态。"); return; }
      } catch (e) { if (!disposed) setError(`状态查询失败，将继续重试：${(e as Error).message}`); }
      if (!disposed) timer = setTimeout(() => void poll(), 1500);
    }; void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [operation?.operationId, active]);
  const locked = busy || active || unacknowledged || operation?.phase === "recovery_required";
  const work = async (fn: () => Promise<void>) => {
    if (running.current || active) return; running.current = true; setBusy(true); setError("");
    try { await fn(); } catch (e) { setError((e as Error).message); if ((e as { code?: string }).code === "PREVIEW_EXPIRED") invalidate(); }
    finally { running.current = false; setBusy(false); }
  };
  const mutate = async (path: string, payload: Record<string, unknown>, action: Kind) => {
    if (pendingRequest.current) throw new Error("原请求回执尚未确认，请先重试查询原请求。");
    const saved: PendingRequest = { kind: action, path, payload, requestId: requestId() };
    if (!isPendingRequest(saved)) throw new Error("无法持久化此同步请求。");
    // Durably save only request metadata before HTTP can reach the server. Storage
    // failure must prevent sending, otherwise refresh could lose accepted work.
    localStorage.setItem(storageKey, JSON.stringify(saved));
    pendingRequest.current = saved; setUnacknowledged(true);
    await resendPending();
  };
  const createPreview = () => work(async () => { setConfirmed(false); setPreview(old => old ? { ...old, expiresAt: 0 } : old); const { theme: appearance, clientId, preferenceRevision } = theme.getPreference(); await mutate("/restore-preview", { source: restoreSource, categories: scope, mappings, theme: appearance, clientId, preferenceRevision }, "preview"); });
  const available = restoreSource?.kind === "recovery-point" ? Object.keys(categories) as Category[] : source?.supportedCategories ?? [];
  const leave = () => { if ((!preview && !Object.keys(mappings).length) || window.confirm("放弃当前同步预览及本机映射输入？已受理的操作会继续执行。")) { invalidate(); setMappings({}); onLeave(); } };
  return <section hidden={!visible} className="remote-config-sync detail-stack" aria-label="从远端同步" aria-busy={locked}>
    <div className="config-git-sync-repository"><span title={binding?.remoteUrl}>{binding?.remoteUrl ?? "尚未绑定 Git 仓库"}</span><code>{binding?.branch}</code><span>领先 {status?.ahead ?? "—"} · 落后 {status?.behind ?? "—"}</span></div>
    {!binding ? <a href="/settings?section=config-git">前往 Git 仓库配置</a> : <div className="actions"><Button disabled={locked} onClick={() => void work(async () => { invalidate(); setStale(true); await mutate("/remote-sync-source", {}, "fetch"); })}>获取远端配置</Button><Button variant="outline" disabled={locked} onClick={() => void work(async () => setPoints((await api<{ items: RecoveryPoint[] }>(`${root}/recovery-points`)).items))}>查看恢复点</Button><Button variant="ghost" onClick={leave}>返回备份</Button></div>}
    <ErrorNotice message={error} />
    {unacknowledged && <div role="status">原请求回执尚未确认；新同步操作已暂停。<Button variant="outline" disabled={busy || active} onClick={() => void work(resendPending)}>重试查询原请求</Button></div>}
    {operation && <div role="status">操作 {operation.operationId} · {operation.phase}{operation.phase === "recovery_required" && <Button variant="outline" disabled={busy} onClick={() => void work(() => mutate(`/operations/${encodeURIComponent(operation.operationId)}/recover`, {}, "apply"))}>重试恢复</Button>}</div>}
    {source && <div><strong>{source.commit.subject}</strong><p className="field-hint">{source.commit.author} · {source.commit.committedAt} · 获取于 {source.fetchedAt}</p><code title={source.sourceSha}>{source.sourceSha}</code>{stale && <p role="status">来源已过期或尚未就绪，请重新获取后预览。</p>}{source.snapshotState !== "valid" && <p>远端快照状态：{source.snapshotState}。尚无快照时，请先在其他设备备份。</p>}</div>}
    {(status?.diverged || !!status?.ahead) && <p className="field-hint">本次应用获取时的远端快照，本地未推送提交仍保留；后续备份可能需要处理分叉。</p>}
    {!!status?.dirtyPaths.length && <ErrorNotice message={`工作区不干净：${status.dirtyPaths.join("、")}`} />}
    {restoreSource && <><fieldset disabled={locked || stale}><legend>同步类别</legend><div className="actions">{available.map(c => <label key={c}><input type="checkbox" checked={scope.includes(c)} onChange={e => { setScope(old => e.target.checked ? [...old, c] : old.filter(item => item !== c)); invalidate(); }} /> {categories[c]}</label>)}</div></fieldset><p className="field-hint">本机密钥、登录状态、运行记录及本机独有对象保留。加密字典须先在本机导入独立密钥。</p><Button variant="outline" disabled={locked || stale || !scope.length} onClick={() => void createPreview()}>预览同步</Button></>}
    {preview && <><h3>实际应用差异 · {preview.diffs.length}</h3>{preview.sourceSha && <code>{preview.sourceSha}</code>}{preview.categories.filter(c => !scope.includes(c)).map(c => <p key={c}>依赖自动补入：{categories[c]}，请重新确认完整范围。</p>)}{preview.warnings?.map((w, i) => <p key={i}>{w}</p>)}{preview.blockers.map((b, i) => <ErrorNotice key={i} message={b} />)}
      {preview.requiredMappings.map(m => <label className="field" key={m.key}>{m.label}<Input disabled={locked} value={mappings[m.key] ?? ""} onChange={e => { setMappings(old => ({ ...old, [m.key]: e.target.value })); setConfirmed(false); setPreview(old => old ? { ...old, expiresAt: 0 } : old); }} /></label>)}
      {preview.requiredMappings.length > 0 && <Button variant="outline" disabled={locked || stale} onClick={() => void createPreview()}>更新映射并重新预览</Button>}
      {preview.diffs.map((d, i) => <details key={`${d.path}:${i}`}><summary>{categories[d.category]} · {d.changeType} · {d.path}</summary>{d.detail && <p>{d.detail}</p>}<ErrorNotice message={d.blockingReason ?? ""} />{d.sensitive ? <p>敏感字段已隐藏，仅显示变化状态。</p> : <div className="grid gap-3 md:grid-cols-2"><div>之前<pre className="overflow-auto whitespace-pre-wrap break-all">{pretty(d.before)}</pre></div><div>之后<pre className="overflow-auto whitespace-pre-wrap break-all">{pretty(d.after)}</pre></div></div>}</details>)}
      {preview.nextCursor && <Button disabled={locked} variant="outline" onClick={() => void work(async () => { const page = await api<{ diffs: Diff[]; nextCursor?: string }>(`${root}/previews/${encodeURIComponent(preview.token)}/diffs?cursor=${encodeURIComponent(preview.nextCursor!)}`); setPreview(old => old?.token === preview.token ? { ...old, diffs: [...old.diffs, ...page.diffs], nextCursor: page.nextCursor } : old); })}>加载剩余差异（全部加载后可确认）</Button>}
      {preview.noChanges ? <p>没有配置变更，无需应用。</p> : <><label><input type="checkbox" checked={confirmed} disabled={locked || !!preview.nextCursor || preview.expiresAt <= clock} onChange={e => setConfirmed(e.target.checked)} /> 已查看差异，确认将远端配置应用到本机</label>{preview.expiresAt <= clock && <p>预览已失效，请重新预览。</p>}<Button disabled={locked || !canApplyRemote(preview, confirmed, mappings, stale, clock)} onClick={() => void work(() => mutate("/restore", { token: preview.token }, "apply"))}>应用到本机</Button></>}
    </>}
    {result && <section aria-label="同步结果" role="status"><h3>已应用配置快照</h3><p className="field-hint">保留本机独有对象，相关页面重新打开后读取最新配置。Provider 与 Web Bridge 如有需要请重新连接。</p><RestoreOutcome value={result} />{typeof result.recoveryPointId === "string" && <Button variant="outline" disabled={locked} onClick={() => { invalidate(); setRestoreSource({ kind: "recovery-point", id: result.recoveryPointId as string }); setScope(Object.keys(categories) as Category[]); setStale(false); }}>查看同步前配置</Button>}</section>}
    {points.map(point => <div className="actions" key={point.id}><code>{point.id}</code><span>{new Date(point.createdAt).toLocaleString()}</span><Button variant="outline" disabled={locked} onClick={() => { invalidate(); setRestoreSource({ kind: "recovery-point", id: point.id }); setScope(Object.keys(categories) as Category[]); setMappings({}); setStale(false); }}>选择恢复点</Button></div>)}
    {restoreSource?.kind === "recovery-point" && <p>正在预览恢复点 {restoreSource.id}。恢复保留不可变版本和本机独有对象；请预览差异后确认。</p>}
  </section>;
}

function RestoreOutcome({ value }: { value: Record<string, unknown> }) {
  const details = (value.result && typeof value.result === "object" ? value.result : value) as { sourceSha?: string; changed?: number; changes?: { category: Category; changeType: string }[]; reconnect?: string[] };
  const source = value.source as Source | undefined;
  const sha = details.sourceSha ?? (source?.kind === "git" ? source.sha : undefined);
  const counts = new Map<string, number>();
  for (const change of details.changes ?? []) { const label = `${categories[change.category] ?? change.category} · ${change.changeType}`; counts.set(label, (counts.get(label) ?? 0) + 1); }
  return <><p>{sha ? <>已应用远端快照 <code>{sha}</code></> : "恢复点配置已应用"}{details.changed !== undefined && ` · 实际变更 ${details.changed} 项`}</p>{counts.size > 0 && <ul>{[...counts].map(([label, count]) => <li key={label}>{label}：{count}</li>)}</ul>}{!!details.reconnect?.length && <p>需要重新连接：{details.reconnect.join("、")}</p>}</>;
}
