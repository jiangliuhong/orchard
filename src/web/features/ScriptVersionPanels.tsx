import { lazy, Suspense, useId, useState } from "react";
import type { ScriptVersion, SourceFiles } from "../../domain/types.js";
import { pretty, send, useCommandKey, useResource } from "../lib/api";
import { ErrorNotice, Loading } from "../components/common";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import type { ScriptDetail } from "./ScriptPages";

const CodeDiffEditor = lazy(() => import("./CodeEditor").then(module => ({ default: module.CodeDiffEditor })));
export function ScriptDiff({ original, modified }: { original: SourceFiles; modified: SourceFiles }) {
  const paths = [...new Set([...Object.keys(original), ...Object.keys(modified)])].filter(path => original[path] !== modified[path]).sort();
  const [selected, setSelected] = useState("");
  const selectId = useId();
  const path = paths.includes(selected) ? selected : paths[0];
  return <div className="detail-stack">{!paths.length ? <p className="field-hint">两个快照内容一致。</p> : <>
    <label htmlFor={selectId}>变更文件（{paths.length}）</label><select id={selectId} value={path} onChange={event => setSelected(event.target.value)}>{paths.map(path => <option key={path} value={path}>{Object.hasOwn(original, path) ? Object.hasOwn(modified, path) ? "修改" : "删除" : "新增"} · {path}</option>)}</select>
    <Suspense fallback={<Loading />}><CodeDiffEditor path={path!} original={original[path!] ?? ""} modified={modified[path!] ?? ""} /></Suspense>
  </>}</div>;
}
export function versionFiles(version: { files: SourceFiles; name?: string; description?: string; entryFile: string; inputSchema: unknown; outputSchema: unknown; timeoutMs?: number; resultMode?: string }) {
  return { ...version.files, "$metadata.json": pretty({ name: version.name, description: version.description, entryFile: version.entryFile, inputSchema: version.inputSchema, outputSchema: version.outputSchema, timeoutMs: version.timeoutMs, resultMode: version.resultMode }) };
}
export function ScriptVersionCompare({ script, version }: { script: ScriptDetail; version: ScriptVersion & { files: SourceFiles } }) {
  const options = script.versions.filter(item => item.id !== version.id), [base, setBase] = useState(options.find(item => item.id === script.currentPublishedVersionId)?.id ?? options[0]?.id ?? "");
  return <details className="panel script-secondary-panel"><summary>版本差异</summary>{!options.length ? <p>暂无其他版本可比较。</p> : <><label htmlFor="script-diff-base">比较基准（左侧）</label><select id="script-diff-base" value={base} onChange={event => setBase(event.target.value)}>{options.map(item => <option key={item.id} value={item.id}>v{item.number} · {item.status}</option>)}</select><p className="field-hint">右侧为当前查看的 v{version.number}，对比已保存的快照。</p>{base && <LoadedDiff scriptId={script.id} baseId={base} version={version} />}</>}</details>;
}
function LoadedDiff({ scriptId, baseId, version }: { scriptId: string; baseId: string; version: ScriptVersion & { files: SourceFiles } }) {
  const resource = useResource<ScriptVersion & { files: SourceFiles }>(`/scripts/${scriptId}/versions/${baseId}`);
  return <><ErrorNotice message={resource.error} />{resource.data?.id === baseId ? <ScriptDiff original={versionFiles(resource.data)} modified={versionFiles(version)} /> : <Loading />}</>;
}
export function ScriptReferences({ scriptId }: { scriptId: string }) {
  const resource = useResource<{ items: { workflowId: string; workflowName: string; draftId?: string; versionId?: string; version?: number; nodeId: string; scriptVersionId: string }[] }>(`/scripts/${scriptId}/references`);
  return <details className="panel script-secondary-panel"><summary>工作流引用（{resource.data?.items.length ?? "…"}）</summary><ErrorNotice message={resource.error} />{resource.data?.items.length === 0 && <p className="field-hint">暂无工作流引用。</p>}{resource.data?.items.map(item => <p key={`${item.draftId ?? item.versionId}:${item.nodeId}`}><a href={item.draftId ? `/drafts/${item.draftId}` : `/workflows/${item.workflowId}${item.versionId ? `?versionId=${encodeURIComponent(item.versionId)}` : ""}`}>{item.workflowName} · {item.draftId ? "草稿" : `v${item.version}`} · 节点 {item.nodeId}</a><small className="field-hint"> · 脚本版本 {item.scriptVersionId.slice(0, 8)}</small></p>)}</details>;
}
export function ScriptCleanup({ scriptId, onCleaned }: { scriptId: string; onCleaned: () => void }) {
  const [keepDays, setKeepDays] = useState(30), [keepLatest, setKeepLatest] = useState(100);
  const [preview, setPreview] = useState<{ count: number; token: string }>(), [error, setError] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const commandKey = useCommandKey();
  const action = async (clean: boolean) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const policy = { keepDays, keepLatest };
      if (!clean) setPreview(await send(`/scripts/${scriptId}/cleanup/preview`, policy));
      else {
        const input = { ...policy, token: preview!.token };
        const result = await send<{ deletedTests: number; deletedArtifacts: number }>(`/scripts/${scriptId}/cleanup`, { ...input, requestId: commandKey(input) });
        setPreview(undefined); setMessage(`已清理 ${result.deletedTests} 条测试记录及 ${result.deletedArtifacts} 个未引用产物。`); onCleaned();
      }
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  return <details className="panel script-secondary-panel"><summary>测试数据保留与清理</summary><p className="field-hint">默认保留所有数据，不自动删除。手动清理只处理此脚本的历史测试及无引用产物，每批最多 1000 条；执行中的测试及仍被引用的源码、产物会保留。</p>
    <div className="script-filters"><label>保留天数<Input type="number" min={1} max={3650} value={keepDays} onChange={event => { setKeepDays(Number(event.target.value)); setPreview(undefined); }} /></label><label>至少保留最新记录数<Input type="number" min={1} max={10000} value={keepLatest} onChange={event => { setKeepLatest(Number(event.target.value)); setPreview(undefined); }} /></label><Button variant="outline" disabled={busy} onClick={() => void action(false)}>预览清理范围</Button></div>
    {preview && <div className="notice warning">将永久删除 {preview.count} 条已完成测试及其无引用产物。<Button variant="destructive" disabled={busy || !preview.count} onClick={() => void action(true)}>确认永久清理</Button></div>}<ErrorNotice message={error} />{message && <p>{message}</p>}
  </details>;
}
