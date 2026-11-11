import { useEffect, useId, useState } from "react";
import type { Binding } from "../../domain/types.js";
import { normalizeDictionaryBindings, type DictionaryBindings } from "../../domain/dictionaries.js";
import { api, pretty, useResource } from "../lib/api";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Input } from "../components/ui/input";
import { ErrorNotice, Payload } from "../components/common";
import type { DictionaryDetail, DictionaryListView } from "./DictionariesPage";

export function parseDeclarations(text: string) { return normalizeDictionaryBindings(JSON.parse(text)); }
export function DictionaryDeclarationEditor({ value, disabled, onApply }: { value?: DictionaryBindings; disabled?: boolean; onApply?: (value: DictionaryBindings | undefined) => void }) {
  const [text, setText] = useState(pretty(value ?? {})), [error, setError] = useState(""); const id = useId();
  useEffect(() => { setText(pretty(value ?? {})); setError(""); }, [value]);
  const dictionaries = useResource<{ items: DictionaryListView[]; nextCursor?: string }>("/dictionaries?limit=100");
  return <details><summary>字典依赖声明</summary><p className="field-hint">格式：别名 → dictionaryId、kind（plain / encrypted）、keys 数组。加密依赖节点及后继隐藏输入、输出和日志，不能调用 Agent 或 Web Bridge。固定脚本的声明由脚本版本决定。</p><label htmlFor={id}>字典依赖 JSON</label><Textarea id={id} className="font-mono" rows={7} disabled={disabled} value={text} onChange={e => setText(e.target.value)} /><ErrorNotice message={error || dictionaries.error} />{onApply && <Button disabled={disabled} variant="outline" onClick={() => { try { const parsed = parseDeclarations(text); onApply(parsed); setError(""); } catch (e) { setError((e as Error).message); } }}>应用字典声明</Button>}<details><summary>可用字典（名称与 ID）</summary>{dictionaries.data?.items?.map(d => <p key={d.id}>{d.name} · {d.kind} · {d.enabled ? "启用" : "禁用"} · {d.readiness} <code>{d.id}</code></p>)}{dictionaries.data?.nextCursor && <p>这里只展示前 100 个字典；其他字典可在字典页面查找 ID。</p>}</details><p className="field-hint">Node.js 使用 context.dictionaries.get(别名, 键) 或 context.secrets.get(别名, 键)；Shell 使用 "$ORCHARD_NODE_EXECUTABLE" "$ORCHARD_DICTIONARY_HELPER" plain/secret 别名 键。只注入声明的键。</p></details>;
}
export function parseInputBinding(text: string): Binding {
  const value = JSON.parse(text);
  const visit = (b: any, depth = 0): void => {
    if (depth > 64 || !b || typeof b !== "object" || Array.isArray(b)) throw new Error("输入绑定必须是结构化对象");
    if (b.pointer !== undefined && (typeof b.pointer !== "string" || !/^(?:\/(?:[^~]|~[01])*)*$/.test(b.pointer))) throw new Error("JSON Pointer 格式无效");
    const allowed: Record<string, string[]> = { literal: ["source", "value"], workflow: ["source", "pointer"], node: ["source", "nodeId", "pointer"], dictionary: ["source", "dictionaryId", "key", "pointer"], object: ["source", "properties"], array: ["source", "items"] };
    if (!allowed[b.source] || Object.keys(b).some(k => !allowed[b.source]!.includes(k))) throw new Error("输入绑定来源或字段无效");
    if (b.source === "dictionary" && (typeof b.dictionaryId !== "string" || !b.dictionaryId || typeof b.key !== "string" || !b.key)) throw new Error("请选择字典和键");
    if (b.source === "node" && (typeof b.nodeId !== "string" || !b.nodeId)) throw new Error("节点 ID 必填");
    if (b.source === "literal" && !Object.hasOwn(b, "value")) throw new Error("常量值必填");
    if (b.source === "object") { if (!b.properties || typeof b.properties !== "object" || Array.isArray(b.properties)) throw new Error("properties 必须是对象"); Object.values(b.properties).forEach(child => visit(child, depth + 1)); }
    if (b.source === "array") { if (!Array.isArray(b.items)) throw new Error("items 必须是数组"); b.items.forEach((child: unknown) => visit(child, depth + 1)); }
  }; visit(value); return value;
}
export function DictionaryInputEditor({ value, disabled, onApply }: { value: Binding; disabled?: boolean; onApply: (value: Binding) => void }) {
  const id = useId(), [mode, setMode] = useState(value.source === "dictionary" ? "dictionary" : "advanced"), [text, setText] = useState(pretty(value));
  const [dictionaryId, setDictionaryId] = useState(value.source === "dictionary" ? value.dictionaryId : ""), [key, setKey] = useState(value.source === "dictionary" ? value.key : ""), [pointer, setPointer] = useState(value.source === "dictionary" ? value.pointer ?? "" : ""), [error, setError] = useState("");
  const list = useResource<{ items: DictionaryListView[]; nextCursor?: string }>("/dictionaries?kind=plain&limit=100");
  const [detail, setDetail] = useState<{ data?: DictionaryDetail; error?: string }>({});
  useEffect(() => { setDetail({}); if (!dictionaryId) return; const controller = new AbortController(); void api<DictionaryDetail>(`/dictionaries/${encodeURIComponent(dictionaryId)}`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setDetail({ data }); }).catch(e => { if (!controller.signal.aborted) setDetail({ error: e.message }); }); return () => controller.abort(); }, [dictionaryId]);
  return <details><summary>编辑节点输入绑定</summary><fieldset disabled={disabled}><label htmlFor={`${id}-mode`}>输入来源</label><select id={`${id}-mode`} value={mode} onChange={e => setMode(e.target.value)}><option value="dictionary">普通字典</option><option value="advanced">高级 Binding JSON（含嵌套对象和数组）</option></select>{mode === "dictionary" ? <><label htmlFor={`${id}-dictionary`}>普通字典</label><select id={`${id}-dictionary`} value={dictionaryId} onChange={e => { setDictionaryId(e.target.value); setKey(""); }}><option value="">选择字典</option>{dictionaryId && !list.data?.items?.some(d => d.id === dictionaryId) && <option value={dictionaryId}>{dictionaryId}（缺失、不可用或不在当前页）</option>}{list.data?.items?.filter(d => d.kind === "plain").map(d => <option key={d.id} value={d.id}>{d.name}{!d.enabled ? "（已禁用）" : ""}</option>)}</select><label htmlFor={`${id}-key`}>字典键</label><Input id={`${id}-key`} list={`${id}-keys`} value={key} onChange={e => setKey(e.target.value)} /><datalist id={`${id}-keys`}>{Object.keys(detail.data?.keys ?? {}).map(k => <option key={k} value={k} />)}</datalist><label htmlFor={`${id}-pointer`}>JSON Pointer（可选）</label><Input id={`${id}-pointer`} placeholder="/nested/value" value={pointer} onChange={e => setPointer(e.target.value)} />{detail.data && (!detail.data.enabled || !Object.hasOwn(detail.data.keys, key)) && <p role="status">字典已禁用或所选键不存在，请修复引用。</p>}</> : <><label htmlFor={`${id}-json`}>节点输入 Binding JSON</label><Textarea id={`${id}-json`} rows={8} className="font-mono" value={text} onChange={e => setText(e.target.value)} /></>}<ErrorNotice message={error || list.error || detail.error} /><Button variant="outline" onClick={() => { try { const next = parseInputBinding(mode === "dictionary" ? JSON.stringify({ source: "dictionary", dictionaryId, key, ...(pointer ? { pointer } : {}) }) : text); onApply(next); setText(pretty(next)); setError(""); } catch (e) { setError((e as Error).message); } }}>应用输入绑定</Button></fieldset></details>;
}
export interface RedactionFlags { inputRedacted?: boolean; outputRedacted?: boolean; logsRedacted?: boolean; dictionaryBindings?: { dictionaryId: string; versionId: string; kind: "plain" | "encrypted"; name: string; keys: string[] }[] }
export function RedactedPayload({ redacted, value }: { redacted?: boolean; value: unknown }) { return redacted || isRedacted(value) ? <p className="notice" role="status">敏感执行范围的内容已隐藏。</p> : <Payload value={value} />; }
export function DictionaryExecutionMetadata({ value }: { value: RedactionFlags }) { return value.dictionaryBindings?.length ? <details><summary>入队时固定的字典版本</summary><Payload value={value.dictionaryBindings} /></details> : null; }

export function isRedacted(value: unknown) { return !!value && typeof value === "object" && "orchardRedacted" in value && value.orchardRedacted === true; }
