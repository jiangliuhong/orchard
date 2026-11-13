import { useEffect, useId, useRef, useState } from "react";
import type { ScriptVersion } from "../../domain/types.js";
import { captureScriptInput, dictionarySources, normalizeScriptInputSources, stripReferencedInput, type ScriptInputSources } from "../../domain/script-test-input.js";
import { parseStrictJson } from "../../dictionaries/canonical.js";
import type { HistorySources } from "../../web-bridge/history-policy.js";
import { api, pretty, send, useCommandKey, useResource } from "../lib/api";
import { ErrorNotice, Loading, Payload, Status } from "../components/common";
import { Button } from "../components/ui/button";
import { DictionaryExecutionMetadata, RedactedPayload, isRedacted, type RedactionFlags } from "./DictionaryEditors";
import { ScriptCleanup, ScriptReferences } from "./ScriptVersionPanels";
import { ScriptTestParameters } from "./ScriptTestParameters";
import type { ScriptDetail } from "./ScriptPages";

interface ScriptTest extends RedactionFlags {
  id: string; status: string; draftRevision: number | null; scriptVersionId: string | null;
  input: unknown; output?: unknown; stdout?: unknown; stderr?: unknown; error?: { code: string; message: string };
  inputArtifactId?: string; reusableInput?: unknown; reusableInputArtifactId?: string; inputSources?: HistorySources; legacyInput?: boolean;
  exitCode: number | null; durationMs: number | null; createdAt: number;
}
const tabs = [{ id: "parameters", label: "运行参数" }, { id: "results", label: "运行结果" }, { id: "references", label: "引用" }] as const;
type InspectorTab = typeof tabs[number]["id"];

export function ScriptRunInspector({ script, version, disabled, suggestedInput, externalRefresh, onTestsChanged }: {
  script: ScriptDetail; version: ScriptVersion; disabled: boolean; suggestedInput?: { value: unknown; key: number };
  externalRefresh?: number; onTestsChanged?: () => void;
}) {
  const prefix = useId(), [tab, setTab] = useState<InspectorTab>("parameters");
  const [input, setInput] = useState("{}"), [tests, setTests] = useState<ScriptTest[]>([]), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0), [selected, setSelected] = useState("");
  const [sources, setSources] = useState<ScriptInputSources>({}), [missing, setMissing] = useState<HistorySources>({});
  const [parametersInvalid, setParametersInvalid] = useState(false), [inputGeneration, setInputGeneration] = useState(0), [reuseNotice, setReuseNotice] = useState("");
  const [offset, setOffset] = useState(0), [total, setTotal] = useState(0), [submission, setSubmission] = useState(0);
  const commandKey = useCommandKey();
  const selectTab = (next: InspectorTab, focus = false) => {
    setTab(next);
    if (focus) document.getElementById(`${prefix}-tab-${next}`)?.focus();
  };
  useEffect(() => {
    if (!suggestedInput) return;
    setInput(pretty(suggestedInput.value)); setSources({}); setMissing({}); setInputGeneration(value => value + 1);
    setReuseNotice("已载入 Agent 建议输入，请核对后手动运行。"); setTab("parameters");
  }, [suggestedInput]);
  useEffect(() => { setSelected(""); setOffset(0); }, [externalRefresh]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await api<{ items: ScriptTest[]; total: number; activeCount: number }>(`/scripts/${script.id}/tests?offset=${offset}&limit=20`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setTests(result.items); setTotal(result.total);
        if (result.activeCount) timer = setTimeout(() => void load(), 750);
      } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [script.id, refresh, offset, externalRefresh]);
  const run = async () => {
    setBusy(true); setError("");
    let safeInput: ReturnType<typeof captureScriptInput> | undefined;
    try {
      const references = normalizeScriptInputSources(sources, version.inputSchema);
      const value = { input: stripReferencedInput(parseStrictJson(input, { maxDepth: 100 }), references), inputSources: references, ...(version.status === "published" ? { scriptVersionId: version.id } : { draftRevision: version.revision }) };
      safeInput = captureScriptInput(value.input, version.inputSchema, references);
      const test = await send<ScriptTest>(`/scripts/${script.id}/tests`, { ...value, requestId: commandKey({ value, submission }) });
      setSelected(test.id); setOffset(0); setRefresh(value => value + 1); setSubmission(value => value + 1);
      selectTab("results", true); onTestsChanged?.();
    } catch (failure) { setError((failure as Error).message); } finally {
      setBusy(false);
      if (safeInput?.transient) {
        commandKey({ cleared: true, submission });
        setInput(pretty(safeInput.input ?? (typeof version.inputSchema === "object" && version.inputSchema.type === "object" ? {} : null)));
        setMissing(safeInput.sources); setInputGeneration(value => value + 1);
      }
    }
  };
  const reuse = (value: unknown, historySources: HistorySources, legacy: boolean) => {
    setInput(pretty(value ?? (typeof version.inputSchema === "object" && version.inputSchema.type === "object" ? {} : null)));
    setSources(dictionarySources(historySources)); setMissing(historySources); setInputGeneration(value => value + 1); setParametersInvalid(false);
    setReuseNotice(legacy ? "旧历史来源不完整，请核对参数后手动运行。" : "已载入参数与字典引用；将使用当前 Schema 和当前字典版本，请核对后手动运行。");
    selectTab("parameters", true);
  };
  const changed = () => { setRefresh(value => value + 1); onTestsChanged?.(); };
  const resultId = selected || tests[0]?.id;
  return <aside className="panel script-inspector" aria-label="运行与引用">
    <div className="script-page-tabs" role="tablist" aria-label="运行与引用">{tabs.map((item, index) => <button type="button" key={item.id} id={`${prefix}-tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`${prefix}-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => selectTab(item.id)} onKeyDown={event => {
      const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : undefined;
      if (next) { event.preventDefault(); selectTab(next.id, true); }
    }}>{item.label}</button>)}</div>
    <section className="script-parameters-tab" role="tabpanel" id={`${prefix}-panel-parameters`} aria-labelledby={`${prefix}-tab-parameters`} hidden={tab !== "parameters"}>
      <div className="script-parameters-scroll"><p className="field-hint">使用已保存的 v{version.number}{version.status === "draft" ? ` 草稿修订 ${version.revision}` : ""}，测试会实际执行脚本。</p>
        <ScriptTestParameters schema={version.inputSchema} value={input} sources={sources} onChange={setInput} onSources={setSources} disabled={disabled || busy} onInvalidChange={setParametersInvalid} resetKey={inputGeneration} missing={missing} />
        {reuseNotice && <p className="field-hint" role="status">{reuseNotice}</p>}<ErrorNotice message={error} />
      </div><div className="script-run-actions"><Button disabled={disabled || busy || parametersInvalid} onClick={() => void run()}>{busy ? "正在提交…" : "运行测试"}</Button></div>
    </section>
    <section className="script-results-tab" role="tabpanel" id={`${prefix}-panel-results`} aria-labelledby={`${prefix}-tab-results`} hidden={tab !== "results"}>
      <div className="script-history-toolbar"><label htmlFor={`${prefix}-history`}>测试历史</label><select id={`${prefix}-history`} value={resultId ?? ""} onChange={event => setSelected(event.target.value)}>
        {!tests.length && !selected && <option value="">暂无测试</option>}{selected && !tests.some(test => test.id === selected) && <option value={selected}>刚提交的测试</option>}
        {tests.map(test => <option key={test.id} value={test.id}>{new Date(test.createdAt).toLocaleString("zh-CN")} · {test.status} · {test.scriptVersionId ? `版本 ${test.scriptVersionId.slice(0, 8)}` : `草稿修订 ${test.draftRevision}`}</option>)}
      </select><div className="actions"><Button variant="outline" disabled={!offset} onClick={() => { setSelected(""); setOffset(Math.max(0, offset - 20)); }}>上一页</Button><span>{total} 条</span><Button variant="outline" disabled={offset + 20 >= total} onClick={() => { setSelected(""); setOffset(offset + 20); }}>下一页</Button></div><ErrorNotice message={error} /></div>
      {resultId ? <ScriptTestResult key={resultId} scriptId={script.id} testId={resultId} onInput={reuse} onChange={changed} /> : <div className="empty script-result-empty"><p>暂无测试结果，请在运行参数中发起测试。</p><Button variant="outline" onClick={() => selectTab("parameters", true)}>填写运行参数</Button></div>}
    </section>
    <div className="script-reference-tab" role="tabpanel" id={`${prefix}-panel-references`} aria-labelledby={`${prefix}-tab-references`} hidden={tab !== "references"}><ScriptReferences scriptId={script.id} /><ScriptCleanup scriptId={script.id} onCleaned={() => { setSelected(""); setOffset(0); changed(); }} /></div>
  </aside>;
}

function ScriptTestResult({ scriptId, testId, onInput, onChange }: {
  scriptId: string; testId: string; onInput: (input: unknown, sources: HistorySources, legacy: boolean) => void; onChange: () => void;
}) {
  const resource = useResource<ScriptTest>(`/scripts/${scriptId}/tests/${testId}`), [error, setError] = useState(""), [cancelling, setCancelling] = useState(false);
  const result = resource.data, terminalNotified = useRef(false);
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
  const active = ["queued", "running"].includes(result.status);
  const reuse = async () => {
    try {
      const value = result.reusableInputArtifactId ? await api(`/artifacts/${result.reusableInputArtifactId}`) : Object.hasOwn(result, "reusableInput") ? result.reusableInput : result.inputArtifactId ? await api(`/artifacts/${result.inputArtifactId}`) : result.input;
      onInput(value, result.inputSources ?? {}, result.legacyInput ?? true);
    } catch (failure) { setError((failure as Error).message); }
  };
  const cancel = async () => {
    setCancelling(true); setError("");
    try { await send(`/scripts/${scriptId}/tests/${testId}/cancel`); resource.reload(); onChange(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setCancelling(false); }
  };
  return <>
    <div className="script-result-summary"><div className="actions" aria-live="polite"><Status value={result.status} />{active && <Button variant="outline" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "正在取消…" : "取消测试"}</Button>}</div>
      <p className="field-hint">退出码 {result.exitCode ?? "—"} · {result.durationMs ?? "—"} ms · {result.scriptVersionId ? `版本 ${result.scriptVersionId}` : `草稿修订 ${result.draftRevision}`}</p>
      <ErrorNotice message={error || resource.error || (result.error && `${result.error.code}: ${result.error.message}`)} />
    </div>
    <div className="script-test-results" role="region" aria-label="测试结果" tabIndex={0}>
      <section className="script-business-output" aria-label="业务输出"><h3>业务输出</h3>{active ? <p className="field-hint" role="status">{result.status === "queued" ? "测试排队中…" : "脚本执行中…"}</p> : <RedactedPayload redacted={result.outputRedacted} value={result.output} />}</section>
      <details><summary>输入与参数复用</summary><RedactedPayload redacted={result.inputRedacted} value={result.input} /><Button variant="outline" disabled={result.legacyInput && (result.inputRedacted || isRedacted(result.input))} onClick={() => void reuse()}>载入参数并前往测试</Button></details>
      <details><summary>stdout</summary>{result.logsRedacted || isRedacted(result.stdout) ? <RedactedPayload redacted value={null} /> : typeof result.stdout === "string" ? <pre className="payload">{result.stdout || "—"}</pre> : <Payload value={result.stdout} />}</details>
      <details><summary>stderr</summary>{result.logsRedacted || isRedacted(result.stderr) ? <RedactedPayload redacted value={null} /> : typeof result.stderr === "string" ? <pre className="payload">{result.stderr || "—"}</pre> : <Payload value={result.stderr} />}</details>
      <DictionaryExecutionMetadata value={result} />
    </div>
  </>;
}
