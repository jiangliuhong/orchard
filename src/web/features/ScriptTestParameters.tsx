import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Unlink } from "lucide-react";
import type { JsonSchema } from "../../domain/types.js";
import { scriptInputProperties, stripReferencedInput, type ScriptInputSources } from "../../domain/script-test-input.js";
import { pointerPart, type HistorySources } from "../../web-bridge/history-policy.js";
import { parseStrictJson } from "../../dictionaries/canonical.js";
import { BridgeParameterInputs } from "./BridgeParameterInputs";
import { CredentialDictionaryPicker } from "./BridgeCredentialInputs";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";

export function ScriptTestParameters({ schema, value, sources, disabled, onChange, onSources, onInvalidChange, resetKey, missing }: {
  schema: JsonSchema; value: string; sources: ScriptInputSources; disabled: boolean; onChange: (value: string) => void;
  onSources: (sources: ScriptInputSources) => void; onInvalidChange: (invalid: boolean) => void; resetKey: number; missing: HistorySources;
}) {
  const properties = scriptInputProperties(schema);
  let formValueSupported = false;
  try { const parsed = parseStrictJson(value); formValueSupported = !!parsed && typeof parsed === "object" && !Array.isArray(parsed); } catch { /* Keep malformed input in JSON mode. */ }
  const supportsForm = !!properties;
  const [switchError, setSwitchError] = useState("");
  const [formInvalid, setFormInvalid] = useState(false), [formEdited, setFormEdited] = useState(false), [confirmJson, setConfirmJson] = useState(false), [formGeneration, setFormGeneration] = useState(0);
  const reportInvalid = useCallback((invalid: boolean) => { setFormInvalid(invalid); onInvalidChange(invalid); }, [onInvalidChange]);
  useEffect(() => { setFormEdited(false); }, [resetKey, sources]);
  const [mode, setMode] = useState(supportsForm && formValueSupported ? "form" : "json"), [picker, setPicker] = useState<string>(), [lastDictionary, setLastDictionary] = useState("");
  const boundFields = useMemo(() => Object.keys(properties ?? {}).filter(name => Object.hasOwn(sources, `/${pointerPart(name)}`)), [properties, sources]);
  const formSchema = useMemo(() => {
    if (typeof schema !== "object") return schema;
    const boundCount = boundFields.length;
    // Bound fields are absent from manual input, but present after server resolution.
    if (typeof schema.maxProperties === "number" && schema.maxProperties < boundCount) return false;
    return {
      ...schema,
      properties: Object.fromEntries(Object.entries(properties ?? {}).filter(([key]) => !boundFields.includes(key))),
      ...(schema.required ? { required: (schema.required as string[]).filter(key => !boundFields.includes(key)) } : {}),
      ...(typeof schema.minProperties === "number" ? { minProperties: Math.max(0, schema.minProperties - boundCount) } : {}),
      ...(typeof schema.maxProperties === "number" ? { maxProperties: schema.maxProperties - boundCount } : {}),
    };
  }, [schema, properties, boundFields]);
  const change = useCallback((v: string) => onChange(v), [onChange]);
  const setReference = (name: string, ref?: ScriptInputSources[string]) => {
    const path = `/${pointerPart(name)}`, next = { ...sources };
    if (ref) next[path] = ref; else delete next[path];
    if (ref) { try { onChange(JSON.stringify(stripReferencedInput(parseStrictJson(value), next), null, 2)); } catch { /* Keep invalid JSON so it can be fixed. */ } }
    onSources(next);
  };
  return <div className="script-test-parameters"><div className="actions"><Button type="button" aria-pressed={mode === "form"} variant={mode === "form" ? "secondary" : "ghost"} disabled={!supportsForm || disabled} onClick={() => { if (!formValueSupported) { setSwitchError("请先将测试输入修正为合法 JSON 对象，再切换参数表单；原始内容不会被覆盖。"); return; } setSwitchError(""); setFormGeneration(v => v + 1); setFormEdited(false); setMode("form"); }}>参数表单</Button><Button type="button" aria-pressed={mode === "json"} variant={mode === "json" ? "secondary" : "ghost"} disabled={disabled} onClick={() => { setSwitchError(""); if (formInvalid && formEdited) setConfirmJson(true); else { setMode("json"); onInvalidChange(false); } }}>JSON</Button></div>
    {switchError && <p role="alert" className="field-hint">{switchError}</p>}
    {mode === "form" && supportsForm ? <BridgeParameterInputs key={`${resetKey}:${formGeneration}:${JSON.stringify(sources)}`} legend="测试参数" emptyLabel="没有声明的参数，可切换 JSON 填写。" schema={schema} validationSchema={formSchema} allowGeneric preserveUnknown boundFields={boundFields} value={value} disabled={disabled} onChange={change} onInvalidChange={reportInvalid} onFieldChange={() => setFormEdited(true)}
      renderBoundField={(name, id) => { const ref = sources[`/${pointerPart(name)}`]!; return <button id={id} type="button" aria-label={`{{dictionary:${ref.dictionaryId}:${ref.key}}}`} className="script-parameter-reference font-mono" disabled={disabled} onClick={() => setPicker(name)}>{`{{dictionary:${ref.dictionaryId}:${ref.key}}}`}</button>; }}
      renderFieldActions={name => { const ref = sources[`/${pointerPart(name)}`]; return <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={`${ref ? "清空字典" : "引入字典"} ${name}`} onClick={() => ref ? setReference(name) : setPicker(name)}>{ref ? <Unlink size={15} /> : <BookOpen size={15} />}</Button>; }}
    /> : <label>测试输入 JSON<Textarea className="font-mono" rows={7} value={value} disabled={disabled} onChange={e => { setSwitchError(""); onChange(e.target.value); onInvalidChange(false); }} /></label>}
    {mode === "json" && boundFields.length > 0 && <p className="field-hint">已绑定字典的参数（{boundFields.join("、")}）仍由引用提供；切换参数表单可查看、修改或解除引用。JSON 中的同名值不会覆盖引用。</p>}
    {!properties && <p className="field-hint">当前 Schema 无法识别顶层参数，请手动填写 JSON；首版不支持此结构的字典引用。</p>}
    {Object.entries(missing).filter(([, ref]) => ref.source === "omitted").map(([path]) => <p key={path} className="field-hint">历史未记录参数 {path || "（根）"}，请重新填写；不会自动执行。</p>)}
    <p className="field-hint">普通手动值默认记录历史；禁止记录的参数仅驻留内存。加密引用或禁止记录的手动值会隐藏整次测试的输入、输出与日志。</p>
    <Dialog open={confirmJson} onOpenChange={setConfirmJson}><DialogContent><DialogHeader><DialogTitle>切换到 JSON？</DialogTitle><DialogDescription>表单有未通过校验的输入。切换将使用最近一次有效 JSON，并放弃当前未提交的表单编辑。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirmJson(false)}>继续编辑表单</Button><Button disabled={disabled} onClick={() => { setMode("json"); onInvalidChange(false); setFormEdited(false); setConfirmJson(false); }}>放弃表单编辑并切换</Button></DialogFooter></DialogContent></Dialog>
    {picker !== undefined && <CredentialDictionaryPicker name={picker} disabled={disabled} initialDictionaryId={sources[`/${pointerPart(picker)}`]?.dictionaryId ?? lastDictionary} acceptedTypes={(() => {
      const type = (properties?.[picker] as { type?: string } | undefined)?.type;
      return type === "string" ? ["string", "json"] : type === "number" || type === "integer" ? ["number", "json"] : type === "boolean" ? ["boolean", "json"] : type ? ["json"] : ["string", "number", "boolean", "json"];
    })()} onClose={() => setPicker(undefined)} onSelect={(dictionaryId, key) => { setLastDictionary(dictionaryId); setReference(picker, { source: "dictionary", dictionaryId, key }); setPicker(undefined); }} />}
  </div>;
}
