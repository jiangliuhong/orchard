import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Binding, Workflow } from "../../domain/types.js";
import { validateWorkflow } from "../../domain/validation.js";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { ErrorNotice } from "../components/common";

interface OutputField { key: string; source: "node" | "workflow"; nodeId: string; pointer: string }
interface OutputForm {
  mode: "node" | "workflow" | "object" | "advanced";
  nodeId: string; pointer: string; fields: OutputField[]; bindingText: string; schemaText: string;
}
function initialForm(workflow: Workflow): OutputForm {
  const binding = workflow.result, fields: OutputField[] = [];
  if (!binding || typeof binding !== "object") return { mode: "advanced", nodeId: workflow.entryNodeId, pointer: "", fields, bindingText: JSON.stringify(binding ?? null, null, 2), schemaText: JSON.stringify(workflow.outputSchema ?? true, null, 2) };
  const simpleObject = binding.source === "object" && binding.properties && typeof binding.properties === "object" && !Array.isArray(binding.properties) && Object.values(binding.properties).every(value => value && (value.source === "node" || value.source === "workflow"));
  if (binding.source === "object" && simpleObject) for (const [key, value] of Object.entries(binding.properties)) {
    if (value.source === "node" || value.source === "workflow") fields.push({ key, source: value.source, nodeId: value.source === "node" ? value.nodeId : workflow.entryNodeId, pointer: value.pointer ?? "" });
  }
  return {
    mode: binding.source === "node" || binding.source === "workflow" ? binding.source : simpleObject ? "object" : "advanced",
    nodeId: binding.source === "node" ? binding.nodeId : workflow.entryNodeId,
    pointer: binding.source === "node" || binding.source === "workflow" ? binding.pointer ?? "" : "",
    fields, bindingText: JSON.stringify(binding, null, 2), schemaText: JSON.stringify(workflow.outputSchema, null, 2),
  };
}
function fieldBinding(field: Omit<OutputField, "key">): Binding {
  return field.source === "node" ? { source: "node", nodeId: field.nodeId, pointer: field.pointer } : { source: "workflow", pointer: field.pointer };
}
export function WorkflowOutputEditor({ workflow, disabled = false, onApply }: {
  workflow: Workflow; disabled?: boolean; onApply?: (result: Binding, outputSchema: Workflow["outputSchema"]) => void;
}) {
  const [form, setForm] = useState(() => initialForm(workflow)), [error, setError] = useState(""), [applied, setApplied] = useState(false);
  const signature = JSON.stringify([workflow.id, workflow.result, workflow.outputSchema]);
  useEffect(() => { setForm(initialForm(workflow)); setError(""); }, [signature]);
  const update = (change: Partial<OutputForm>) => { setForm(current => ({ ...current, ...change })); setApplied(false); setError(""); };
  const updateField = (index: number, change: Partial<OutputField>) => update({ fields: form.fields.map((field, at) => at === index ? { ...field, ...change } : field) });
  const nodeOptions = workflow.nodes.map(node => <option key={node.id} value={node.id}>{node.name} · {node.id}</option>);
  const apply = () => {
    try {
      let result: Binding;
      if (form.mode === "advanced") result = JSON.parse(form.bindingText);
      else if (form.mode === "object") {
        const keys = form.fields.map(field => field.key.trim());
        if (keys.some(key => !key) || new Set(keys).size !== keys.length) throw new Error("输出字段名不能为空或重复");
        result = { source: "object", properties: Object.fromEntries(form.fields.map((field, index) => [keys[index]!, fieldBinding(field)])) };
      } else result = fieldBinding({ source: form.mode, nodeId: form.nodeId, pointer: form.pointer });
      const outputSchema: Workflow["outputSchema"] = JSON.parse(form.schemaText);
      validateWorkflow({ ...workflow, result, outputSchema });
      onApply?.(result, outputSchema); setError(""); setApplied(true);
    } catch (failure) { setError((failure as Error).message); }
  };
  return <div className="detail-stack workflow-output-editor">
    <p className="field-hint">配置整个工作流最终返回的内容。节点引用必须在所有结束路径中可用。</p>
    <div className="field"><label htmlFor="workflow-output-mode">输出方式</label><select id="workflow-output-mode" className="output-select" value={form.mode} disabled={disabled} onChange={event => update({ mode: event.target.value as OutputForm["mode"] })}><option value="node">节点输出</option><option value="workflow">工作流输入</option><option value="object">组合多个字段</option><option value="advanced">高级绑定 JSON</option></select></div>
    {(form.mode === "node" || form.mode === "workflow") && <>
      {form.mode === "node" && <div className="field"><label htmlFor="workflow-output-node">输出节点</label><select id="workflow-output-node" className="output-select" value={form.nodeId} disabled={disabled} onChange={event => update({ nodeId: event.target.value })}>{nodeOptions}</select></div>}
      <div className="field"><label htmlFor="workflow-output-pointer">字段路径（JSON Pointer）</label><Input id="workflow-output-pointer" value={form.pointer} placeholder="留空返回全部，例如 /summary" disabled={disabled} onChange={event => update({ pointer: event.target.value })} /></div>
    </>}
    {form.mode === "object" && <div className="output-fields">{form.fields.map((field, index) => <fieldset className="output-field" key={index} disabled={disabled}><legend>输出字段 {index + 1}</legend>
      <div className="field"><label htmlFor={`output-key-${index}`}>字段名</label><Input id={`output-key-${index}`} value={field.key} onChange={event => updateField(index, { key: event.target.value })} /></div>
      <div className="field"><label htmlFor={`output-source-${index}`}>数据来源</label><select id={`output-source-${index}`} className="output-select" value={field.source} onChange={event => updateField(index, { source: event.target.value as OutputField["source"] })}><option value="node">节点输出</option><option value="workflow">工作流输入</option></select></div>
      {field.source === "node" && <div className="field"><label htmlFor={`output-node-${index}`}>来源节点</label><select id={`output-node-${index}`} className="output-select" value={field.nodeId} onChange={event => updateField(index, { nodeId: event.target.value })}>{nodeOptions}</select></div>}
      <div className="field"><label htmlFor={`output-pointer-${index}`}>字段路径</label><Input id={`output-pointer-${index}`} value={field.pointer} placeholder="例如 /summary" onChange={event => updateField(index, { pointer: event.target.value })} /></div>
      <Button variant="ghost" aria-label={`移除输出字段 ${index + 1}`} onClick={() => update({ fields: form.fields.filter((_, at) => at !== index) })}><Trash2 size={13} />移除字段</Button>
    </fieldset>)}<Button variant="outline" disabled={disabled} onClick={() => update({ fields: [...form.fields, { key: "", source: "node", nodeId: workflow.entryNodeId, pointer: "" }] })}><Plus size={13} />添加输出字段</Button></div>}
    {form.mode === "advanced" && <div className="field"><label htmlFor="workflow-output-binding">最终输出绑定 JSON</label><Textarea id="workflow-output-binding" className="font-mono" rows={9} value={form.bindingText} disabled={disabled} onChange={event => update({ bindingText: event.target.value })} /></div>}
    <div className="field"><label htmlFor="workflow-output-schema">最终输出 Schema</label><Textarea id="workflow-output-schema" className="font-mono" rows={7} value={form.schemaText} disabled={disabled} onChange={event => update({ schemaText: event.target.value })} /><span className="field-hint">true 表示不限制；文本可用 {`{"type":"string"}`}，对象可用 {`{"type":"object"}`}。</span></div>
    <ErrorNotice message={error} />
    {!disabled && <><Button onClick={apply}>应用输出配置</Button><p className="field-hint">{applied ? "已应用到草稿，请点击“保存修改”后测试或发布。" : "配置后点击“应用输出配置”，再保存草稿。"}</p></>}
  </div>;
}
