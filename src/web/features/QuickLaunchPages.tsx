import { formatQuickLaunchParameters, parseQuickLaunchParameters } from "../lib/quick-launch-parameters";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { BookOpen, Unlink, Plus, Search, FolderTree, Play, GitBranch, Code2, Globe, History, ChevronDown, LayoutGrid, Settings, Ellipsis, RefreshCw, X } from "lucide-react";
import { DropdownMenu, Popover } from "radix-ui";
import { Button } from "../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { ErrorNotice, PageHeading } from "../components/common";
import { requestId, send, useCommandKey, useResource } from "../lib/api";
import { replaceRoute } from "../lib/navigation";
import { CredentialDictionaryPicker } from "./BridgeCredentialInputs";
import type { InputSources, Target } from "../../quick-launch/targets";
import type { JsonSchema } from "../../domain/types";

type Group = { id: string; name: string; parentId: string | null; revision: number };
type GroupChanges = {
  onSaved: (group: Group) => void;
  onDeleted: (ids: string[]) => void;
  reloadGroups: () => void;
};
type Card = { id: string; name: string; note: string; groupId: string | null; target: Target; fixedInput: unknown; inputSources: InputSources;
  revision: number; updatedAt: number; available: boolean; confirmation: boolean; needsReferenceUpdate?: boolean; recent?: { id: string; status: string } };
type Option = { label: string; schema: JsonSchema; target: Target };
type Run = { id: string; name: string; type: string; source: string; status: string; acceptedAt: number; startedAt: number | null; endedAt: number | null;
  underlyingId: string | null; underlyingKind: string | null; snapshot: unknown; error: { message?: string } | null };
const types: Record<string, string> = { workflow: "工作流", script: "脚本", browser_tool: "浏览器工具" };
const sources: Record<string, string> = { quick_launch: "快速执行", workflow_page: "工作流", script_library: "脚本库", web_bridge: "网页桥接", legacy_unknown: "历史来源未知" };
const statuses: Record<string, string> = { accepted: "已接收", queued: "排队中", running: "运行中", succeeded: "成功", failed: "失败", start_failed: "启动失败",
  interrupted: "已中断", cancelled: "已取消", cancel_requested: "取消中", unknown: "待确认", unresolved_closed: "结果未知" };
const busyStatus = (value?: string) => ["accepted", "queued", "running", "cancel_requested", "unknown"].includes(value ?? "");
const asText = (value: unknown) => JSON.stringify(value, null, 2);
const part = (name: string) => "/" + name.replace(/~/g, "~0").replace(/\//g, "~1");

function groupPath(groups: Group[], id: string | null): string {
  if (!id) return "未分组";
  const names: string[] = [], seen = new Set<string>();
  for (let current = groups.find(group => group.id === id); current && !seen.has(current.id); current = groups.find(group => group.id === current?.parentId)) {
    seen.add(current.id);
    names.unshift(current.name);
  }
  return names.join(" / ");
}

function descendants(groups: Group[], root: string) {
  const ids = new Set([root]);
  for (let depth = 0; depth < 5; depth++) for (const group of groups)
    if (group.parentId && ids.has(group.parentId)) ids.add(group.id);
  return ids;
}

function GroupTree({ groups, value, onChange, revealSelected = false }: { groups: Group[]; value: string; onChange: (id: string) => void; revealSelected?: boolean }) {
  const [query, setQuery] = useState(""), [closed, setClosed] = useState(new Set<string>());
  const tree = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!revealSelected) return;
    const list = tree.current?.querySelector("ul");
    const row = list?.querySelector("[aria-selected=true] > .quick-tree-row");
    if (!list || !row) return;
    const bounds = list.getBoundingClientRect(), selected = row.getBoundingClientRect();
    if (selected.bottom > bounds.bottom) list.scrollTop += selected.bottom - bounds.bottom;
  }, [revealSelected]);
  const search = query.trim().toLowerCase();
  const match = (group: Group) => !search || [...descendants(groups, group.id)].some(id => groupPath(groups, id).toLowerCase().includes(search));
  function branch(parent: string | null, level: number) {
    return <ul role={level === 1 ? "tree" : "group"} className="quick-tree-list">{groups.filter(group => group.parentId === parent && match(group)).map(group => {
      const children = groups.some(child => child.parentId === group.id && match(child));
      const open = !!search || !closed.has(group.id);
      return <li key={group.id} role="treeitem" aria-level={level} aria-selected={group.id === value} aria-expanded={children ? open : undefined}>
        <div className="quick-tree-row">{children && <Button type="button" size="icon-xs" variant="ghost" disabled={!!search} aria-label={`${open ? "折叠" : "展开"} ${group.name}`} onClick={() => setClosed(old => {
          const next = new Set(old); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next;
        })}>{open ? "▾" : "▸"}</Button>}
          <Button className="quick-tree-choice" type="button" size="sm" variant={group.id === value ? "secondary" : "ghost"} onClick={() => onChange(group.id)} title={group.name}><span>{group.name}</span></Button></div>
        {children && open && branch(group.id, level + 1)}
      </li>;
    })}</ul>;
  }
  return <div ref={tree} className="quick-group-tree"><input aria-label="搜索分组" placeholder="搜索分组" value={query} onChange={e => setQuery(e.target.value)} />{branch(null, 1)}</div>;
}

function GroupFilter({ groups, value, onChange, ...changes }: GroupChanges & { groups: Group[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false), [managing, setManaging] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), openingManager = useRef(false);
  const label = value === "*" ? "全部分组" : groupPath(groups, value) || "筛选分组";
  const select = (id: string) => { onChange(id); setOpen(false); };
  return <>
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button ref={trigger} className="quick-group-trigger" variant="outline" title={label}>
          <FolderTree size={15} aria-hidden="true" /><span>{label}</span><ChevronDown size={13} aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="quick-group-popover" aria-label="筛选分组" align="start" sideOffset={4} collisionPadding={12}
          onCloseAutoFocus={event => { if (openingManager.current) event.preventDefault(); }}>
          <div className="quick-group-options">
            <Button size="sm" variant={value === "*" ? "secondary" : "ghost"} aria-pressed={value === "*"} onClick={() => select("")}>全部分组</Button>
            <GroupTree groups={groups} value={value} onChange={select} />
          </div>
          <div className="quick-group-footer">
            <Button size="icon-sm" variant="ghost" aria-haspopup="dialog" aria-label="编辑分组" title="编辑分组" onClick={() => {
              openingManager.current = true; setOpen(false); setManaging(true);
            }}><Settings size={16} aria-hidden="true" /></Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    {managing && <GroupManager groups={groups} close={() => setManaging(false)} {...changes} restoreFocus={() => {
      openingManager.current = false;
      trigger.current?.focus();
    }} />}
  </>;
}

function GroupManager({ groups, close, onSaved, onDeleted, reloadGroups, restoreFocus }: GroupChanges & { groups: Group[]; close: () => void; restoreFocus: () => void }) {
  const [current, setCurrent] = useState<Group>(), [name, setName] = useState(""), [parentId, setParent] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [destination, setDestination] = useState("");
  const [pending, setPending] = useState<"save" | "preview" | "delete">();
  const [treeRevision, setTreeRevision] = useState(0);
  const [preview, setPreview] = useState<{ descendantCount: number; cardCount: number; destinations: Group[]; previewToken: string }>();
  const nameInput = useRef<HTMLInputElement>(null), cancelDelete = useRef<HTMLButtonElement>(null);
  const saveKey = useCommandKey(), deleteKey = useCommandKey();
  const id = current?.id ?? "", busy = !!pending;
  const path = id ? `/quick-launch-groups/${id}` : "/quick-launch-groups";
  const excluded = descendants(groups, id);
  const normalizedName = name.trim().normalize("NFC");
  const changed = !current || normalizedName !== current.name || (parentId || null) !== current.parentId;
  useLayoutEffect(() => {
    if (preview) cancelDelete.current?.focus();
  }, [preview]);
  function select(group?: Group) {
    setCurrent(group); setName(group?.name ?? ""); setParent(group?.parentId ?? "");
    setPreview(undefined); setError(""); setNotice("");
  }
  async function action(kind: NonNullable<typeof pending>, task: () => Promise<void>) {
    setPending(kind); setError(""); setNotice("");
    try { await task(); } catch (e) {
      const failure = e as Error & { code?: string };
      if (failure.code === "PREVIEW_STALE") setPreview(undefined);
      if (["REVISION_CONFLICT", "NOT_FOUND", "PREVIEW_STALE"].includes(failure.code ?? "")) reloadGroups();
      setError(failure.message);
    } finally { setPending(undefined); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (busy || preview || !normalizedName || !changed) return;
    void action("save", async () => {
      const input = { name: normalizedName, parentId: parentId || null, ...(current ? { revision: current.revision } : {}) };
      const saved = await send<Group>(path, { ...input, requestId: saveKey({ path, input, treeRevision }) }, current ? "PATCH" : "POST");
      onSaved(saved);
      select(saved);
      setTreeRevision(version => version + 1);
      setNotice(current ? "分组已保存" : "分组已创建");
    });
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="quick-editor quick-group-manager" showCloseButton={!busy}
    onOpenAutoFocus={event => { event.preventDefault(); nameInput.current?.focus(); }}
    onEscapeKeyDown={event => {
      if (busy || preview) event.preventDefault();
      if (preview && !busy) setPreview(undefined);
    }} onPointerDownOutside={event => { if (busy || preview) event.preventDefault(); }}
    onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}><DialogTitle>管理分组</DialogTitle>
    <DialogDescription className="sr-only">填写表单创建分组，或从分组树中选择要编辑的分组。</DialogDescription>
    <div className="quick-group-manager-body">
      <fieldset className="quick-group-controls quick-group-manager-tree" disabled={busy || !!preview}>
        <legend className="sr-only">分组</legend>
        <GroupTree key={treeRevision} revealSelected={treeRevision > 0} groups={groups} value={id} onChange={next => select(groups.find(group => group.id === next))} />
      </fieldset>
      <div className="quick-group-manager-editor">
        {!preview && <form className="quick-form" onSubmit={save}>
          {current && <div className="quick-group-editor-heading">
            <h3>编辑分组</h3>
            <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => { select(); nameInput.current?.focus(); }}>返回创建</Button>
          </div>}
          <fieldset className="quick-group-controls" disabled={busy}>
            <label>名称<input ref={nameInput} value={name} onChange={e => { setName(e.target.value); setNotice(""); }} /></label>
            <label>父分组<select value={parentId} onChange={e => { setParent(e.target.value); setNotice(""); }}><option value="">顶层分组</option>
              {groups.filter(group => !excluded.has(group.id)).map(group => <option key={group.id} value={group.id}>{groupPath(groups, group.id)}</option>)}</select></label>
          </fieldset>
          <DialogFooter>
            {current && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void action("preview", async () => {
              setPreview(await send(`${path}/deletion-preview`)); setDestination("");
            })}>{pending === "preview" ? "正在检查…" : "删除分组"}</Button>}
            <Button type="submit" size="sm" disabled={busy || !normalizedName || !changed}>{pending === "save" ? "正在保存…" : current ? "保存修改" : "创建分组"}</Button>
          </DialogFooter>
        </form>}
        {preview && <div className="quick-form"><p className="quick-group-delete-summary">将删除此分组及 {preview.descendantCount} 个子分组，并迁移 {preview.cardCount} 张卡片。</p>
          <label>迁移至<select disabled={busy} value={destination} onChange={e => setDestination(e.target.value)}><option value="">未分组</option>
            {preview.destinations.map(group => <option key={group.id} value={group.id}>{groupPath(groups, group.id)}</option>)}</select></label>
          <DialogFooter>
            <Button ref={cancelDelete} variant="ghost" size="sm" disabled={busy} onClick={() => setPreview(undefined)}>取消删除</Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void action("delete", async () => {
              const input = { destinationGroupId: destination || null, previewToken: preview.previewToken };
              const result = await send<{ deletedGroupIds?: string[] }>(path, { ...input, requestId: deleteKey({ path, input }) }, "DELETE");
              onDeleted(result.deletedGroupIds ?? [...excluded]);
              select();
              setTreeRevision(version => version + 1);
              setNotice("分组已删除");
            })}>{pending === "delete" ? "正在删除…" : "迁移并删除"}</Button>
          </DialogFooter>
        </div>}
        <ErrorNotice message={error} />
        {notice && <p className="quick-group-status" role="status">{notice}</p>}
      </div>
    </div>
  </DialogContent></Dialog>;
}

function CardEditor({ card, groups, close, reload }: { card?: Card; groups: Group[]; close: () => void; reload: () => void }) {
  const options = useResource<{ items: Option[] }>("/quick-launch-targets");
  const [name, setName] = useState(card?.name ?? ""), [note, setNote] = useState(card?.note ?? "");
  const [groupId, setGroupId] = useState(card?.groupId ?? ""), [target, setTarget] = useState(card ? JSON.stringify(card.target) : "");
  const [json, setJson] = useState(asText(card ? card.fixedInput : {})), [bindings, setBindings] = useState<InputSources>(card?.inputSources ?? {});
  const [jsonDraft, setJsonDraft] = useState<string>();
  const [mode, setMode] = useState<"form" | "json">("form"), [field, setField] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [groupPicker, setGroupPicker] = useState(false);
  const [invalidFields, setInvalidFields] = useState<Set<string>>(new Set());
  const [timeout, setTimeoutValue] = useState(card?.target.kind === "browser_tool" ? String(card.target.timeoutMs) : "");
  const [credentials, setCredentials] = useState(card?.target.kind === "browser_tool" ? asText(card.target.credentialBindings ?? {}) : "{}");
  let selectedTarget: Target | undefined;
  try { selectedTarget = JSON.parse(target) as Target; } catch { /* No selection. */ }
  const selected = options.data?.items.find(item => {
    if (item.target.kind !== "browser_tool" || selectedTarget?.kind !== "browser_tool") return JSON.stringify(item.target) === target;
    return item.target.contractDigest === selectedTarget.contractDigest && item.target.environmentId === selectedTarget.environmentId;
  });
  const schema = selected?.schema;
  const properties = typeof schema === "object" && schema.type === "object" && !schema.$ref && !schema.oneOf && !schema.anyOf && !schema.allOf ?
    schema.properties as Record<string, { type?: string; title?: string }> | undefined : undefined;
  const jsonText = jsonDraft ?? formatQuickLaunchParameters(JSON.parse(json), bindings);
  let parsedJson: ReturnType<typeof parseQuickLaunchParameters> | undefined;
  try { parsedJson = parseQuickLaunchParameters(jsonText); } catch { /* Keep invalid JSON available for editing. */ }
  const input = JSON.parse(json);
  const values = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  const form = mode === "form" && !!properties && !!values && jsonDraft === undefined;
  const canForm = !!properties && (form || (!!parsedJson?.fixedInput && typeof parsedJson.fixedInput === "object" && !Array.isArray(parsedJson.fixedInput)));
  function switchToForm() {
    if (!parsedJson || form) return;
    setJson(asText(parsedJson.fixedInput));
    setBindings(parsedJson.inputSources);
    setJsonDraft(undefined);
    setMode("form");
    setError("");
  }
  function bind(ref?: InputSources[string], key = field) {
    const next = { ...bindings };
    if (ref) {
      next[part(key)] = ref;
      const input = { ...values }; delete input[key]; setJson(asText(input));
    } else delete next[part(key)];
    setBindings(next); setInvalidFields(old => { const next = new Set(old); next.delete(key); return next; }); setField("");
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (!selected) throw new Error("请选择执行目标");
      if (form && invalidFields.size) throw new Error("请修正表单中的 JSON 值");
      const parameters = form ? { fixedInput: input, inputSources: bindings } : parseQuickLaunchParameters(jsonText);
      await send(card ? `/quick-launches/${card.id}` : "/quick-launches", {
        name, note, groupId: groupId || null, target: selected.target.kind === "browser_tool" ? {
          ...selected.target, timeoutMs: timeout ? Number(timeout) : selected.target.timeoutMs,
          ...(credentials.trim() === "{}" ? {} : { credentialBindings: JSON.parse(credentials) })
        } : selected.target, ...parameters, requestId: requestId(),
        ...(card ? { revision: card.revision } : {})
      }, card ? "PATCH" : "POST");
      reload(); close();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => !open && close()}><DialogContent className="quick-editor" style={{ backgroundColor: "var(--card)", color: "var(--foreground)" }}><DialogTitle>{card ? "编辑快捷启动" : "新建快捷启动"}</DialogTitle>
    <DialogDescription>设置执行目标与固定参数。</DialogDescription><form className="quick-form" onSubmit={save}>
      <label>名称<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>备注<textarea maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></label>
      <div><span>分组</span> <Button type="button" variant="outline" onClick={() => setGroupPicker(true)}>{groupPath(groups, groupId || null)}</Button></div>
      <label>执行目标<select required value={selected ? JSON.stringify(selected.target) : ""} onChange={e => { setTarget(e.target.value); setInvalidFields(new Set()); setTimeoutValue(""); setCredentials("{}"); }}><option value="">请选择目标</option>
        {options.data?.items.map(item => <option key={JSON.stringify(item.target)} value={JSON.stringify(item.target)}>{item.label}</option>)}</select></label>
      {selected?.target.kind === "browser_tool" && <>
        <label>执行超时（毫秒）<input type="number" min={1} max={selected.target.timeoutMs} value={timeout || selected.target.timeoutMs} onChange={e => setTimeoutValue(e.target.value)} /></label>
        <label>凭据字典引用（可选）<textarea rows={3} className="font-mono" value={credentials} onChange={e => setCredentials(e.target.value)} /></label>
      </>}
      <div className="actions"><Button type="button" disabled={!canForm} variant={form ? "secondary" : "ghost"} onClick={switchToForm}>参数表单</Button>
        <Button type="button" variant={!form ? "secondary" : "ghost"} disabled={form && invalidFields.size > 0} onClick={() => setMode("json")}>JSON</Button></div>
      {form ? Object.entries(properties!).map(([key, property]) => {
        const ref = bindings[part(key)], value = values?.[key];
        return <div key={key}><label htmlFor={`quick-parameter-${key}`}>{property.title ?? key}</label><div className="quick-input-row">
          {ref ? <Button type="button" variant="outline" onClick={() => setField(key)}>{ref.source === "dictionary" ? `字典 · ${ref.key}` : "更换为字典引用"}</Button> :
            <input key={`${key}:${JSON.stringify(value)}`} id={`quick-parameter-${key}`} defaultValue={value === undefined ? "" : property.type === "string" ? String(value) : JSON.stringify(value)}
              onBlur={e => {
                const raw = e.target.value, next = { ...values };
                try {
                  if (!raw && property.type !== "string") delete next[key];
                  else Object.defineProperty(next, key, { value: property.type === "string" ? raw : JSON.parse(raw), enumerable: true, configurable: true, writable: true });
                  setJson(asText(next)); setError("");
                  setInvalidFields(old => { const next = new Set(old); next.delete(key); return next; });
                } catch { setInvalidFields(old => new Set(old).add(key)); setError(`${key}：请输入有效 JSON 值`); }
              }} />}
          <Button type="button" variant="ghost" size="icon" aria-label={ref ? "解除引用" : "引入字典"} onClick={() => ref ? bind(undefined, key) : setField(key)}>
            {ref ? <Unlink size={15} /> : <BookOpen size={15} />}</Button></div></div>;
      }) : <label>固定参数 JSON<textarea className="font-mono" rows={9} value={jsonText} onChange={e => setJsonDraft(e.target.value)} /><small>可复制整段 JSON 到其他卡片。字典引用包含字典 ID 和键名。</small></label>}
      {Object.entries(form ? bindings : {}).filter(([path]) => !Object.keys(properties!).some(key => part(key) === path)).map(([path, ref]) => <div className="quick-input-row" key={path}><code>{path} · {ref.source === "dictionary" ? ref.key : "待替换"}</code>
        <Button type="button" size="sm" variant="ghost" onClick={() => setBindings(old => Object.fromEntries(Object.entries(old).filter(([key]) => key !== path)))}>解除引用</Button></div>)}
      <ErrorNotice message={error || options.error} /><DialogFooter><Button type="button" variant="outline" onClick={close}>取消</Button><Button disabled={busy || !selected || (form && invalidFields.size > 0)}>保存</Button></DialogFooter>
    </form></DialogContent>
    {groupPicker && <Dialog open onOpenChange={setGroupPicker}><DialogContent><DialogTitle>选择分组</DialogTitle>
      <DialogDescription>选择快捷启动所属的分组。</DialogDescription>
      <Button variant="ghost" onClick={() => { setGroupId(""); setGroupPicker(false); }}>未分组</Button>
      <GroupTree groups={groups} value={groupId} onChange={id => { setGroupId(id); setGroupPicker(false); }} />
    </DialogContent></Dialog>}
    {field && <CredentialDictionaryPicker name={field} disabled={false}
      initialDictionaryId={bindings[part(field)]?.dictionaryId ?? ""} onClose={() => setField("")}
      acceptedTypes={properties?.[field]?.type === "integer" ? ["number", "json"] :
        properties?.[field]?.type === "object" || properties?.[field]?.type === "array" ? ["json"] :
        ["string", "number", "boolean"].includes(properties?.[field]?.type ?? "") ? [properties![field].type!, "json"] : ["string", "number", "boolean", "json"]}
      onSelect={(dictionaryId, key) => bind({ source: "dictionary", dictionaryId, key })} />}
  </Dialog>;
}

type HistoryPage = { items: Run[]; total: number; nextCursor: string | null };
const pollingStatus = (status?: string) => busyStatus(status) && status !== "unknown";
const runTime = (time: number) => new Date(time).toLocaleString("zh-CN");
const historyTime = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

function CardHistoryList({ launchId, cursor, selected, select, rememberLatest, previous, next, refresh }: {
  launchId: string; cursor: string; selected?: string; select: (run: Run) => void; refresh: number;
  rememberLatest: (run: Run | undefined) => void; previous?: () => void; next: (cursor: string) => void;
}) {
  const history = useResource<HistoryPage>(`/executions?${new URLSearchParams({ launchId, limit: "10", cursor })}`, refresh);
  useEffect(() => {
    if (!history.data?.items.some(run => pollingStatus(run.status)) || history.error) return;
    const timer = setTimeout(history.reload, 1200);
    return () => clearTimeout(timer);
  }, [history.data, history.error, refresh]);
  useEffect(() => {
    if (!cursor && history.data) rememberLatest(history.data.items[0]);
  }, [cursor, history.data, rememberLatest]);
  const items = history.data?.items ?? [], nextCursor = history.data?.nextCursor;
  return <section className="quick-history" aria-label="执行历史">
    <h3 className="quick-history-heading">执行历史{history.data ? `（${history.data.total}）` : ""}</h3>
    <ErrorNotice message={history.error} />
    {!history.data && !history.error && <p role="status">正在加载执行历史…</p>}
    {history.data?.items.length === 0 && <p>暂无执行记录</p>}
    {items.length > 0 && <select className="quick-run-picker" aria-label="选择运行记录"
      value={items.some(run => run.id === selected) ? selected : ""} onChange={event => {
        const run = items.find(item => item.id === event.target.value);
        if (run) select(run);
      }}>
      <option value="" disabled>选择运行记录</option>
      {items.map(run => <option key={run.id} value={run.id}>{runTime(run.acceptedAt)} · {statuses[run.status] ?? run.status}</option>)}
    </select>}
    <ul>{items.map(run => <li key={run.id}>
      <button type="button" className="quick-history-row" aria-pressed={run.id === selected} onClick={() => select(run)}>
        <time dateTime={new Date(run.acceptedAt).toISOString()} title={runTime(run.acceptedAt)}>{historyTime.format(run.acceptedAt)}</time>
        <span className="quick-state" data-state={run.status}>{statuses[run.status] ?? run.status}</span>
      </button>
    </li>)}</ul>
    {(previous || nextCursor) && <div className="quick-history-pagination">
      <Button size="xs" variant="ghost" disabled={!previous} onClick={previous}>上一页</Button>
      <Button size="xs" variant="ghost" disabled={!nextCursor} onClick={() => next(nextCursor!)}>下一页</Button>
    </div>}
  </section>;
}

function CardRunDetail({ initial, id, refresh }: { initial?: Run; id: string; refresh: number }) {
  const detail = useResource<Run>(`/executions/${encodeURIComponent(id)}`, refresh);
  const run = detail.data ?? initial;
  useEffect(() => {
    if (!pollingStatus(detail.data?.status) || detail.error) return;
    const timer = setTimeout(detail.reload, 1200);
    return () => clearTimeout(timer);
  }, [detail.data, detail.error, refresh]);
  const elapsed = run?.startedAt != null && run.endedAt != null ? Math.max(0, run.endedAt - run.startedAt) : null;
  return <section className="quick-run-detail" aria-label="运行详情">
    <ErrorNotice message={detail.error} />
    {run ? <>
      <div className="quick-run-summary" role="status">
        <strong className="quick-state" data-state={run.status}>{statuses[run.status] ?? run.status}</strong>
        {elapsed !== null && <span>耗时 {elapsed < 1000 ? `${elapsed} 毫秒` : `${(elapsed / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 秒`}</span>}
      </div>
      {run.error?.message && <p className="quick-run-error" role="alert">{run.error.message}</p>}
      {pollingStatus(run.status) && <p className="quick-state">关闭窗口后，执行会继续。</p>}
      <dl className="quick-run-times">
        <dt>提交时间</dt><dd>{runTime(run.acceptedAt)}</dd>
        <dt>开始时间</dt><dd>{run.startedAt === null ? "—" : runTime(run.startedAt)}</dd>
        <dt>结束时间</dt><dd>{run.endedAt === null ? "—" : runTime(run.endedAt)}</dd>
      </dl>
      {run.underlyingKind === "workflow_run" && run.underlyingId &&
        <a className="quick-run-output" href={`/runs/${encodeURIComponent(run.underlyingId)}`}>查看工作流步骤和输出</a>}
      <details className="quick-detail-disclosure"><summary>执行快照</summary><pre className="quick-json">{asText(run.snapshot)}</pre></details>
    </> : !detail.error && <p role="status">正在加载运行详情…</p>}
  </section>;
}

function CardConfigSection({ label, value }: { label: string; value: unknown }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState("");
  const json = asText(value);
  return <details className="quick-detail-disclosure">
    <summary>{label}</summary>
    <div className="quick-config-json">
      <Button variant="ghost" size="xs" aria-label={copied ? `已复制${label}` : `复制${label}`} onClick={async () => {
        setError("");
        try { await navigator.clipboard.writeText(json); setCopied(true); }
        catch { setError("无法复制，请手动选择 JSON。"); }
      }}>{copied ? "已复制" : "复制 JSON"}</Button>
      <pre className="quick-json">{json}</pre>
    </div>
    <ErrorNotice message={error} />
  </details>;
}

function CardHistoryDialog({ card, groups, initial, close, edit, copy, remove }: {
  card: Card; groups: Group[]; initial?: Run; close: () => void; edit: () => void; copy: () => Promise<void>; remove: (restoreFocus: () => void) => void;
}) {
  const [selected, select] = useState(initial);
  const rememberLatest = useCallback((run: Run | undefined) => {
    select(current => current ?? run);
  }, []);
  const [cursors, setCursors] = useState<string[]>([""]);
  const [tab, setTab] = useState("history"), [refresh, setRefresh] = useState(0);
  const [copying, setCopying] = useState(false), [copyError, setCopyError] = useState("");
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const cursor = cursors.at(-1)!;
  const run = selected;
  const runId = run?.id ?? card.recent?.id;
  const description = [card.note, groupPath(groups, card.groupId)].filter(Boolean).join(" · ");
  return <Dialog open onOpenChange={open => { if (!open && !copying) close(); }}><DialogContent className="quick-detail" showCloseButton={false}>
    <header className="quick-detail-header">
      <DialogTitle title={card.name}>{card.name}</DialogTitle>
      <div className="quick-detail-actions">
        <Button size="sm" variant="outline" onClick={edit} disabled={copying}>编辑</Button>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild><Button ref={menuTrigger} variant="ghost" size="icon-sm" aria-label="更多操作" title="更多操作" disabled={copying}><Ellipsis aria-hidden="true" /></Button></DropdownMenu.Trigger>
          <DropdownMenu.Content className="quick-detail-menu" align="end" sideOffset={4} collisionPadding={12}>
            <DropdownMenu.Item onSelect={async () => {
              setCopying(true); setCopyError("");
              try { await copy(); } catch (error) { setCopyError((error as Error).message); } finally { setCopying(false); }
            }}>复制</DropdownMenu.Item>
            <DropdownMenu.Item className="quick-detail-remove" onSelect={() => remove(() => menuTrigger.current?.focus())}>删除</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <DialogClose asChild><Button variant="ghost" size="icon-sm" aria-label="关闭" title="关闭" disabled={copying}><X aria-hidden="true" /></Button></DialogClose>
      </div>
      <DialogDescription title={description}>{description}</DialogDescription>
    </header>
    <ErrorNotice message={copyError} />
    {card.needsReferenceUpdate && <p role="status">请编辑卡片，将旧参数引用替换为字典引用。</p>}
    <Tabs className="quick-detail-tabs" value={tab} onValueChange={setTab}>
      <div className="quick-detail-toolbar">
        <TabsList aria-label="快捷启动详情"><TabsTrigger value="history">运行记录</TabsTrigger><TabsTrigger value="config">卡片配置</TabsTrigger></TabsList>
        {tab === "history" && <Button size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}><RefreshCw aria-hidden="true" />刷新</Button>}
      </div>
      <TabsContent className="quick-detail-history" value="history" forceMount>
        <div className="quick-history-grid">
          <CardHistoryList key={cursor} launchId={card.id} cursor={cursor} selected={runId} select={select} rememberLatest={rememberLatest} refresh={refresh}
            previous={cursors.length > 1 ? () => setCursors(old => old.slice(0, -1)) : undefined}
            next={next => setCursors(old => [...old, next])} />
          {runId ? <CardRunDetail key={runId} initial={run} id={runId} refresh={refresh} /> :
            <section className="quick-run-detail quick-run-placeholder" aria-label="运行详情">暂无运行详情</section>}
        </div>
      </TabsContent>
      <TabsContent className="quick-detail-config" value="config">
        <CardConfigSection label="执行目标" value={card.target} />
        <CardConfigSection label="固定参数" value={card.fixedInput} />
        <CardConfigSection label="参数来源" value={card.inputSources} />
      </TabsContent>
    </Tabs>
  </DialogContent></Dialog>;
}

export function QuickLaunchPage() {
  const cards = useResource<{ items: Card[] }>("/quick-launches"), groups = useResource<{ items: Group[] }>("/quick-launch-groups");
  const allGroups = groups.data?.items ?? [];
  const query = new URLSearchParams(window.location.search);
  const set = (key: string, value: string) => {
    if (value) query.set(key, value); else query.delete(key);
    replaceRoute(`/quick-launch${query.size ? `?${query}` : ""}`);
  };
  const requestedGroup = query.get("group") || "*";
  const group = requestedGroup === "ungrouped" || (groups.data && !allGroups.some(item => item.id === requestedGroup)) ? "*" : requestedGroup;
  const text = query.get("q") ?? "", type = query.get("type") ?? "";
  const [editing, setEditing] = useState<Card | "new">(), [detail, setDetail] = useState<{ card: Card; initial?: Run }>();
  const [confirm, setConfirm] = useState<{ card: Card; action: "run" } | { card: Card; action: "delete"; restoreFocus: () => void }>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const detailCard = cards.data?.items.find(card => card.id === detail?.card.id) ?? detail?.card;
  const allowed = descendants(allGroups, group);
  const filtered = (cards.data?.items ?? []).filter(card => {
    if (group !== "*" && (!card.groupId ||
      (query.get("descendants") === "0" ? card.groupId !== group : !allowed.has(card.groupId)))) return false;
    if (type && card.target.kind !== type) return false;
    if (query.get("availability") && card.available !== (query.get("availability") === "yes")) return false;
    const fields = { name: card.name, note: card.note, group: groupPath(allGroups, card.groupId) };
    const field = query.get("field") as keyof typeof fields | null;
    const values = field && Object.hasOwn(fields, field) ? [fields[field]] : Object.values(fields);
    return text.trim().toLowerCase().split(/\s+/).every(token => values.some(value => value.toLowerCase().includes(token)));
  }).sort((a, b) => query.get("sort") === "recent" ? b.updatedAt - a.updatedAt || a.id.localeCompare(b.id) : a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
  function reload() { cards.reload(); groups.reload(); }
  function groupSaved(saved: Group) {
    groups.setData(previous => ({
      items: [...(previous?.items ?? []).filter(item => item.id !== saved.id), saved]
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    }));
    groups.reload();
  }
  function groupsDeleted(ids: string[]) {
    const removed = new Set(ids);
    groups.setData(previous => ({ items: (previous?.items ?? []).filter(item => !removed.has(item.id)) }));
    if (removed.has(requestedGroup)) set("group", "");
    reload();
  }
  useEffect(() => {
    if (!cards.data?.items.some(card => busyStatus(card.recent?.status) && card.recent?.status !== "unknown")) return;
    const timer = setTimeout(cards.reload, 1200); return () => clearTimeout(timer);
  }, [cards.data]);
  async function execute(card: Card, confirmed = false) {
    if (card.confirmation && !confirmed) { setConfirm({ card, action: "run" }); return; }
    setBusy(true); setError("");
    try {
      const path = `/quick-launches/${card.id}`;
      const start = { requestId: requestId(), revision: card.revision };
      const token = confirmed ? (await send<{ token: string }>(path + "/confirmation", start)).token : undefined;
      const run = await send<Run>(path + "/executions", { ...start, confirmationToken: token });
      cards.reload(); setConfirm(undefined); setDetail({ card, initial: run });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="quick-workspace">
    <PageHeading title="快速执行"><Button variant="ghost" asChild><a href="/runs"><History size={15} />运行记录</a></Button><Button onClick={() => setEditing("new")}><Plus size={15} />新建快捷启动</Button></PageHeading>
    <div className="quick-toolbar quick-commandbar">
      <GroupFilter groups={allGroups} value={group} onChange={id => set("group", id)} onSaved={groupSaved} onDeleted={groupsDeleted} reloadGroups={groups.reload} />
      <label><input type="checkbox" checked={query.get("descendants") !== "0"} onChange={e => set("descendants", e.target.checked ? "" : "0")} />含子分组</label>
      <div className="quick-search"><Search size={15} aria-hidden /><input aria-label="搜索快捷启动" placeholder="搜索名称、备注或分组" value={text} onChange={e => set("q", e.target.value)} /></div>
      <select aria-label="搜索字段" value={query.get("field") ?? ""} onChange={e => set("field", e.target.value)}><option value="">全部字段</option><option value="name">名称</option><option value="note">备注</option><option value="group">分组</option></select>
      <select aria-label="执行类型" value={type} onChange={e => set("type", e.target.value)}><option value="">全部类型</option>{Object.entries(types).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select>
      <select aria-label="可用性" value={query.get("availability") ?? ""} onChange={e => set("availability", e.target.value)}><option value="">全部状态</option><option value="yes">可执行</option><option value="no">不可执行</option></select>
      <select aria-label="排序" value={query.get("sort") ?? ""} onChange={e => set("sort", e.target.value)}><option value="">按名称</option><option value="recent">最近更新</option></select>
      <Button variant="ghost" onClick={() => replaceRoute("/quick-launch")}>清除筛选</Button>
    </div>
    <ErrorNotice message={error || cards.error || groups.error} />
    <div className="quick-section-bar"><span><LayoutGrid size={14} />快捷启动</span><span aria-live="polite">{filtered.length} / {cards.data?.items.length ?? 0}</span></div>
    {!cards.data && !cards.error && <p role="status" className="quick-empty">正在加载快捷启动…</p>}
    {cards.data && !filtered.length && <div className="quick-empty"><LayoutGrid size={20} /><strong>{cards.data.items.length ? "没有匹配的快捷启动" : "还没有快捷启动"}</strong>
      {cards.data.items.length ? <Button variant="outline" onClick={() => replaceRoute("/quick-launch")}>清除筛选</Button> :
        <Button variant="outline" onClick={() => setEditing("new")}><Plus size={15} />新建快捷启动</Button>}</div>}
    <div className="quick-cards">{filtered.map(card => {
      const Icon = card.target.kind === "workflow" ? GitBranch : card.target.kind === "script" ? Code2 : Globe;
      const status = card.needsReferenceUpdate ? "需更新引用" : card.available ? statuses[card.recent?.status ?? ""] ?? "就绪" : "目标不可用";
      return <article className="quick-card" key={card.id}>
        <div className="quick-card-title"><span className="quick-kind-icon" title={types[card.target.kind]}><Icon size={15} aria-label={types[card.target.kind]} /></span>
          <button className="quick-card-name" title={card.name} onClick={() => setDetail({ card })}>{card.name}</button></div>
        <small title={card.note || groupPath(allGroups, card.groupId)}>{card.note || groupPath(allGroups, card.groupId)}</small>
        <div className="quick-card-footer"><span className="quick-state" data-state={card.available ? card.recent?.status ?? "ready" : "unavailable"}>{status}</span>
          <Button variant="outline" size="sm" disabled={!card.available || busyStatus(card.recent?.status) || busy}
            aria-label={`执行 ${card.name}`} onClick={() => void execute(card)}><Play size={13} />执行</Button></div>
      </article>;
    })}</div>
    {editing && <CardEditor card={editing === "new" ? undefined : editing} groups={allGroups} close={() => setEditing(undefined)} reload={reload} />}
    {detail && detailCard && <CardHistoryDialog key={detail.card.id} card={detailCard} groups={allGroups} initial={detail.initial}
      close={() => setDetail(undefined)}
      edit={() => { setEditing(detailCard); setDetail(undefined); }}
      copy={async () => { await send(`/quick-launches/${detail.card.id}/copy`, { requestId: requestId() }); setDetail(undefined); reload(); }}
      remove={restoreFocus => { setError(""); setConfirm({ card: detailCard, action: "delete", restoreFocus }); }} />}
    {confirm && <Dialog open onOpenChange={open => !open && !busy && setConfirm(undefined)}><DialogContent onCloseAutoFocus={event => {
      if (confirm.action === "delete") { event.preventDefault(); confirm.restoreFocus(); }
    }}><DialogTitle>{confirm.action === "delete" ? "删除快捷启动" : "确认执行"}</DialogTitle>
      <DialogDescription>{confirm.action === "delete" ? `删除「${confirm.card.name}」后，其运行记录仍可查看。` : `执行「${confirm.card.name}」可能对目标环境产生变更。`}</DialogDescription>
      {confirm.action === "run" && <pre className="quick-json">{asText({ target: confirm.card.target, input: confirm.card.fixedInput, references: confirm.card.inputSources })}</pre>}
      <ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirm(undefined)}>取消</Button>
      <Button disabled={busy} onClick={() => {
        if (confirm.action === "run") void execute(confirm.card, true);
        else {
          setBusy(true); setError("");
          void send(`/quick-launches/${confirm.card.id}`, { revision: confirm.card.revision, requestId: requestId() }, "DELETE")
            .then(() => { setConfirm(undefined); setDetail(undefined); reload(); }).catch(e => setError(e.message)).finally(() => setBusy(false));
        }
      }}>确认</Button></DialogFooter></DialogContent></Dialog>}
  </section>;
}

export function ExecutionHistoryPage() {
  const filters = new URLSearchParams(window.location.search);
  const result = useResource<{ items: Run[]; total: number; nextCursor: string | null }>(`/executions?${filters}`);
  const [selected, setSelected] = useState<string>(), [error, setError] = useState(""), [reason, setReason] = useState("");
  const detail = useResource<Run>(selected ? `/executions/${selected}` : undefined);
  const run = detail.data?.id === selected ? detail.data : undefined;
  function filter(key: string, value: string) {
    if (key !== "cursor") filters.delete("cursor");
    if (value) filters.set(key, value); else filters.delete(key);
    replaceRoute(`/runs${filters.size ? `?${filters}` : ""}`);
  }
  useEffect(() => {
    if (!result.data?.items.some(item => busyStatus(item.status) && item.status !== "unknown")) return;
    const timer = setTimeout(() => { result.reload(); if (selected) detail.reload(); }, 1200);
    return () => clearTimeout(timer);
  }, [result.data, selected]);
  return <><PageHeading title="运行记录"><Button variant="outline" onClick={result.reload}>刷新</Button></PageHeading>
    <div className="quick-toolbar"><input aria-label="搜索运行" placeholder="名称或运行 ID" value={filters.get("q") ?? ""} onChange={e => filter("q", e.target.value)} />
      {([[ "type", "类型", types ], ["source", "来源", sources], ["status", "状态", statuses]] as const).map(([key, label, options]) =>
        <select key={key} aria-label={label} value={filters.get(key) ?? ""} onChange={e => filter(key, e.target.value)}><option value="">全部{label}</option>
          {Object.entries(options).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>)}
      {(["from", "to"] as const).map(key => <label key={key}>{key === "from" ? "从" : "至"}
        <input type="datetime-local" aria-label={key === "from" ? "提交时间起点" : "提交时间终点"}
          onChange={e => filter(key, e.target.value ? String(new Date(e.target.value).getTime()) : "")} /></label>)}
      <Button variant="ghost" onClick={() => replaceRoute("/runs")}>清除筛选</Button></div>
    <ErrorNotice message={error || result.error} />
    <div className="panel quick-table"><table><thead><tr><th>名称</th><th>类型</th><th>来源</th><th>状态</th><th>提交时间</th><th>耗时</th></tr></thead>
      <tbody>{result.data?.items.map(item => <tr key={item.id}><td><button className="quick-card-name" onClick={() => { setSelected(item.id); setReason(""); }}>{item.name}</button></td>
        <td>{types[item.type]}</td><td>{sources[item.source] ?? item.source}</td><td>{statuses[item.status] ?? item.status}</td>
        <td>{new Date(item.acceptedAt).toLocaleString("zh-CN")}</td><td>{item.startedAt !== null && item.endedAt !== null ? `${Math.max(0, item.endedAt - item.startedAt)} ms` : "—"}</td></tr>)}</tbody></table></div>
    <div className="quick-toolbar"><span>{result.data?.total ?? 0} 条记录</span>{filters.has("cursor") && <Button variant="outline" onClick={() => filter("cursor", "")}>返回首页</Button>}
      {result.data?.nextCursor && <Button variant="outline" onClick={() => filter("cursor", result.data?.nextCursor ?? "")}>下一页</Button>}</div>
    {selected && <Dialog open onOpenChange={open => !open && setSelected(undefined)}><DialogContent><DialogTitle>{run?.name ?? "运行详情"}</DialogTitle>
      <DialogDescription>{run ? statuses[run.status] : "正在加载运行详情"}</DialogDescription>
      <ErrorNotice message={detail.error || run?.error?.message || error} />
      {run && <><pre className="quick-json">{asText(run.snapshot)}</pre>
        {run.underlyingKind === "workflow_run" && <a href={`/runs/${encodeURIComponent(run.underlyingId ?? "")}`}>查看工作流运行详情</a>}
        {run.underlyingKind === "script_test" && <a href="/scripts">打开脚本库</a>}
        {run.status === "unknown" && <label>结束追踪原因<input value={reason} onChange={e => setReason(e.target.value)} /></label>}
        <DialogFooter>{["queued", "running"].includes(run.status) && <Button variant="outline" onClick={() =>
          void send(`/executions/${run.id}/cancel`).then(() => { detail.reload(); result.reload(); }).catch(e => setError(e.message))}>取消运行</Button>}
          {run.status === "unknown" && <Button variant="outline" disabled={!reason.trim()} onClick={() =>
            void send(`/executions/${run.id}/end-tracking`, { reason }).then(() => { detail.reload(); result.reload(); }).catch(e => setError(e.message))}>确认结束追踪</Button>}</DialogFooter>
      </>}</DialogContent></Dialog>}
  </>;
}
