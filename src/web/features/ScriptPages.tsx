import { useEffect, useRef, useState } from "react";
import type { JsonSchema, ScriptVersion, ScriptView, SourceFiles } from "../../domain/types.js";
import { api, pretty, requestId, send, useCommandKey, useResource } from "../lib/api";
import { BackButton, EmptyState, ErrorNotice, Loading, PageHeading, Payload, Status } from "../components/common";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { SourceTabs } from "./SourceTabs";
import { ScriptCleanup, ScriptReferences, ScriptVersionCompare } from "./ScriptVersionPanels";
import { ScriptAgentPanel } from "./ScriptAgentPanel";

export interface ScriptDetail extends ScriptView {
  versions: ScriptVersion[];
  draft: (ScriptVersion & { files: SourceFiles }) | null;
}
interface ScriptTest {
  id: string; status: string; draftRevision: number | null; scriptVersionId: string | null;
  input: unknown; output?: unknown; stdout?: unknown; stderr?: unknown; error?: { code: string; message: string };
  inputArtifactId?: string;
  exitCode: number | null; durationMs: number | null; createdAt: number;
}
const emptyFiles = (runtime: string) => runtime === "shell"
  ? { "main.sh": "read -r input\nprintf '%s\\n' \"$input\"\n" }
  : { "main.ts": "export default async function run(input: unknown) {\n  return input;\n}\n" };

function CreateScript({ copy }: { copy?: { id: string; versionId: string; name: string } }) {
  const [open, setOpen] = useState(false), [id, setId] = useState(""), [name, setName] = useState(""), [runtime, setRuntime] = useState("nodejs");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const commandKey = useCommandKey();
  const create = async () => {
    setBusy(true); setError("");
    try {
      const input = copy ? { id, name, versionId: copy.versionId } : { id, name, description: "", runtime, entryFile: runtime === "shell" ? "main.sh" : "main.ts", inputSchema: true, outputSchema: true, files: emptyFiles(runtime) };
      const result = await send<{ script: ScriptView }>(copy ? `/scripts/${copy.id}/copy` : "/scripts", { ...input, requestId: commandKey(input) });
      window.location.assign(`/scripts/${result.script.id}`);
    } catch (error) { setError((error as Error).message); setBusy(false); }
  };
  return <><Button variant={copy ? "outline" : "default"} onClick={() => { setError(""); setName(copy ? `${copy.name}（副本）` : ""); setOpen(true); }}>{copy ? "复制为新脚本" : "新建脚本"}</Button>
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
  return <><PageHeading eyebrow="SCRIPT LIBRARY" title="脚本库" description="独立编辑、测试和发布脚本，在工作流中复用固定版本。"><CreateScript /></PageHeading>
    <div className="script-filters"><Input aria-label="搜索脚本" placeholder="搜索名称、ID 或说明" value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }} />
      <select aria-label="筛选运行时" value={runtime} onChange={event => { setRuntime(event.target.value); setOffset(0); }}><option value="">全部运行时</option><option value="nodejs">Node.js</option><option value="shell">Shell</option></select>
      <select aria-label="筛选脚本状态" value={status} onChange={event => { setStatus(event.target.value); setOffset(0); }}><option value="">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="archived">已归档</option></select>
    </div><ErrorNotice message={resource.error} />
    {!resource.data ? <Loading /> : resource.data.items.length ? <div className="script-list">{resource.data.items.map(script => <a className="panel script-card" href={`/scripts/${script.id}`} key={script.id}><div><h2>{script.name}</h2><span className="field-hint">{script.id} · {script.runtime}</span><p>{script.description || "暂无说明"}</p></div><div className="detail-stack"><Status value={script.status} /><span>{script.publishedVersion ? `发布版本 v${script.publishedVersion}` : "尚未发布"}{script.currentDraftVersionId && " · 有草稿"}</span>{script.latestTest && <small>最近测试：<Status value={script.latestTest.status} /> · {script.latestTest.scriptVersionId ? `版本 ${script.latestTest.scriptVersionId.slice(0, 8)}` : `草稿修订 ${script.latestTest.draftRevision}`}</small>}<small>{new Date(script.updatedAt).toLocaleString("zh-CN")}</small></div></a>)}</div> : <EmptyState title="没有匹配的脚本" description="创建脚本，或调整搜索和筛选条件。" />}
    {resource.data && <div className="actions script-pagination"><span>共 {resource.data.total} 个脚本</span><Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</Button><Button variant="outline" disabled={offset + 20 >= resource.data.total} onClick={() => setOffset(offset + 20)}>下一页</Button></div>}
  </>;
}

export function ScriptPage({ id }: { id: string }) {
  const resource = useResource<ScriptDetail>(`/scripts/${id}`), [selected, setSelected] = useState(""), [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [testRefresh, setTestRefresh] = useState(0), [suggestedInput, setSuggestedInput] = useState<{ value: unknown; key: number }>();
  const [agentTestRefresh, setAgentTestRefresh] = useState(0);
  const [archiveOpen, setArchiveOpen] = useState(false), [busy, setBusy] = useState(false);
  const script = resource.data;
  if (!script) return <><BackButton href="/scripts" /><ErrorNotice message={resource.error} /><Loading /></>;
  const versionId = selected || script.currentDraftVersionId || script.currentPublishedVersionId || "";
  const reload = () => { setDirty(false); setSelected(""); setGeneration(value => value + 1); resource.reload(); };
  const archive = async () => {
    setBusy(true); setError("");
    try { await send(`/scripts/${id}/archive`); setArchiveOpen(false); resource.reload(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <><BackButton href="/scripts" /><PageHeading eyebrow="SCRIPT" title={script.name} description={`${script.id} · ${script.runtime}`}><Status value={script.status} />{versionId && <CreateScript copy={{ id, versionId, name: script.name }} />}<Button variant="outline" disabled={dirty || script.status === "archived"} onClick={() => setArchiveOpen(true)}>归档脚本</Button></PageHeading>
    <ErrorNotice message={error || resource.error} />
    {script.status === "archived" && <div className="notice">此脚本已归档，只读保留。已发布工作流仍使用绑定版本运行。</div>}
    <label htmlFor="script-version">查看版本</label><select id="script-version" value={versionId} disabled={dirty} onChange={event => setSelected(event.target.value)}>{script.versions.map(version => <option key={version.id} value={version.id}>v{version.number} · {version.status === "draft" ? `草稿修订 ${version.revision}` : "已发布"}{version.id === script.currentPublishedVersionId ? " · 当前发布" : ""}</option>)}</select>
    {versionId && <ScriptWorkspace key={`${versionId}:${script.updatedAt}:${generation}`} script={script} versionId={versionId} onDirtyChange={setDirty} onSaved={reload} suggestedInput={suggestedInput} testRefresh={testRefresh} onTestsChanged={() => setAgentTestRefresh(value => value + 1)} />}
    <ScriptAgentPanel script={script} dirty={dirty} onApplied={reload} testRefresh={agentTestRefresh} onTestInput={value => setSuggestedInput({ value, key: Date.now() })} />
    <ScriptReferences scriptId={id} /><ScriptCleanup scriptId={id} onCleaned={() => { setTestRefresh(value => value + 1); setAgentTestRefresh(value => value + 1); }} />
    <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}><DialogContent><DialogHeader><DialogTitle>归档“{script.name}”？</DialogTitle><DialogDescription>归档后禁止编辑、发布、测试及新工作流引用。历史版本和已有工作流的运行保留。</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setArchiveOpen(false)}>取消</Button><Button disabled={busy} onClick={() => void archive()}>确认归档</Button></DialogFooter></DialogContent></Dialog>
  </>;
}

interface ScriptWorkspaceProps {
  script: ScriptDetail; versionId: string; onSaved: () => void; onDirtyChange: (dirty: boolean) => void;
  suggestedInput?: { value: unknown; key: number }; testRefresh: number;
  onTestsChanged: () => void;
}
function ScriptWorkspace({ script, versionId, onSaved, onDirtyChange, suggestedInput, testRefresh, onTestsChanged }: ScriptWorkspaceProps) {
  const resource = useResource<ScriptVersion & { files: SourceFiles }>(`/scripts/${script.id}/versions/${versionId}`);
  if (!resource.data || resource.data.id !== versionId) return <><ErrorNotice message={resource.error} /><Loading /></>;
  return <ScriptEditor script={script} version={resource.data} onSaved={onSaved} onDirtyChange={onDirtyChange} suggestedInput={suggestedInput} testRefresh={testRefresh} onTestsChanged={onTestsChanged} />;
}

function ScriptEditor({ script, version, onSaved, onDirtyChange, suggestedInput, testRefresh, onTestsChanged }: Omit<ScriptWorkspaceProps, "versionId"> & { version: ScriptVersion & { files: SourceFiles } }) {
  const [name, setName] = useState(version.name ?? script.name), [description, setDescription] = useState(version.description ?? script.description);
  const [files, setFiles] = useState(version.files), [path, setPath] = useState(version.entryFile), [entryFile, setEntryFile] = useState(version.entryFile);
  const [inputSchema, setInputSchema] = useState(pretty(version.inputSchema)), [outputSchema, setOutputSchema] = useState(pretty(version.outputSchema)), [timeoutMs, setTimeoutMs] = useState(version.timeoutMs);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [newFile, setNewFile] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false), [resultMode, setResultMode] = useState(version.resultMode ?? (script.runtime === "shell" ? "process" : "json"));
  const commandKey = useCommandKey();
  const readOnly = version.status === "published" || script.status === "archived";
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await run(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    const input = {
      id: script.id, name, description, runtime: script.runtime, files, entryFile, timeoutMs, resultMode,
      inputSchema: JSON.parse(inputSchema) as JsonSchema, outputSchema: JSON.parse(outputSchema) as JsonSchema,
      expectedRevision: version.revision, expectedDraftVersionId: version.id,
    };
    await api(`/scripts/${script.id}/draft`, { method: "PATCH", body: JSON.stringify({ ...input, requestId: commandKey(input) }) });
    setDirty(false); onSaved();
  };
  return <><div className="script-workspace"><section className="panel script-editor"><div className="section-heading"><h2>v{version.number} · {version.status === "draft" ? `草稿修订 ${version.revision}` : "只读发布版本"}</h2><div className="actions">
    {!readOnly && <><Button variant="ghost" disabled={busy || !dirty} onClick={onSaved}>放弃修改</Button><Button variant="outline" disabled={busy || !dirty} onClick={() => void action(() => save())}>保存修改</Button><Button disabled={busy || dirty || !version.validation.valid} onClick={() => setPublishOpen(true)}>发布版本</Button></>}
    {version.status === "published" && script.status !== "archived" && <Button disabled={busy} onClick={() => setRestoreOpen(true)}>{script.currentDraftVersionId ? "还原此版本…" : "复制此版本为新草稿"}</Button>}
    </div></div><ErrorNotice message={error} />{!version.validation.valid && <div className="notice warning"><div>源码尚未通过校验，可继续编辑并保存。{version.validation.diagnostics.map((diagnostic, index) => <pre key={index}>{diagnostic}</pre>)}</div></div>}{dirty && <div className="notice">修改尚未保存。保存后才能测试、发布或切换版本；也可以放弃修改。</div>}
    <fieldset disabled={readOnly || busy} className="script-fields">
      <label>名称<Input value={name} onChange={event => { setName(event.target.value); setDirty(true); }} /></label>
      <label>说明<Textarea value={description} onChange={event => { setDescription(event.target.value); setDirty(true); }} /></label>
      <label>入口文件<select value={entryFile} onChange={event => { setEntryFile(event.target.value); setDirty(true); }}>{Object.keys(files).map(file => <option key={file}>{file}</option>)}</select></label>
      <label>超时（毫秒）<Input type="number" min={1000} max={300000} value={timeoutMs} onChange={event => { setTimeoutMs(Number(event.target.value)); setDirty(true); }} /></label>
      {script.runtime === "shell" && <label>Shell 输出协议<select value={resultMode} onChange={event => { setResultMode(event.target.value as "process" | "json"); setDirty(true); }}><option value="process">进程输出：stdout / stderr / exitCode</option><option value="json">结构化 JSON：$ORCHARD_RESULT_FILE</option></select></label>}
      <label>输入 Schema<Textarea rows={5} className="font-mono" value={inputSchema} onChange={event => { setInputSchema(event.target.value); setDirty(true); }} /></label>
      <label>输出 Schema<Textarea rows={5} className="font-mono" value={outputSchema} onChange={event => { setOutputSchema(event.target.value); setDirty(true); }} /></label>
    </fieldset>
    {!readOnly && <div className="script-filters"><Input aria-label="新文件路径" placeholder={script.runtime === "shell" ? "helpers.sh" : "helpers.ts"} value={newFile} onChange={event => setNewFile(event.target.value)} /><Button variant="outline" disabled={busy || !newFile} onClick={() => {
      const pattern = script.runtime === "shell" ? /^(?:[\w-]+\/)*[\w.-]+\.sh$/ : /^(?:[\w-]+\/)*[\w.-]+\.(ts|js|mjs)$/;
      if (!pattern.test(newFile) || newFile.includes("..") || Object.hasOwn(files, newFile)) { setError("文件名无效或已存在"); return; }
      setFiles({ ...files, [newFile]: "" }); setPath(newFile); setNewFile(""); setDirty(true); setError("");
    }}>添加文件</Button><Button variant="outline" disabled={busy || path === entryFile || !Object.hasOwn(files, path)} onClick={() => { const next = { ...files }; delete next[path]; setFiles(next); setPath(entryFile); setDirty(true); }}>删除当前文件</Button></div>}
    <div className="script-source"><SourceTabs files={files} path={path} onPath={setPath} onChange={readOnly || busy ? undefined : (value, selected) => { setFiles(current => ({ ...current, [selected]: value })); setDirty(true); }} /></div>
    <span className="field-hint">Node.js 默认导出函数接收并返回 JSON。Shell 从 stdin 读取输入；JSON 协议须将合法 JSON 写入 $ORCHARD_RESULT_FILE，stdout 仅作为日志。</span>
    {version.metadataSnapshot === false && <p className="field-hint">旧版本未保存名称和说明快照，此处展示当前脚本元数据；原始源码、Schema 和超时保持原版本。</p>}
  </section><ScriptTests script={script} version={version} disabled={dirty || busy || script.status === "archived"} suggestedInput={suggestedInput} externalRefresh={testRefresh} onTestsChanged={onTestsChanged} />
    <Dialog open={publishOpen} onOpenChange={setPublishOpen}><DialogContent><DialogHeader><DialogTitle>发布脚本 v{version.number}</DialogTitle><DialogDescription>发布草稿修订 {version.revision}，校验源码后创建只读版本。已有工作流继续使用原来绑定的版本；此操作不会运行脚本。</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setPublishOpen(false)}>取消</Button><Button disabled={busy || dirty} onClick={() => void action(async () => { const input = { expectedRevision: version.revision }; await send(`/scripts/${script.id}/publish`, { ...input, requestId: commandKey(input) }); setPublishOpen(false); onSaved(); })}>确认发布</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={restoreOpen} onOpenChange={setRestoreOpen}><DialogContent><DialogHeader><DialogTitle>还原 v{version.number} 到草稿</DialogTitle><DialogDescription>{script.draft ? `将替换当前草稿修订 ${script.draft.revision} 的源码、Schema 和元数据，旧提案将因修订变化失效。` : "将创建新的可编辑草稿，保留原发布版本。"}确认后不会运行或自动发布。</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRestoreOpen(false)}>取消</Button><Button disabled={busy} onClick={() => void action(async () => {
      const input = { versionId: version.id, expectedRevision: script.draft?.revision ?? 0, expectedDraftVersionId: script.currentDraftVersionId, replaceDraft: !!script.draft };
      await send(`/scripts/${script.id}/restore`, { ...input, requestId: commandKey(input) }); setRestoreOpen(false); onSaved();
    })}>确认还原到草稿</Button></DialogFooter></DialogContent></Dialog>
  </div><ScriptVersionCompare script={script} version={version} /></>;
}

function ScriptTests({ script, version, disabled, suggestedInput, externalRefresh, onTestsChanged }: { script: ScriptDetail; version: ScriptVersion; disabled: boolean; suggestedInput?: { value: unknown; key: number }; externalRefresh: number; onTestsChanged: () => void }) {
  const [input, setInput] = useState("{}"), [tests, setTests] = useState<ScriptTest[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState("");
  const [offset, setOffset] = useState(0), [total, setTotal] = useState(0);
  const [submission, setSubmission] = useState(0), commandKey = useCommandKey();
  useEffect(() => { if (suggestedInput) setInput(pretty(suggestedInput.value)); }, [suggestedInput]);
  useEffect(() => { setSelected(""); setOffset(0); }, [externalRefresh]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await api<{ items: ScriptTest[]; total: number; activeCount: number }>(`/scripts/${script.id}/tests?offset=${offset}&limit=20`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setTests(result.items);
        setTotal(result.total);
        if (result.activeCount) timer = setTimeout(() => void load(), 750);
      } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [script.id, refresh, offset, externalRefresh]);
  const run = async () => {
    setBusy(true); setError("");
    try {
      const value = { input: JSON.parse(input), ...(version.status === "published" ? { scriptVersionId: version.id } : { draftRevision: version.revision }) };
      const test = await send<ScriptTest>(`/scripts/${script.id}/tests`, { ...value, requestId: commandKey({ value, submission }) });
      setSelected(test.id); setOffset(0); setRefresh(value => value + 1); setSubmission(value => value + 1); onTestsChanged();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const resultId = selected || tests[0]?.id;
  return <section className="panel script-test-panel"><h2>运行测试</h2><p className="field-hint">使用已保存的 v{version.number}{version.status === "draft" ? ` 草稿修订 ${version.revision}` : ""}，测试会实际执行脚本。</p>
    <label htmlFor="script-test-input">测试输入 JSON</label><Textarea id="script-test-input" rows={7} className="font-mono" value={input} onChange={event => setInput(event.target.value)} />
    <Button disabled={disabled || busy} onClick={() => void run()}>{busy ? "正在提交…" : "运行测试"}</Button><ErrorNotice message={error} />
    <label htmlFor="script-test-history">测试历史</label><select id="script-test-history" value={resultId ?? ""} onChange={event => setSelected(event.target.value)}>{!tests.length && <option value="">暂无测试</option>}{tests.map(test => <option key={test.id} value={test.id}>{new Date(test.createdAt).toLocaleString("zh-CN")} · {test.status} · {test.scriptVersionId ? `版本 ${test.scriptVersionId.slice(0, 8)}` : `草稿修订 ${test.draftRevision}`}</option>)}</select>
    <div className="actions"><Button variant="outline" disabled={!offset} onClick={() => { setSelected(""); setOffset(Math.max(0, offset - 20)); }}>上一页</Button><span>{total} 条</span><Button variant="outline" disabled={offset + 20 >= total} onClick={() => { setSelected(""); setOffset(offset + 20); }}>下一页</Button></div>
    {resultId && <ScriptTestResult key={resultId} scriptId={script.id} testId={resultId} onInput={value => setInput(pretty(value))} onChange={() => { setRefresh(value => value + 1); onTestsChanged(); }} />}
  </section>;
}

function ScriptTestResult({ scriptId, testId, onInput, onChange }: { scriptId: string; testId: string; onInput: (input: unknown) => void; onChange: () => void }) {
  const resource = useResource<ScriptTest>(`/scripts/${scriptId}/tests/${testId}`), [error, setError] = useState("");
  const result = resource.data;
  const terminalNotified = useRef(false);
  useEffect(() => {
    if (!result) return;
    if (!["queued", "running"].includes(result.status)) {
      if (!terminalNotified.current) { terminalNotified.current = true; onChange(); }
      return;
    }
    const timer = setTimeout(resource.reload, 750);
    return () => clearTimeout(timer);
  }, [result]);
  if (!result) return <><ErrorNotice message={resource.error} /><Loading /></>;
  const reuse = async () => {
    try {
      onInput(result.inputArtifactId ? await api(`/artifacts/${result.inputArtifactId}`) : result.input);
    } catch (error) { setError((error as Error).message); }
  };
  return <><ErrorNotice message={error || resource.error} /><Status value={result.status} />{["queued", "running"].includes(result.status) && <Button variant="outline" onClick={() => void send(`/scripts/${scriptId}/tests/${testId}/cancel`).then(() => { resource.reload(); onChange(); }).catch(error => setError(error.message))}>取消测试</Button>}
    <p className="field-hint">退出码 {result.exitCode ?? "—"} · {result.durationMs ?? "—"} ms · {result.scriptVersionId ? `版本 ${result.scriptVersionId}` : `草稿修订 ${result.draftRevision}`}</p>
    <ErrorNotice message={result.error && `${result.error.code}: ${result.error.message}`} /><label>输入</label><Payload value={result.input} /><Button variant="outline" onClick={() => void reuse()}>复用此输入</Button><label>输出</label><Payload value={result.output} /><label>stdout</label>{typeof result.stdout === "string" ? <pre className="payload">{result.stdout || "—"}</pre> : <Payload value={result.stdout} />}<label>stderr</label>{typeof result.stderr === "string" ? <pre className="payload">{result.stderr || "—"}</pre> : <Payload value={result.stderr} />}
  </>;
}
