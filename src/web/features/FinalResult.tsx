import { isRedacted } from "./DictionaryEditors";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Maximize2, Minimize2 } from "lucide-react";
import type { RunStatus } from "../../domain/types.js";
import { api } from "../lib/api";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { ErrorNotice } from "../components/common";

function artifactReference(value: unknown): { id: string; byteSize: number } | undefined {
  if (!value || typeof value !== "object" || !("artifact" in value) || Object.keys(value).length !== 1) return;
  const artifact = value.artifact;
  if (artifact && typeof artifact === "object" && "id" in artifact && typeof artifact.id === "string" && "byteSize" in artifact && typeof artifact.byteSize === "number") return { id: artifact.id, byteSize: artifact.byteSize };
}
export function FinalResult({ runId, status, value, redacted = false }: { runId: string; status: RunStatus; value: unknown; redacted?: boolean }) {
  const [format, setFormat] = useState("preview"), [fullscreen, setFullscreen] = useState(false), [copied, setCopied] = useState(false);
  const [loaded, setLoaded] = useState<{ runId: string; value: unknown }>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | undefined>(undefined), copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setLoaded(undefined); setError(""); setCopied(false); setFormat("preview"); setBusy(false);
    return () => { controller.current?.abort(); clearTimeout(copyTimer.current); };
  }, [runId]);
  redacted = redacted || isRedacted(value);
  const result = loaded?.runId === runId ? loaded.value : value;
  const artifact = loaded?.runId === runId ? undefined : artifactReference(value);
  const ready = !redacted && status === "succeeded", text = typeof result === "string" && format === "preview" ? result : JSON.stringify(result, null, 2) ?? "null";
  const load = async () => {
    if (!artifact) return;
    const abort = new AbortController(); controller.current = abort; setBusy(true); setError("");
    try {
      const content = await api<unknown>(`/artifacts/${encodeURIComponent(artifact.id)}`, { signal: abort.signal });
      if (!abort.signal.aborted) setLoaded({ runId, value: content });
    } catch (failure) { if (!abort.signal.aborted) setError((failure as Error).message); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true); setError(""); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setError("复制失败，请允许剪贴板访问，或下载结果文件。"); }
  };
  const download = () => {
    const plainText = typeof result === "string" && format === "preview";
    const url = URL.createObjectURL(new Blob([text], { type: plainText ? "text/plain;charset=utf-8" : "application/json;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `workflow-result-${runId}.${plainText ? "txt" : "json"}`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const content = redacted ? <p className="notice" role="status">涉及加密字典的敏感执行范围，最终结果已隐藏。</p> : !ready ? <div className="result-empty">{["queued", "running", "cancel_requested"].includes(status) ? "工作流尚未完成，完成后将在此显示最终结果。" : "此次运行未成功完成，没有最终结果。可到执行详情查看节点输出和错误。"}</div>
    : artifact ? <div className="result-empty"><p>结果较大（{(artifact.byteSize / 1024).toFixed(1)} KiB），加载后可预览、复制或下载。</p><Button variant="outline" disabled={busy} onClick={() => void load()}>{busy ? "正在加载…" : "加载完整结果"}</Button></div>
    : <pre className={`final-result-content ${typeof result === "string" && format === "preview" ? "is-text" : "is-json"}`}>{text === "" ? "（空字符串）" : text}</pre>;
  const actions = <><Button variant="outline" disabled={!ready || !!artifact} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制"}</Button><Button variant="outline" disabled={!ready || !!artifact} onClick={download}><Download size={14} />下载</Button></>;
  return <section className="final-result-panel" aria-label="工作流最终结果">
    <div className="final-result-toolbar"><div><h2>工作流最终结果</h2><p>展示配置的最终输出，节点的中间结果在执行详情中查看。</p></div><div className="actions">
      {ready && !artifact && <select className="result-format" aria-label="结果显示格式" value={format} onChange={event => { setFormat(event.target.value); setCopied(false); }}><option value="preview">预览</option><option value="json">原始 JSON</option></select>}
      {actions}<Dialog open={fullscreen} onOpenChange={setFullscreen}><DialogTrigger asChild><Button variant="outline" aria-label="全屏查看最终结果"><Maximize2 size={14} />全屏</Button></DialogTrigger><DialogContent className="result-fullscreen translate-x-0 translate-y-0" showCloseButton={false}><header className="source-fullscreen-header"><div className="source-fullscreen-title"><div><DialogTitle>工作流最终结果</DialogTitle><DialogDescription>完整展示本次运行的最终输出。</DialogDescription></div></div><div className="actions">{actions}<Button variant="outline" onClick={() => setFullscreen(false)}><Minimize2 size={14} />退出全屏</Button></div></header><ErrorNotice message={error} /><div className="result-fullscreen-body">{content}</div></DialogContent></Dialog>
    </div></div><ErrorNotice message={error} />{content}
  </section>;
}
