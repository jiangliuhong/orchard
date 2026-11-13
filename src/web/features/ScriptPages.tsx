import { UnsavedChanges } from "../components/UnsavedChanges";
import { navigate } from "../lib/navigation";
import { ToastNotice, WorkspaceError, WorkspaceMessage } from "../components/ToastNotice";
import { DictionaryDeclarationEditor } from "./DictionaryEditors";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { ScriptVersion, ScriptView, SourceFiles } from "../../domain/types.js";
import { api, pretty, send, useCommandKey, useResource } from "../lib/api";
import { EmptyState, ErrorNotice, Loading, PageHeading, Payload, Status } from "../components/common";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { SourceTabs } from "./SourceTabs";
import { DeleteScriptButton } from "./DeleteScriptButton";
import { ScriptVersionCompare } from "./ScriptVersionPanels";
import { ScriptAgentPanel } from "./ScriptAgentPanel";
import { SchemaEditor } from "./SchemaEditor";
import { ScriptRunInspector } from "./ScriptRunInspector";
import { parseEditorSchema, processOutputSchema } from "../lib/schema-editor";


export interface ScriptDetail extends ScriptView {
  versions: ScriptVersion[];
  draft: (ScriptVersion & { files: SourceFiles }) | null;
}
const emptyFiles = (runtime: string) => runtime === "shell"
  ? { "main.sh": "read -r input\nprintf '%s\\n' \"$input\"\n" }
  : { "main.ts": "export default async function run(input: unknown) {\n  return input;\n}\n" };

function CreateScript({ copy, iconOnly = false }: { copy?: { id: string; versionId: string; name: string }; iconOnly?: boolean }) {
  const [open, setOpen] = useState(false), [id, setId] = useState(""), [name, setName] = useState(""), [runtime, setRuntime] = useState("nodejs");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const commandKey = useCommandKey();
  const create = async () => {
    setBusy(true); setError("");
    try {
      const input = copy ? { id, name, versionId: copy.versionId } : { id, name, description: "", runtime, entryFile: runtime === "shell" ? "main.sh" : "main.ts", inputSchema: true, outputSchema: true, files: emptyFiles(runtime) };
      const result = await send<{ script: ScriptView }>(copy ? `/scripts/${copy.id}/copy` : "/scripts", { ...input, requestId: commandKey(input) });
      setOpen(false);
      navigate(`/scripts/${result.script.id}`);
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  return <><Button variant={iconOnly ? "ghost" : copy ? "outline" : "default"} className={iconOnly ? "empty-symbol h-auto" : undefined} aria-label={iconOnly ? "添加脚本" : undefined} onClick={() => { setError(""); setName(copy ? `${copy.name}（副本）` : ""); setOpen(true); }}>{iconOnly ? <Plus className="size-[25px]" /> : copy ? "复制为新脚本" : "新建脚本"}</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent><DialogHeader><DialogTitle>{copy ? "复制脚本" : "新建脚本"}</DialogTitle><DialogDescription>新脚本从未发布的草稿开始，脚本 ID 创建后不能修改。</DialogDescription></DialogHeader>
      <label htmlFor="create-script-id">脚本 ID</label><Input id="create-script-id" value={id} disabled={busy} onChange={event => setId(event.target.value)} placeholder="normalize-text" />
      <span className="field-hint">以小写字母开头，支持小写字母、数字和短横线，最多 100 字符。</span>
      <label htmlFor="create-script-name">脚本名称</label><Input id="create-script-name" value={name} disabled={busy} onChange={event => setName(event.target.value)} />
      {!copy && <><label htmlFor="create-script-runtime">运行时</label><select id="create-script-runtime" value={runtime} disabled={busy} onChange={event => setRuntime(event.target.value)}><option value="nodejs">Node.js / TypeScript</option><option value="shell">Shell / Bash</option></select></>}
      <ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button disabled={busy || !id || !name} onClick={() => void create()}>{busy ? "正在创建…" : "创建草稿"}</Button></DialogFooter>
    </DialogContent></Dialog></>;
}

export function ScriptsPage() {
  const [query, setQuery] = useState(""), [runtime, setRuntime] = useState(""), [status, setStatus] = useState(""), [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ q: query, runtime, status, offset: String(offset), limit: "20" });
  const resource = useResource<{ items: (ScriptView & { publishedVersion: number | null; latestTest?: { status: string; draftRevision: number | null; scriptVersionId: string | null } | null })[]; total: number }>(`/scripts?${params}`);
  return <><PageHeading title="脚本库"><CreateScript /></PageHeading>
    <div className="script-filters"><Input aria-label="搜索脚本" placeholder="搜索名称、ID 或说明" value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }} />
      <select aria-label="筛选运行时" value={runtime} onChange={event => { setRuntime(event.target.value); setOffset(0); }}><option value="">全部运行时</option><option value="nodejs">Node.js</option><option value="shell">Shell</option></select>
      <select aria-label="筛选脚本状态" value={status} onChange={event => { setStatus(event.target.value); setOffset(0); }}><option value="">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="archived">已归档</option></select>
    </div><ErrorNotice message={resource.error} />
    {!resource.data ? <Loading /> : resource.data.items.length ? <div className="script-list">{resource.data.items.map(script => <div className="panel script-card" key={script.id}><a className="script-card-link" href={`/scripts/${script.id}`}><div><h2>{script.name}</h2><span className="field-hint">{script.id} · {script.runtime}</span><p>{script.description || "暂无说明"}</p></div><div className="detail-stack"><Status value={script.status} /><span>{script.publishedVersion ? `发布版本 v${script.publishedVersion}` : "尚未发布"}{script.currentDraftVersionId && " · 有草稿"}</span>{script.latestTest && <small>最近测试：<Status value={script.latestTest.status} /> · {script.latestTest.scriptVersionId ? `版本 ${script.latestTest.scriptVersionId.slice(0, 8)}` : `草稿修订 ${script.latestTest.draftRevision}`}</small>}<small>{new Date(script.updatedAt).toLocaleString("zh-CN")}</small></div></a><DeleteScriptButton id={script.id} name={script.name} compact onDeleted={() => { if (resource.data?.items.length === 1 && offset > 0) setOffset(Math.max(0, offset - 20)); else resource.reload(); }} /></div>)}</div> : <EmptyState title="没有匹配的脚本" description="创建脚本，或调整搜索和筛选条件。" symbol={<CreateScript iconOnly />} />}
    {resource.data && <div className="actions script-pagination"><span>共 {resource.data.total} 个脚本</span><Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</Button><Button variant="outline" disabled={offset + 20 >= resource.data.total} onClick={() => setOffset(offset + 20)}>下一页</Button></div>}
  </>;
}

export function ScriptPage({ id }: { id: string }) {
  const resource = useResource<ScriptDetail>(`/scripts/${id}`), [selected, setSelected] = useState(""), [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false), [busy, setBusy] = useState(false);
  const script = resource.data;
  if (!script) return <><PageHeading parents={[{ label: "脚本库", href: "/scripts" }]} title="脚本详情" /><ErrorNotice message={resource.error} /><Loading /></>;
  const versionId = selected || script.currentDraftVersionId || script.currentPublishedVersionId || "";
  const reload = (message = "") => { setNotice(message); setDirty(false); setSelected(""); setGeneration(value => value + 1); resource.reload(); };
  const archive = async () => {
    setBusy(true); setError("");
    try { await send(`/scripts/${id}/archive`); setArchiveOpen(false); resource.reload(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="script-desktop"><UnsavedChanges dirty={dirty} /><div className="script-page-header"><PageHeading parents={[{ label: "脚本库", href: "/scripts" }]} title={script.name}><Status value={script.status} />{versionId && <CreateScript copy={{ id, versionId, name: script.name }} />}<Button variant="outline" disabled={dirty || script.status === "archived"} onClick={() => setArchiveOpen(true)}>归档脚本</Button><DeleteScriptButton id={id} name={script.name} disabled={dirty || busy} onDeleted={() => navigate("/scripts")} /></PageHeading></div>
    <WorkspaceError message={resource.error} title="无法刷新脚本" />
    <ToastNotice message={notice} onDismiss={() => setNotice("")} />
    <div className="script-page-toolbar"><div className="script-version-picker"><label htmlFor="script-version">查看版本</label><select id="script-version" value={versionId} disabled={dirty} onChange={event => setSelected(event.target.value)}>{script.versions.map(version => <option key={version.id} value={version.id}>v{version.number} · {version.status === "draft" ? `草稿修订 ${version.revision}` : "已发布"}{version.id === script.currentPublishedVersionId ? " · 当前发布" : ""}</option>)}</select>{dirty && <span className="field-hint">未保存</span>}</div></div>
    <div className="script-three-columns"><aside className="script-agent-column" aria-label="Agent 对话">
    <ScriptAgentPanel script={script} dirty={dirty} onApplied={reload} />
    </aside><section className="script-page-workspace" aria-label="脚本信息与运行">
    {versionId && <ScriptWorkspace key={`${versionId}:${script.updatedAt}:${generation}`} script={script} versionId={versionId} onDirtyChange={setDirty} onSaved={reload} />}
    </section></div>
    <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}><DialogContent><DialogHeader><DialogTitle>归档“{script.name}”？</DialogTitle><DialogDescription>归档后禁止编辑、发布、测试及新工作流引用。历史版本和已有工作流的运行保留。</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setArchiveOpen(false)}>取消</Button><Button disabled={busy} onClick={() => void archive()}>确认归档</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

interface ScriptWorkspaceProps {
  script: ScriptDetail; versionId: string; onSaved: (message?: string) => void; onDirtyChange: (dirty: boolean) => void;
}
function ScriptWorkspace({ script, versionId, onSaved, onDirtyChange }: ScriptWorkspaceProps) {
  const resource = useResource<ScriptVersion & { files: SourceFiles }>(`/scripts/${script.id}/versions/${versionId}`);
  if (!resource.data || resource.data.id !== versionId) return <><ErrorNotice message={resource.error} /><Loading /></>;
  return <ScriptEditor script={script} version={resource.data} onSaved={onSaved} onDirtyChange={onDirtyChange} />;
}

function ScriptEditor({ script, version, onSaved, onDirtyChange }: Omit<ScriptWorkspaceProps, "versionId"> & { version: ScriptVersion & { files: SourceFiles } }) {
  const [name, setName] = useState(version.name ?? script.name), [description, setDescription] = useState(version.description ?? script.description);
  const [files, setFiles] = useState(version.files), [path, setPath] = useState(version.entryFile), [entryFile, setEntryFile] = useState(version.entryFile);
  const [inputSchema, setInputSchema] = useState(pretty(version.inputSchema)), [outputSchema, setOutputSchema] = useState(pretty(version.outputSchema)), [timeoutMs, setTimeoutMs] = useState(version.timeoutMs);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [newFile, setNewFile] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false), [resultMode, setResultMode] = useState(version.resultMode ?? (script.runtime === "shell" ? "process" : "json"));
  const [dictionaryBindings, setDictionaryBindings] = useState(version.dictionaryBindings);
  const [inputInvalid, setInputInvalid] = useState(false), [outputInvalid, setOutputInvalid] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false), [outputGeneration, setOutputGeneration] = useState(0);
  const commandKey = useCommandKey();
  const readOnly = version.status === "published" || script.status === "archived";
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await run(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    const input = {
      id: script.id, name, description, runtime: script.runtime, files, entryFile, timeoutMs, resultMode,
      ...(dictionaryBindings ? { dictionaryBindings } : version.dictionaryBindings ? { dictionaryBindings: {} } : {}),
      inputSchema: parseEditorSchema(inputSchema), outputSchema: parseEditorSchema(outputSchema),
      expectedRevision: version.revision, expectedDraftVersionId: version.id,
    };
    await api(`/scripts/${script.id}/draft`, { method: "PATCH", body: JSON.stringify({ ...input, requestId: commandKey(input) }) });
    setDirty(false); onSaved("脚本修改已保存");
  };
  return <><div className="script-workspace"><section className="panel script-editor"><div className="section-heading"><h2>v{version.number} · {version.status === "draft" ? `草稿修订 ${version.revision}` : "只读发布版本"}</h2><div className="actions">
    {!readOnly && <><Button variant="ghost" disabled={busy || !dirty} onClick={() => onSaved()}>放弃修改</Button><Button variant="outline" disabled={busy || !dirty || inputInvalid || outputInvalid} onClick={() => void action(() => save())}>保存修改</Button><Button disabled={busy || dirty || !version.validation.valid} onClick={() => setPublishOpen(true)}>发布版本</Button></>}
    {version.status === "published" && script.status !== "archived" && <Button disabled={busy} onClick={() => setRestoreOpen(true)}>{script.currentDraftVersionId ? "还原此版本…" : "复制此版本为新草稿"}</Button>}
    </div></div>
    {!publishOpen && !restoreOpen && <WorkspaceError message={error} />}
    {!version.validation.valid && <WorkspaceMessage tone="warning"
      message={version.validation.diagnostics.length ? `源码校验未通过 · ${version.validation.diagnostics.length} 条` : "源码校验未通过"}
      description={readOnly ? undefined : "可以继续编辑并保存。"} details={version.validation.diagnostics} />}
    <details className="script-settings"><summary>脚本配置 · 名称、入口、超时与 Schema</summary><fieldset disabled={readOnly || busy} className="script-fields">
      <label>名称<Input value={name} onChange={event => { setName(event.target.value); setDirty(true); }} /></label>
      <label>说明<Textarea value={description} onChange={event => { setDescription(event.target.value); setDirty(true); }} /></label>
      <label>入口文件<select value={entryFile} onChange={event => { setEntryFile(event.target.value); setDirty(true); }}>{Object.keys(files).map(file => <option key={file}>{file}</option>)}</select></label>
      <label>超时（毫秒）<Input type="number" min={1000} max={300000} value={timeoutMs} onChange={event => { setTimeoutMs(Number(event.target.value)); setDirty(true); }} /></label>
      {script.runtime === "shell" && <label>Shell 输出协议<select value={resultMode} onChange={event => { setResultMode(event.target.value as "process" | "json"); setDirty(true); }}><option value="process">进程输出：stdout / stderr / exitCode</option><option value="json">结构化 JSON：$ORCHARD_RESULT_FILE</option></select></label>}
    </fieldset><div className="script-schema-fields">
      <SchemaEditor label="输入参数" value={inputSchema} disabled={readOnly || busy} onChange={value => { setInputSchema(value); setDirty(true); }} onDirty={() => setDirty(true)} onInvalidChange={setInputInvalid} />
      {script.runtime === "shell" && <p className="field-hint">切换输出协议不会自动修改 Schema，请核对返回定义。{resultMode === "process" ? "process 固定返回 stdout、stderr、exitCode。" : "JSON 模式将业务结果写入 $ORCHARD_RESULT_FILE。"}</p>}
      {script.runtime === "shell" && resultMode === "process" && <Button type="button" variant="outline" disabled={readOnly || busy} onClick={() => setTemplateOpen(true)}>使用进程输出结构…</Button>}
      <SchemaEditor key={outputGeneration} label="返回结果" value={outputSchema} disabled={readOnly || busy} onChange={value => { setOutputSchema(value); setDirty(true); }} onDirty={() => setDirty(true)} onInvalidChange={setOutputInvalid} />
    </div><ScriptVersionCompare script={script} version={version} /></details>
    <DictionaryDeclarationEditor value={dictionaryBindings} disabled={readOnly || busy} onApply={value => { setDictionaryBindings(value); setDirty(true); }} />
    {!readOnly && <div className="script-filters"><Input aria-label="新文件路径" placeholder={script.runtime === "shell" ? "helpers.sh" : "helpers.ts"} value={newFile} onChange={event => setNewFile(event.target.value)} /><Button variant="outline" disabled={busy || !newFile} onClick={() => {
      const pattern = script.runtime === "shell" ? /^(?:[\w-]+\/)*[\w.-]+\.sh$/ : /^(?:[\w-]+\/)*[\w.-]+\.(ts|js|mjs)$/;
      if (!pattern.test(newFile) || newFile.includes("..") || Object.hasOwn(files, newFile)) { setError("文件名无效或已存在"); return; }
      setFiles({ ...files, [newFile]: "" }); setPath(newFile); setNewFile(""); setDirty(true); setError("");
    }}>添加文件</Button><Button variant="outline" disabled={busy || path === entryFile || !Object.hasOwn(files, path)} onClick={() => { const next = { ...files }; delete next[path]; setFiles(next); setPath(entryFile); setDirty(true); }}>删除当前文件</Button></div>}
    <div className="script-source"><SourceTabs files={files} path={path} onPath={setPath} onChange={readOnly || busy ? undefined : (value, selected) => { setFiles(current => ({ ...current, [selected]: value })); setDirty(true); }} /></div>
    <span className="field-hint">Node.js 默认导出函数接收并返回 JSON。Shell 从 stdin 读取输入；JSON 协议须将合法 JSON 写入 $ORCHARD_RESULT_FILE，stdout 仅作为日志。</span>
    {version.metadataSnapshot === false && <p className="field-hint">旧版本未保存名称和说明快照，此处展示当前脚本元数据；原始源码、Schema 和超时保持原版本。</p>}
  </section><ScriptRunInspector script={script} version={version} disabled={dirty || busy || script.status === "archived"} />
    <Dialog open={templateOpen} onOpenChange={setTemplateOpen}><DialogContent><DialogHeader><DialogTitle>替换返回结果 Schema？</DialogTitle><DialogDescription>使用 stdout、stderr、exitCode 的进程输出结构，现有结果定义将被替换。确认后仍需保存。</DialogDescription></DialogHeader><Payload value={processOutputSchema} /><DialogFooter><Button variant="outline" onClick={() => setTemplateOpen(false)}>取消</Button><Button disabled={readOnly || busy} onClick={() => { setOutputSchema(pretty(processOutputSchema)); setOutputGeneration(value => value + 1); setDirty(true); setTemplateOpen(false); }}>替换定义</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={publishOpen} onOpenChange={setPublishOpen}><DialogContent><DialogHeader><DialogTitle>发布脚本 v{version.number}</DialogTitle><DialogDescription>发布草稿修订 {version.revision}，校验源码后创建只读版本。已有工作流继续使用原来绑定的版本；此操作不会运行脚本。</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setPublishOpen(false)}>取消</Button><Button disabled={busy || dirty} onClick={() => void action(async () => { const input = { expectedRevision: version.revision }; await send(`/scripts/${script.id}/publish`, { ...input, requestId: commandKey(input) }); setPublishOpen(false); onSaved(); })}>确认发布</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={restoreOpen} onOpenChange={setRestoreOpen}><DialogContent><DialogHeader><DialogTitle>还原 v{version.number} 到草稿</DialogTitle><DialogDescription>{script.draft ? `将替换当前草稿修订 ${script.draft.revision} 的源码、Schema 和元数据，旧提案将因修订变化失效。` : "将创建新的可编辑草稿，保留原发布版本。"}确认后不会运行或自动发布。</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRestoreOpen(false)}>取消</Button><Button disabled={busy} onClick={() => void action(async () => {
      const input = { versionId: version.id, expectedRevision: script.draft?.revision ?? 0, expectedDraftVersionId: script.currentDraftVersionId, replaceDraft: !!script.draft };
      await send(`/scripts/${script.id}/restore`, { ...input, requestId: commandKey(input) }); setRestoreOpen(false); onSaved();
    })}>确认还原到草稿</Button></DialogFooter></DialogContent></Dialog>
  </div></>;
}
