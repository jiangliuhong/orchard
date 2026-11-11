import { useEffect, useId, useRef, useState } from "react";
import type { JsonSchema } from "../../domain/types.js";
import { parseStrictJson } from "../../dictionaries/canonical.js";
import { changeSchemaType, deleteSchemaProperty, parseEditorSchema, renameSchemaProperty, schemaEditorReason, schemaTypes, type SchemaObject } from "../lib/schema-editor";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";

type Report = (id: string, error: string) => void;
function JsonConstraint({ label, value, onChange, report, onDirty }: { label: string; value: unknown; onChange: (v: unknown) => void; report: Report; onDirty: () => void }) {
  const id = useId(), [text, setText] = useState(value === undefined ? "" : JSON.stringify(value));
  const encoded = value === undefined ? "" : JSON.stringify(value);
  useEffect(() => { setText(encoded); }, [encoded]);
  useEffect(() => () => report(id, ""), [id, report]);
  return <label>{label}<Input aria-label={label} className="font-mono" value={text} onChange={event => {
    const raw = event.target.value; setText(raw); onDirty();
    try { const parsed = raw === "" ? undefined : parseStrictJson(raw); report(id, ""); onChange(parsed); }
    catch { report(id, `${label} 必须是合法 JSON`); }
  }} /></label>;
}
function SchemaNode({ value, onChange, label, report, onDirty, confirm }: { value: JsonSchema; onChange: (v: JsonSchema) => void; label: string; report: Report; onDirty: () => void; confirm: (message: string, action: () => void) => void }) {
  const ids = useRef(new Map<string, string>()), counter = useRef(0), nodeId = useId();
  const object = typeof value === "object" ? value : undefined;
  const type = object ? String(object.type) : String(value);
  useEffect(() => () => { for (const id of ids.current.values()) report(id, ""); }, [report]);
  const update = (key: string, v: unknown) => { const next = { ...object }; if (v === undefined) delete next[key]; else Object.defineProperty(next, key, { value: v, enumerable: true, writable: true, configurable: true }); onChange(next); };
  const properties = (object?.properties ?? {}) as Record<string, JsonSchema>;
  return <div className="schema-node"><div className="schema-node-toolbar"><strong>{label}</strong><label>类型<select aria-label={`${label} 类型`} value={type} onChange={event => {
    const next = changeSchemaType(value, event.target.value);
    confirm(`将 ${label} 改为 ${event.target.value}。不兼容的子字段和约束将被移除。\n变更后：${JSON.stringify(next, null, 2)}`, () => { for (const id of ids.current.values()) report(id, ""); ids.current.clear(); onChange(next); });
  }}><option value="true">不限制（true）</option><option value="false">禁止任何值（false）</option>{schemaTypes.map(t => <option key={t}>{t}</option>)}</select></label></div>
    {object && <><div className="schema-node-fields"><label>显示名称<Input value={String(object.title ?? "")} onChange={e => update("title", e.target.value || undefined)} /></label><label>说明<Input value={String(object.description ?? "")} onChange={e => update("description", e.target.value || undefined)} /></label>
      <label>手动值历史<select value={(object["x-history"] as { record?: boolean } | undefined)?.record === undefined ? "default" : String((object["x-history"] as { record: boolean }).record)} onChange={e => update("x-history", e.target.value === "default" ? undefined : { record: e.target.value === "true" })}><option value="default">默认（继承；未禁止则记录）</option><option value="true">允许记录（不能覆盖父级禁止）</option><option value="false">禁止记录</option></select></label></div>
      {type === "object" && <><label>额外字段<select value={object.additionalProperties === undefined ? "default" : String(object.additionalProperties)} onChange={e => update("additionalProperties", e.target.value === "default" ? undefined : e.target.value === "true")}><option value="default">允许（默认）</option><option value="true">允许</option><option value="false">禁止</option></select></label>
        <div className="schema-properties">{Object.entries(properties).map(([name, child]) => {
          if (!ids.current.has(name)) ids.current.set(name, `${nodeId}-${counter.current++}`);
          const id = ids.current.get(name)!;
          return <details key={id} open><summary className="font-mono">{name}</summary><div className="schema-property-heading"><label>字段名<Input defaultValue={name} aria-label={`字段名 ${name}`} onChange={() => { onDirty(); report(id, "请完成字段名编辑"); }} onBlur={e => {
            try { const next = renameSchemaProperty(object, name, e.target.value); report(id, ""); if (next !== object) { ids.current.delete(name); ids.current.set(e.target.value, id); onChange(next); } }
            catch (error) { report(id, (error as Error).message); }
          }} /></label><label><input type="checkbox" checked={(object.required as string[] | undefined)?.includes(name) ?? false} onChange={e => update("required", e.target.checked ? [...new Set([...(object.required as string[] ?? []), name])] : (object.required as string[] ?? []).filter(n => n !== name))} />必填</label>
            <Button variant="ghost" type="button" aria-label={`删除字段 ${name}`} onClick={() => confirm(`删除字段 ${name} 及其约束／子字段？`, () => { report(id, ""); ids.current.delete(name); onChange(deleteSchemaProperty(object, name)); })}>删除</Button></div>
            <SchemaNode value={child} label={name} report={report} onDirty={onDirty} confirm={confirm} onChange={v => update("properties", Object.fromEntries(Object.entries(properties).map(([key, old]) => [key, key === name ? v : old])))} />
          </details>;
        })}</div><Button variant="outline" type="button" onClick={() => { let n = 1; while (Object.hasOwn(properties, `field${n}`)) n++; update("properties", { ...properties, [`field${n}`]: { type: "string" } }); }}>添加字段</Button></>}
      {type === "array" && <SchemaNode label="元素" value={object.items as JsonSchema ?? true} onChange={v => update("items", v)} report={report} onDirty={onDirty} confirm={confirm} />}
      <details><summary>约束与默认值</summary><div className="schema-node-fields">
        {(type === "string" ? ["enum", "minLength", "maxLength"] : ["number", "integer"].includes(type) ? ["enum", "minimum", "maximum"] : type === "array" ? ["minItems", "maxItems", "uniqueItems"] : []).map(key => <JsonConstraint key={key} label={key} value={object[key]} onChange={v => update(key, v)} report={report} onDirty={onDirty} />)}
        {type === "string" && <><label>pattern<Input value={String(object.pattern ?? "")} onChange={e => update("pattern", e.target.value || undefined)} /></label><label>字符串控件<select value={(object["x-ui"] as { widget?: string } | undefined)?.widget ?? "default"} onChange={e => update("x-ui", e.target.value === "default" ? undefined : { ...(object["x-ui"] as object), widget: e.target.value, ...(e.target.value === "input" ? { rows: undefined } : {}) })}><option value="default">默认</option><option value="input">单行</option><option value="textarea">多行</option></select></label>
          <label>占位文字<Input value={(object["x-ui"] as { placeholder?: string } | undefined)?.placeholder ?? ""} onChange={e => update("x-ui", { ...(object["x-ui"] as object), placeholder: e.target.value })} /></label>
          {(object["x-ui"] as { widget?: string } | undefined)?.widget === "textarea" && <JsonConstraint label="多行行数" value={(object["x-ui"] as { rows?: number }).rows} onChange={rows => update("x-ui", { ...(object["x-ui"] as object), rows })} report={report} onDirty={onDirty} />}</>}
        <JsonConstraint label="default（不自动填入测试参数）" value={object.default} onChange={v => update("default", v)} report={report} onDirty={onDirty} />
      </div></details></>}
  </div>;
}
export function SchemaEditor({ label, value, onChange, disabled, onInvalidChange, onDirty }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; onInvalidChange: (v: boolean) => void; onDirty: () => void }) {
  let schema: JsonSchema = true, error = "";
  try { schema = parseEditorSchema(value); } catch (failure) { error = (failure as Error).message; try { schema = parseStrictJson(value) as JsonSchema; } catch { /* JSON view keeps the invalid buffer. */ } }
  const reason = !error ? schemaEditorReason(schema) : undefined;
  const [mode, setMode] = useState(() => reason || error ? "json" : "fields");
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const report = useRef<Report>((id, message) => setLocalErrors(current => { if ((current[id] ?? "") === message) return current; const next = { ...current }; if (message) next[id] = message; else delete next[id]; return next; })).current;
  const [pending, setPending] = useState<{ message: string; action: () => void }>();
  const invalid = !!error || Object.keys(localErrors).length > 0;
  useEffect(() => { onInvalidChange(invalid); }, [invalid, onInvalidChange]);
  const id = useId();
  return <section className="schema-editor" aria-label={label}><div className="schema-editor-toolbar"><strong>{label}</strong><div className="actions"><Button type="button" variant={mode === "fields" ? "secondary" : "ghost"} disabled={!!reason || !!error} onClick={() => setMode("fields")}>字段编辑</Button><Button type="button" variant={mode === "json" ? "secondary" : "ghost"} onClick={() => { if (Object.keys(localErrors).length) return; setMode("json"); }}>JSON</Button></div></div>
    {reason && <p className="field-hint">{reason}；完整定义已保留。</p>}
    {mode === "json" || reason ? <label htmlFor={id}>Schema JSON<Textarea id={id} rows={10} className="font-mono" disabled={disabled} value={value} onChange={e => onChange(e.target.value)} /></label> : <fieldset disabled={disabled}><SchemaNode label="根" value={schema} onChange={v => onChange(JSON.stringify(v, null, 2))} report={report} onDirty={onDirty} confirm={(message, action) => setPending({ message, action })} /></fieldset>}
    {(error || Object.keys(localErrors).length > 0) && <div role="alert" className="field-hint">{[error, ...Object.values(localErrors)].filter(Boolean).join("；")}</div>}
    <Dialog open={!!pending} onOpenChange={open => { if (!open) setPending(undefined); }}><DialogContent><DialogHeader><DialogTitle>确认 Schema 结构变更</DialogTitle><DialogDescription className="whitespace-pre-wrap">{pending?.message}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setPending(undefined)}>取消</Button><Button disabled={disabled} onClick={() => { pending?.action(); setPending(undefined); }}>确认变更</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
