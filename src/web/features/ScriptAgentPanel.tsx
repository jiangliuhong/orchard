import { useEffect, useState } from "react";
import type { AgentChoice, ProviderView } from "../../domain/types.js";
import type { ScriptAgentService } from "../../authoring/script-agent.js";
import { api, requestId, send, useCommandKey, useResource } from "../lib/api";
import { ErrorNotice, Loading, Payload, Status } from "../components/common";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { ProviderPicker } from "./ProviderPicker";
import { ScriptDiff, versionFiles } from "./ScriptVersionPanels";
import type { ScriptDetail } from "./ScriptPages";

type AgentTurn = ReturnType<ScriptAgentService["get"]>;
type AgentHistory = ReturnType<ScriptAgentService["list"]>;

export function ScriptAgentPanel({ script, dirty, onApplied, onTestInput, testRefresh = 0 }: { script: ScriptDetail; dirty: boolean; onApplied: () => void; onTestInput: (input: unknown) => void; testRefresh?: number }) {
  const providers = useResource<{ items: ProviderView[] }>("/providers");
  const [choice, setChoice] = useState<AgentChoice>(() => { try { return JSON.parse(localStorage.getItem("orchard-workbench-agent") ?? "{}"); } catch { return {}; } });
  const [prompt, setPrompt] = useState(""), [conversationId, setConversationId] = useState(script.currentDraftVersionId ?? requestId());
  const [history, setHistory] = useState<AgentHistory>(), [selected, setSelected] = useState(""), [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [testId, setTestId] = useState("");
  const [submission, setSubmission] = useState(0);
  const tests = useResource<{ items: { id: string; status: string; createdAt: number }[] }>(`/scripts/${script.id}/tests?limit=20`);
  const commandKey = useCommandKey();
  useEffect(() => { tests.reload(); }, [testRefresh]);
  useEffect(() => {
    setConversationId(script.currentDraftVersionId ?? requestId()); setPrompt(""); setTestId("");
  }, [script.currentDraftVersionId]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await api<AgentHistory>(`/scripts/${script.id}/agent/turns?offset=${offset}&limit=10`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setHistory(result);
        if (result.activeCount) timer = setTimeout(() => void load(), 750);
      } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [script.id, offset, refresh]);
  const generate = async () => {
    setBusy(true); setError("");
    try {
      const input = { ...choice, prompt, conversationId, expectedRevision: script.draft!.revision, ...(testId ? { testId } : {}) };
      const turn = await send<AgentTurn>(`/scripts/${script.id}/agent/turns`, { ...input, requestId: commandKey({ input, submission }) });
      setSelected(turn.id); setOffset(0); setRefresh(value => value + 1); setPrompt(""); setSubmission(value => value + 1);
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const selectedId = selected || history?.items[0]?.id;
  const locked = dirty || busy || !script.draft || script.status === "archived";
  return <section className="panel script-agent-panel"><div className="section-heading"><h2>与 Agent 编辑脚本</h2><Button variant="outline" disabled={!!history?.activeCount || busy} onClick={() => { setConversationId(requestId()); setPrompt(""); }}>新对话</Button></div>
    <p className="field-hint">绑定当前脚本草稿修订 {script.draft?.revision ?? "—"} · 对话 {conversationId.slice(0, 8)}。每轮重建受限上下文，读取本脚本与选定测试；变更需预览并确认后保存，不会自动执行或发布。</p>
    <ProviderPicker providers={providers.data?.items ?? []} value={choice} disabled={locked} onChange={value => { setChoice(value); localStorage.setItem("orchard-workbench-agent", JSON.stringify(value)); }} />
    <label htmlFor="script-agent-test">引用测试结果</label><select id="script-agent-test" disabled={locked} value={testId} onChange={event => setTestId(event.target.value)}><option value="">不引用测试</option>{tests.data?.items.map(test => <option value={test.id} key={test.id}>{new Date(test.createdAt).toLocaleString("zh-CN")} · {test.status}</option>)}</select>
    <label htmlFor="script-agent-prompt">描述脚本需求或修复要求</label><Textarea id="script-agent-prompt" rows={4} value={prompt} disabled={locked} onChange={event => setPrompt(event.target.value)} placeholder="例如：增加输入校验，并生成一组测试输入…" />
    <Button disabled={locked || !!history?.activeCount || !prompt.trim() || !choice.providerId || !choice.modelId} onClick={() => void generate()}>生成变更预览</Button>
    <ErrorNotice message={error || providers.error || tests.error} />{dirty && <p className="field-hint">先保存或放弃本地修改，再向 Agent 提交需求。</p>}
    <div className="script-agent-history">{history?.items.map(turn => <button type="button" key={turn.id} className={selectedId === turn.id ? "is-active" : ""} onClick={() => { setSelected(turn.id); if (turn.draftVersionId === script.currentDraftVersionId) setConversationId(turn.conversationId); }}><Status value={turn.status} /><span>{turn.prompt.slice(0, 120)}</span><small>修订 {turn.baseRevision}{turn.appliedRevision !== null ? ` → ${turn.appliedRevision}` : ""}</small></button>)}</div>
    {history && <div className="actions"><Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 10))}>上一页</Button><span>{history.total} 条记录</span><Button variant="outline" disabled={offset + 10 >= history.total} onClick={() => setOffset(offset + 10)}>下一页</Button></div>}
    {selectedId && <ScriptAgentPreview key={selectedId} script={script} turnId={selectedId} disabled={dirty || busy || script.status === "archived"} onApplied={() => { onApplied(); setRefresh(value => value + 1); }} onTestInput={onTestInput} />}
  </section>;
}

export function ScriptAgentPreview({ script, turnId, disabled, onApplied, onTestInput }: { script: ScriptDetail; turnId: string; disabled: boolean; onApplied: () => void; onTestInput: (input: unknown) => void }) {
  const resource = useResource<AgentTurn>(`/scripts/${script.id}/agent/turns/${turnId}`);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const commandKey = useCommandKey(), turn = resource.data;
  useEffect(() => {
    if (!turn || !["queued", "running"].includes(turn.status)) return;
    const timer = setTimeout(resource.reload, 750);
    return () => clearTimeout(timer);
  }, [turn]);
  const apply = async () => {
    setBusy(true); setError("");
    try {
      const input = { turnId, expectedRevision: turn!.baseRevision };
      await send(`/scripts/${script.id}/agent/apply`, { ...input, requestId: commandKey(input) });
      setConfirm(false); resource.reload(); onApplied();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  if (!turn) return <><ErrorNotice message={resource.error} /><Loading /></>;
  const stale = script.currentDraftVersionId !== turn.draftVersionId || script.draft?.revision !== turn.baseRevision;
  const hasChanges = !!turn.proposal && (!!turn.proposal.changes.length || !!Object.keys(turn.proposal.metadata).length);
  return <div className="detail-stack"><h3>提案详情 · 修订 {turn.baseRevision}</h3><Status value={turn.status} /><ErrorNotice message={error || resource.error || turn.error?.message} />
    {["queued", "running"].includes(turn.status) && <Button variant="outline" onClick={() => void send(`/scripts/${script.id}/agent/turns/${turnId}/cancel`).then(resource.reload).catch(error => setError(error.message))}>取消生成</Button>}
    {turn.proposal && <><p>{turn.proposal.summary}</p>{turn.base && turn.candidate && <ScriptDiff original={versionFiles(turn.base)} modified={versionFiles(turn.candidate)} />}
      {!turn.validation?.valid && <div className="notice warning"><div>提案源码存在校验错误，可应用为待修复草稿。{turn.validation?.diagnostics.map((message, index) => <pre key={index}>{message}</pre>)}</div></div>}
      {Object.hasOwn(turn.proposal, "testInput") && <><label>建议测试输入</label><Payload value={turn.proposal.testInput} /><Button variant="outline" disabled={disabled} onClick={() => onTestInput(turn.proposal!.testInput)}>使用建议测试输入</Button></>}
      {turn.appliedRevision !== null ? <div className="notice success">已应用为草稿修订 {turn.appliedRevision}。</div> : stale ? <div className="notice warning">草稿已改变，此提案只读保留。请基于当前草稿重新生成。</div> : <Button disabled={disabled || busy || !hasChanges} onClick={() => setConfirm(true)}>确认应用变更…</Button>}
    </>}
    <Dialog open={confirm} onOpenChange={setConfirm}><DialogContent><DialogHeader><DialogTitle>应用脚本 Agent 变更</DialogTitle><DialogDescription>把预览中的 {turn.proposal?.changes.length ?? 0} 项文件变更及元数据修改，以单次修订保存到当前草稿 {turn.baseRevision}。应用后请手动测试并发布。</DialogDescription></DialogHeader><ErrorNotice message={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>取消</Button><Button disabled={busy || disabled || stale} onClick={() => void apply()}>确认并保存草稿</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
