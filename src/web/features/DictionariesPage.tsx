import { useEffect, useState } from "react";
import { BookOpen, KeyRound, Lock, Plus, Save, ShieldCheck, Trash2, Undo2, Unlock } from "lucide-react";
import { api, requestId, send, useCommandKey, useResource } from "../lib/api";
import { parseStrictJson } from "../../dictionaries/canonical.js";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { EmptyState, ErrorNotice, Loading, PageHeading, Status } from "../components/common";
import { DeleteDictionaryButton } from "./DeleteDictionaryButton";
import { ToastNotice } from "../components/ToastNotice";
import type { DictionaryReadiness } from "../../secrets/service.js";

export interface DictionaryListView {
  id: string; name: string; description: string; kind: "plain" | "encrypted"; enabled: boolean; revision: number;
  currentVersionId: string; createdAt: number; updatedAt: number; keyCount: number;
  readiness: DictionaryReadiness; missingKeyIds: string[]; deletedAt?: number | null;
}
export interface DictionaryDetail extends DictionaryListView { versionNo: number; keys: Record<string, { type: string; value?: unknown } | { type: "string"; set: true; keyId: string }> }
interface VersionSummary { id: string; versionNo: number; name: string; description: string; enabled: boolean; createdAt: number }
interface Operation { op: "set" | "remove"; key: string; type?: string; value?: unknown }

const readinessLabels: Record<DictionaryReadiness, string> = {
  ready: "可解密", "missing-key": "缺少密钥", "authentication-failed": "认证失败", "keyring-unavailable": "密钥环不可用",
};

const readError = (error: unknown): { message: string; details?: { impacts: { key: string; workflows: number; scripts: number }[]; confirmationToken: string; expiresAt: number } } => {
  const value = error as Error & { details?: { impacts: { key: string; workflows: number; scripts: number }[]; confirmationToken: string; expiresAt: number } };
  return { message: value.message, details: value.details };
};

function CreateDictionaryDialog({ onCreated, iconOnly = false }: { onCreated: (id: string) => void; iconOnly?: boolean }) {
  const [open, setOpen] = useState(false), [name, setName] = useState(""), [description, setDescription] = useState("");
  const [kind, setKind] = useState<"plain" | "encrypted">("plain"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const commandKey = useCommandKey();
  const create = async () => {
    setBusy(true); setError("");
    try {
      const input = { name: name.trim(), description, kind, enabled: true, operations: [] };
      const result = await send<{ dictionaryId: string }>("/dictionaries", { ...input, requestId: commandKey(input) });
      setOpen(false); setName(""); setDescription(""); setKind("plain");
      onCreated(result.dictionaryId);
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  return <>
    <Button variant={iconOnly ? "ghost" : "default"} className={iconOnly ? "empty-symbol h-auto" : undefined} aria-label={iconOnly ? "新建字典" : undefined} onClick={() => setOpen(true)}>{iconOnly ? <Plus className="size-[25px]" /> : <><Plus size={15} />新建字典</>}</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>新建字典</DialogTitle><DialogDescription>普通字典保存共享键值配置；加密字典以密文保存敏感字符串，需要先在设置中配置加密字典密钥。</DialogDescription></DialogHeader>
        <label htmlFor="dict-name">名称（1–100 字符）</label>
        <Input id="dict-name" value={name} maxLength={100} disabled={busy} onChange={event => setName(event.target.value)} />
        <label htmlFor="dict-description">说明（可选，不承诺保密）</label>
        <Input id="dict-description" value={description} maxLength={2000} disabled={busy} onChange={event => setDescription(event.target.value)} />
        <label htmlFor="dict-kind">类型（创建后不可切换）</label>
        <Select value={kind} onValueChange={value => setKind(value as "plain" | "encrypted")}>
          <SelectTrigger id="dict-kind" aria-label="字典类型"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="plain">普通字典（字符串 / 数字 / 布尔 / JSON）</SelectItem>
            <SelectItem value="encrypted">加密字典（敏感字符串，密文保存）</SelectItem>
          </SelectContent>
        </Select>
        <ErrorNotice message={error} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? "正在创建…" : "创建"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

export function DictionariesPage() {
  const [kind, setKind] = useState<string>("all"), [cursor, setCursor] = useState("");
  const [deleted, setDeleted] = useState(false), [message, setMessage] = useState("");
  const { data, error, reload } = useResource<{ items: DictionaryListView[]; nextCursor: string | null }>(`/dictionaries?${new URLSearchParams({ ...(deleted ? { deleted: "true" } : {}), ...(kind === "all" ? {} : { kind }), ...(cursor ? { cursor } : {}) })}`);
  return <>
    <PageHeading title="字典"><CreateDictionaryDialog onCreated={id => { window.location.href = `/dictionaries/${id}`; }} /></PageHeading>
    <div className="section-label"><span>{deleted ? "已删除字典" : "共享配置与访问凭据"}</span>
      <Button variant="outline" size="sm" aria-pressed={deleted} onClick={() => { setDeleted(value => !value); setCursor(""); }}>{deleted ? "返回正常字典" : "已删除"}</Button>
      <Select value={kind} onValueChange={value => { setKind(value); setCursor(""); }}><SelectTrigger className="w-40" aria-label="按类型筛选"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="all">全部类型</SelectItem><SelectItem value="plain">普通字典</SelectItem><SelectItem value="encrypted">加密字典</SelectItem></SelectContent>
      </Select>
    </div>
    <ErrorNotice message={error} /><ToastNotice message={message} onDismiss={() => setMessage("")} />
    {!data ? !error && <Loading /> : data.items.length ? <div className="panel workflow-list">{data.items.map(item =>
      <div className="workflow-row" key={item.id}>
        <a className="workflow-row-link" href={`/dictionaries/${item.id}`}>
          <div className="workflow-row-icon">{item.kind === "encrypted" ? <KeyRound size={19} /> : <BookOpen size={19} />}</div>
          <div className="workflow-identity"><h2>{item.name}</h2><p>{item.kind === "encrypted" ? "加密" : "普通"}字典 · {item.keyCount} 个键</p>{item.description && <p>{item.description}</p>}</div>
          <span>{item.deletedAt != null ? "已删除" : item.kind === "encrypted" ? <span>{readinessLabels[item.readiness]} · {item.enabled ? "启用" : "禁用"}</span> : <span>{item.enabled ? "启用" : "禁用"}</span>}</span>
          <time dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleDateString("zh-CN")}</time>
        </a>
        <DeleteDictionaryButton dictionary={item} compact onDeleted={() => { setMessage(item.deletedAt != null ? "字典已彻底删除" : "字典已移入已删除列表"); reload(); }} />
      </div>)}</div> : deleted ? <div className="panel"><EmptyState title="没有已删除字典" description="删除的字典将在这里显示，可按需彻底删除。" /></div> : <div className="panel"><EmptyState title="还没有字典" description="创建共享配置字典或加密凭据字典，供工作流与脚本引用。" symbol={<CreateDictionaryDialog iconOnly onCreated={id => { window.location.href = `/dictionaries/${id}`; }} />} /></div>}
    <div className="entry-actions">{cursor && <Button variant="outline" onClick={() => setCursor("")}>返回第一页</Button>}
      {data?.nextCursor && <Button variant="outline" onClick={() => setCursor(data.nextCursor!)}>下一页字典</Button>}</div>
  </>;
}

function editText(entry: { type: string; value?: unknown }): string {
  return entry.type === "string" ? String(entry.value ?? "") : JSON.stringify(entry.value) ?? "";
}

function EntriesEditor({ detail, onOperations, onDirtyChange }: { detail: DictionaryDetail; onOperations: (operations: Operation[], label: string) => Promise<void>; onDirtyChange: (dirty: boolean) => void }) {
  const encrypted = detail.kind === "encrypted";
  const [edits, setEdits] = useState<Record<string, { type: string; value: string }>>({});
  const [removals, setRemovals] = useState<string[]>([]);
  const [newKey, setNewKey] = useState(""), [newType, setNewType] = useState("string"), [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [pending, setPending] = useState<{ operations: Operation[]; label: string; confirmationToken: string; impacts: { key: string; workflows: number; scripts: number }[] } | null>(null);
  useEffect(() => { setEdits({}); setRemovals([]); setPending(null); setError(""); setNotice(""); }, [detail.revision, detail.currentVersionId]);
  const hasEdits = Object.keys(edits).length > 0 || removals.length > 0;
  const dirty = hasEdits || !!newKey || !!newValue;
  const [query, setQuery] = useState("");
  useEffect(() => { onDirtyChange(dirty || busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const commandKey = useCommandKey();
  const parseValue = (type: string, value: string): unknown => {
    if (type === "string") return value;
    try {
      const parsed = parseStrictJson(value);
      if (type === "number" && typeof parsed !== "number" || type === "boolean" && typeof parsed !== "boolean") throw new Error();
      return parsed;
    } catch { throw new Error(type === "json" ? "JSON 文本无效或含重复键" : `${type} 值必须符合所选类型`); }
  };
  const submit = async (operations: Operation[], label: string, confirmationToken?: string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const business = { expectedRevision: detail.revision, operations };
      const result = await send<{ changed: boolean }>(`/dictionaries/${detail.id}`, { ...business, requestId: commandKey(business), ...(confirmationToken ? { confirmationToken } : {}) }, "PATCH");
      setPending(null); setEdits({}); setRemovals([]); setNewKey(""); setNewValue(""); commandKey({ cleared: true });
      setNotice(label + (result.changed ? "已保存。" : "内容无变化。"));
      await onOperations(operations, label);
    } catch (caught) {
      const failure = readError(caught);
      if (failure.details?.confirmationToken) setPending({ operations, label, confirmationToken: failure.details.confirmationToken, impacts: failure.details.impacts });
      setError(failure.message);
    } finally { setBusy(false); }
  };
  const save = async () => {
    const operations: Operation[] = [];
    try {
      for (const [key, edit] of Object.entries(edits)) {
        if (removals.includes(key)) continue;
        if (encrypted) { operations.push({ op: "set", key, type: "string", value: edit.value }); continue; }
        operations.push({ op: "set", key, type: edit.type, value: parseValue(edit.type, edit.value) });
      }
      for (const key of removals) operations.push({ op: "remove", key });
      if (newKey.trim()) {
        if (Object.hasOwn(detail.keys, newKey)) throw new Error("键名已存在，请编辑已有条目");
        operations.push({ op: "set", key: newKey, type: encrypted ? "string" : newType, value: encrypted ? newValue : parseValue(newType, newValue) });
      } else if (newValue) throw new Error("请填写新键名后再保存");
    } catch (error) { setError((error as Error).message); return; }
    if (!operations.length) { setError("没有需要保存的修改"); return; }
    await submit(operations, "条目");
  };
  const entries = Object.entries(detail.keys).sort(([a], [b]) => a.localeCompare(b)).filter(([key]) => key.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="panel dictionary-editor" aria-label="字典条目">
    <div className="panel-bar"><strong>字典条目 <span className="field-hint">{detail.keyCount}</span></strong>
      <div className="entry-actions"><span className="field-hint" role="status">{busy ? "正在保存…" : dirty ? "有未保存的修改" : "已保存"}</span>
      <Button variant="ghost" size="sm" disabled={busy || !dirty} onClick={() => { setEdits({}); setRemovals([]); setNewKey(""); setNewValue(""); setPending(null); setError(""); }}>放弃修改</Button>
      <Button size="sm" disabled={busy || !hasEdits && !newKey.trim() && !pending} onClick={() => void save()}><Save size={14} />保存修改</Button></div>
    </div>
    <div className="dictionary-search"><Input aria-label="搜索字典键" placeholder="按键名搜索…" value={query} onChange={event => setQuery(event.target.value)} /><span className="field-hint">{entries.length} / {detail.keyCount} 个键</span></div>
    <ErrorNotice message={error} />
    <ToastNotice message={notice} onDismiss={() => setNotice("")} />
    {pending && <div className="notice error" role="alert">
      <p>移除以下正在被引用的键需要确认：</p>
      <ul>{pending.impacts.map(impact => <li key={impact.key}>键 {impact.key} · {impact.workflows} 个工作流 · {impact.scripts} 个脚本</li>)}</ul>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void submit(pending.operations, pending.label, pending.confirmationToken)}>确认移除并保存</Button>
    </div>}
    <div className="dictionary-table-scroll">
    {entries.length ? <table className="dictionary-entries"><thead><tr><th scope="col">键名</th><th scope="col">{encrypted ? "密钥状态" : "类型"}</th><th scope="col">值与操作</th></tr></thead><tbody>
      {entries.map(([key, entry]) => {
        const removed = removals.includes(key);
        return <tr key={key} className={removed ? "is-removed" : ""}>
          <td><code>{key}</code></td>
          {encrypted
            ? <td className="field-hint">已设置 · 封装 {entry.type === "string" && "set" in entry && entry.set ? (entry as { keyId: string }).keyId.slice(0, 8) : "—"}…</td>
            : <td><code>{entry.type}</code></td>}
          <td className="entry-actions">
            {encrypted
              ? <><label><input type="checkbox" aria-label={`替换键 ${key}`} checked={Object.hasOwn(edits, key)} disabled={busy || removed}
                  onChange={event => setEdits(current => { const next = { ...current }; if (event.target.checked) next[key] = { type: "string", value: "" }; else delete next[key]; return next; })} />替换</label>
                {Object.hasOwn(edits, key) && <Input aria-label={`替换 ${key} 的值`} type="password" autoComplete="new-password" placeholder="允许空字符串" value={edits[key]?.value ?? ""} disabled={busy || removed}
                  onChange={event => setEdits(current => ({ ...current, [key]: { type: "string", value: event.target.value } }))} />}</>
              : <>
                <Select value={edits[key]?.type ?? (entry as { type: string }).type} disabled={busy || removed} onValueChange={value => setEdits(current => ({ ...current, [key]: { type: value, value: edits[key]?.value ?? editText(entry) } }))}>
                  <SelectTrigger className="w-28" aria-label={`${key} 的类型`}><SelectValue /></SelectTrigger>
                  <SelectContent>{["string", "number", "boolean", "json"].map(type => <SelectItem value={type} key={type}>{type}</SelectItem>)}</SelectContent>
                </Select>
                <Input aria-label={`${key} 的值`} value={edits[key]?.value ?? editText(entry)} disabled={busy || removed}
                  onChange={event => setEdits(current => ({ ...current, [key]: { type: edits[key]?.type ?? (entry as { type: string }).type, value: event.target.value } }))} />
              </>}
            <Button variant="ghost" size="sm" disabled={busy} aria-label={removed ? `恢复键 ${key}` : `移除键 ${key}`} onClick={() => setRemovals(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key])}>
              {removed ? <Undo2 size={14} /> : <Trash2 size={14} />}
            </Button>
          </td>
        </tr>;
      })}
    </tbody></table> : <div className="dictionary-empty"><BookOpen size={28} /><strong>{query.trim() ? "没有匹配的键" : "还没有条目"}</strong><p>{query.trim() ? "尝试其他键名，或清空搜索条件。" : "在下方填写键名和值，添加第一个配置条目。"}</p>{query.trim() && <Button variant="outline" size="sm" onClick={() => setQuery("")}>清空搜索</Button>}</div>}
    </div>
    <div className="dictionary-add-label">添加条目<span className="field-hint">{encrypted ? "敏感值仅写入，不可回读" : "键名以字母开头，支持数字、下划线和短横线"}</span></div>
    <div className="entry-add">
      <Input aria-label="新键名" placeholder="键名（字母开头，字母/数字/_/-）" value={newKey} disabled={busy} onChange={event => setNewKey(event.target.value)} />
      {encrypted
        ? <Input aria-label="新键的值" type="password" autoComplete="new-password" value={newValue} disabled={busy} onChange={event => setNewValue(event.target.value)} />
        : <>
          <Select value={newType} onValueChange={setNewType}><SelectTrigger className="w-28" aria-label="新键的类型"><SelectValue /></SelectTrigger>
            <SelectContent>{["string", "number", "boolean", "json"].map(type => <SelectItem value={type} key={type}>{type}</SelectItem>)}</SelectContent></Select>
          <Input aria-label="新键的值" value={newValue} disabled={busy} onChange={event => setNewValue(event.target.value)} />
        </>}
      <Button variant="outline" size="sm" disabled={busy || !newKey.trim()} onClick={() => void save()}><Plus size={14} />{hasEdits ? "添加并保存修改" : "添加键"}</Button>
    </div>
    {encrypted && <p className="page-footnote">编辑时输入的值保存后即被清空，不会回填；密文不可回读明文。</p>}
  </section>;
}

function DictionaryMetadata({ detail, onDone, locked }: { detail: DictionaryDetail; onDone: () => void; locked: boolean }) {
  const [name, setName] = useState(detail.name), [description, setDescription] = useState(detail.description);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const commandKey = useCommandKey();
  useEffect(() => { setName(detail.name); setDescription(detail.description); }, [detail.revision, detail.name, detail.description]);
  const save = async () => {
    const input = { expectedRevision: detail.revision, name: name.trim(), description, operations: [] };
    setBusy(true); setError("");
    try { await send(`/dictionaries/${detail.id}`, { ...input, requestId: commandKey(input) }, "PATCH"); onDone(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  return <section className="panel dictionary-panel" aria-label="字典信息"><div className="panel-bar"><strong>字典信息</strong></div>
    <div className="dictionary-form"><label htmlFor="dictionary-edit-name">字典名称</label><Input id="dictionary-edit-name" maxLength={100} value={name} onChange={event => setName(event.target.value)} disabled={busy || locked} />
      <label htmlFor="dictionary-edit-description">说明（不承诺保密）</label><Input id="dictionary-edit-description" maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} disabled={busy || locked} />
      <ErrorNotice message={error} /><Button variant="outline" disabled={busy || locked || !name.trim() || name === detail.name && description === detail.description} onClick={() => void save()}>保存字典信息</Button></div>
  </section>;
}

function ReEncryptPanel({ detail, onDone }: { detail: DictionaryDetail; onDone: () => void }) {
  const [preview, setPreview] = useState<{ token: string; willReEncrypt: number; alreadyMatched: number; targetKeyId: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const start = async () => {
    setBusy(true); setError(""); setNotice("");
    try { setPreview(await send(`/dictionaries/${detail.id}/re-encryption-preview`, { expectedRevision: detail.revision })); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const execute = async () => {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const result = await send<{ changed: boolean; reEncrypted: number }>(`/dictionaries/${detail.id}/re-encrypt`, { requestId: requestId(), token: preview.token, expectedRevision: detail.revision });
      setPreview(null);
      setNotice(result.changed ? `已用活动密钥重新加密 ${result.reEncrypted} 个条目。` : "全部条目已使用活动密钥，无需重新加密。");
      onDone();
    } catch (error) { setError((error as Error).message); setPreview(null); } finally { setBusy(false); }
  };
  return <section className="panel" aria-label="重新加密">
    <div className="panel-bar"><strong>重新加密</strong><Button variant="outline" size="sm" disabled={busy} onClick={() => void start()}><ShieldCheck size={14} />按活动密钥预览</Button></div>
    <ErrorNotice message={error} />
    <ToastNotice message={notice} onDismiss={() => setNotice("")} />
    <p className="field-hint">旧修订保持原密钥不变；预览后修改字典、切换活动密钥或配置变化都需重新预览。</p>
    {preview && <div className="notice">
      <p>目标密钥 {preview.targetKeyId.slice(0, 8)}…：将重新加密 {preview.willReEncrypt} 个条目，{preview.alreadyMatched} 个已匹配。</p>
      <Button size="sm" disabled={busy} onClick={() => void execute()}>确认重新加密</Button>
    </div>}
  </section>;
}

export function DictionaryPage({ id }: { id: string }) {
  const { data: detail, error, reload } = useResource<DictionaryDetail>(`/dictionaries/${id}`);
  const [versionCursor, setVersionCursor] = useState("");
  const [history, setHistory] = useState<{ versionNo: number; keys: DictionaryDetail["keys"] } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const versions = useResource<{ items: VersionSummary[]; nextCursor: string | null }>(`/dictionaries/${id}/versions${versionCursor ? `?cursor=${encodeURIComponent(versionCursor)}` : ""}`);
  const references = useResource<{ items: unknown[]; complete: boolean; note: string }>(`/dictionaries/${id}/references`);
  const [tab, setTab] = useState("info"), [dirty, setDirty] = useState(false);
  const [toggleOpen, setToggleOpen] = useState(false);
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState("");
  const refresh = () => { reload(); versions.reload(); };
  const toggle = async () => {
    if (!detail) return;
    setBusy(true); setActionError("");
    try { await send(`/dictionaries/${id}`, { requestId: requestId(), expectedRevision: detail.revision, enabled: !detail.enabled, operations: [] }, "PATCH"); setToggleOpen(false); refresh(); }
    catch (error) { setActionError((error as Error).message); } finally { setBusy(false); }
  };
  const viewVersion = async (versionId: string) => {
    setHistoryBusy(true); setActionError("");
    try { setHistory(await api(`/dictionaries/${id}/versions/${versionId}`)); }
    catch (error) { setActionError((error as Error).message); } finally { setHistoryBusy(false); }
  };
  const tabs = [{ id: "info", label: "字典信息" }, { id: "history", label: "修订历史" }, { id: "references", label: "引用影响" }, ...(detail?.kind === "encrypted" ? [{ id: "security", label: "密钥管理" }] : [])];
  return <div className="dictionary-desktop">
    <PageHeading parents={[{ label: "字典", href: "/dictionaries" }]} title={detail?.name ?? "字典详情"}>
      {detail && <><span className={`dictionary-state ${detail.enabled && detail.deletedAt == null ? "is-enabled" : ""}`}>{detail.deletedAt != null ? "已删除" : detail.enabled ? "已启用" : "已禁用"}</span>
        <DeleteDictionaryButton dictionary={detail} disabled={busy || dirty} onDeleted={() => { window.location.href = "/dictionaries"; }} />
        <Button variant="outline" disabled={busy || dirty || detail.deletedAt != null} onClick={() => { setActionError(""); setToggleOpen(true); }}>
          {detail.enabled ? <><Lock size={14} />禁用字典</> : <><Unlock size={14} />启用字典</>}
        </Button></>}
    </PageHeading>
    <ErrorNotice message={error || actionError} />
    {!detail ? !error && <Loading /> : <>
      <div className="dictionary-summary" role="status" aria-label="字典状态">
        <span>{detail.kind === "encrypted" ? <KeyRound size={15} /> : <BookOpen size={15} />}{detail.kind === "encrypted" ? "加密字典" : "普通字典"}</span>
        <span>{detail.keyCount} 个键</span>
        {detail.kind === "encrypted" && <span>密钥状态 <Status value={detail.readiness === "ready" ? "成功" : "失败"} /> · {readinessLabels[detail.readiness]}{detail.missingKeyIds.length > 0 && `（缺少 ${detail.missingKeyIds.join("、")}）`}</span>}
        {detail.kind === "encrypted" && detail.readiness !== "ready" && <a href="/settings?section=dictionary-keys">前往密钥设置 →</a>}
      </div>
      {detail.deletedAt != null && <div className="notice">已删除：仅供查看，不能编辑或新增引用。彻底删除会清除全部历史版本，存在历史引用或运行绑定时不可执行。</div>}
      {!detail.enabled && <div className="notice">已禁用：阻止新发布与入队引用，不改写已创建运行的绑定。</div>}
      <div className="dictionary-workspace">
        <fieldset className="dictionary-editor-fieldset" disabled={detail.deletedAt != null}><EntriesEditor key={`${detail.revision}-${detail.currentVersionId}`} detail={detail} onDirtyChange={setDirty} onOperations={async () => { refresh(); }} /></fieldset>
        <aside className="panel dictionary-inspector" aria-label="字典检查器">
          <div className="dictionary-tabs" role="tablist" aria-label="字典详情">
            {tabs.map((item, index) => <button type="button" key={item.id} id={`dictionary-tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`dictionary-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => {
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : -1;
              if (next >= 0) { event.preventDefault(); setTab(tabs[next]!.id); document.getElementById(`dictionary-tab-${tabs[next]!.id}`)?.focus(); }
            }}>{item.label}</button>)}
          </div>
          <div className="dictionary-inspector-body">
            {dirty && <p className="dictionary-lock-hint">请先保存或放弃条目修改，再更改字典信息或密钥。</p>}
            <div role="tabpanel" id="dictionary-panel-info" aria-labelledby="dictionary-tab-info" hidden={tab !== "info"}>
              <DictionaryMetadata detail={detail} locked={dirty || busy || detail.deletedAt != null} onDone={refresh} />
              <dl className="dictionary-facts"><dt>字典 ID</dt><dd><code>{detail.id}</code></dd><dt>最近更新</dt><dd>{new Date(detail.updatedAt).toLocaleString("zh-CN")}</dd><dt>创建时间</dt><dd>{new Date(detail.createdAt).toLocaleString("zh-CN")}</dd></dl>
            </div>
            <section role="tabpanel" id="dictionary-panel-history" aria-labelledby="dictionary-tab-history" hidden={tab !== "history"} aria-label="修订历史">
              <ErrorNotice message={versions.error} />
              {!versions.data ? !versions.error && <Loading /> : versions.data.items.length ? <ul className="dictionary-version-list">{versions.data.items.map(version =>
                <li key={version.id}><div><strong>v{version.versionNo}</strong>{version.id === detail.currentVersionId && <span className="dictionary-state is-enabled">当前</span>}<span className="field-hint">{version.enabled ? "启用" : "禁用"}</span><time>{new Date(version.createdAt).toLocaleString("zh-CN")}</time></div><Button variant="outline" size="sm" disabled={historyBusy} onClick={() => void viewVersion(version.id)}>查看 v{version.versionNo}</Button></li>)}</ul> : <p className="dictionary-panel-message">暂无修订历史。</p>}
              {versions.error && <Button variant="outline" size="sm" onClick={versions.reload}>重试</Button>}
              <div className="entry-actions dictionary-pagination">{versionCursor && <Button variant="outline" size="sm" onClick={() => setVersionCursor("")}>最新修订</Button>}{versions.data?.nextCursor && <Button variant="outline" size="sm" onClick={() => setVersionCursor(versions.data!.nextCursor!)}>更早修订</Button>}</div>
              <p className="page-footnote">普通条目可查看历史值；加密条目仅显示键集合与状态。</p>
            </section>
            <section role="tabpanel" id="dictionary-panel-references" aria-labelledby="dictionary-tab-references" hidden={tab !== "references"} aria-label="引用影响">
              <ErrorNotice message={references.error} />
              {references.error ? <Button variant="outline" size="sm" onClick={references.reload}>重试</Button> : !references.data ? <Loading /> : <div className="dictionary-panel-message"><strong>{references.data.complete ? "引用扫描完成" : "引用信息暂不完整"}</strong><p>{references.data.note || (references.data.complete && !references.data.items.length ? "暂无引用。" : "请在移除键时查看引用影响确认。")}</p></div>}
            </section>
            {detail.kind === "encrypted" && <section role="tabpanel" id="dictionary-panel-security" aria-labelledby="dictionary-tab-security" hidden={tab !== "security"}><fieldset disabled={dirty || busy || detail.deletedAt != null}><ReEncryptPanel key={`reencrypt-${detail.revision}`} detail={detail} onDone={refresh} /></fieldset></section>}
          </div>
        </aside>
      </div>
      <Dialog open={toggleOpen} onOpenChange={value => { if (!busy) setToggleOpen(value); }}>
        <DialogContent><DialogHeader><DialogTitle>{detail.enabled ? "禁用" : "启用"}“{detail.name}”？</DialogTitle><DialogDescription>{detail.enabled ? "禁用后将阻止新发布与入队引用，已创建运行和历史版本不受影响。" : "启用后允许新的工作流与脚本引用此字典。"}</DialogDescription></DialogHeader><ErrorNotice message={actionError} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setToggleOpen(false)}>取消</Button><Button disabled={busy} onClick={() => void toggle()}>{busy ? "正在处理…" : detail.enabled ? "确认禁用" : "确认启用"}</Button></DialogFooter></DialogContent>
      </Dialog>
      <Dialog open={!!history} onOpenChange={value => { if (!value) setHistory(null); }}>
        <DialogContent className="dictionary-history-dialog"><DialogHeader><DialogTitle>历史 v{history?.versionNo}（只读）</DialogTitle><DialogDescription>历史内容仅供查看，不会覆盖当前编辑。加密条目不展示明文。</DialogDescription></DialogHeader>
          <div className="dictionary-history-scroll" aria-label="历史修订内容">{history && Object.keys(history.keys).length ? <table className="dictionary-entries"><thead><tr><th>键名</th><th>类型</th><th>值 / 状态</th></tr></thead><tbody>{Object.entries(history!.keys).map(([key, entry]) => <tr key={key}><td><code>{key}</code>{!Object.hasOwn(detail.keys, key) && <small> · 当前已移除</small>}</td><td>{entry.type}</td><td><code>{"set" in entry ? "已设置" : JSON.stringify(entry.value)}</code></td></tr>)}</tbody></table> : <p className="dictionary-panel-message">此修订没有条目。</p>}</div>
          <DialogFooter><Button variant="outline" onClick={() => setHistory(null)}>关闭历史内容</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>}
  </div>;
}
