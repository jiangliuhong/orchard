import { useEffect, useMemo, useState } from "react";
import type { JsonSchema } from "../../domain/types";
import { assertSchema } from "../../domain/validation";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";

type FieldSchema = Record<string, unknown> & {
  type?: string; title?: string; description?: string; enum?: unknown[];
  "x-ui"?: { widget?: "input" | "textarea"; rows?: number; placeholder?: string };
};

export function BridgeParameterInputs({ schema, value, disabled, onChange, onInvalidChange }: {
  schema: JsonSchema; value: string; disabled: boolean;
  onChange: (value: string) => void; onInvalidChange: (invalid: boolean) => void;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const result = useMemo(() => {
    const fields: [string, FieldSchema][] = [];
    const values: Record<string, unknown> = Object.create(null);
    const errors: Record<string, string> = Object.create(null);
    let error = "";
    try {
      if (typeof schema !== "object" || schema.type !== "object") throw new Error("参数 Schema 必须声明 type: object 和 properties。");
      if (schema.oneOf || schema.anyOf || schema.allOf || schema.$ref) throw new Error("测试表单暂不支持根级组合或引用 Schema，请在工具定义中展开参数。");
      const properties = schema.properties as Record<string, unknown> | undefined;
      const existing = JSON.parse(value) as Record<string, unknown>;
      for (const [name, definition] of Object.entries(properties ?? {})) {
        if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error(`参数 ${name} 必须声明字段 Schema。`);
        const field = definition as FieldSchema;
        if (!["string", "number", "integer", "boolean", "object", "array"].includes(field.type ?? "") || field.$ref) throw new Error(`参数 ${name} 需要明确声明支持的 type。`);
        fields.push([name, field]);
        if (!Object.hasOwn(edits, name)) {
          if (Object.hasOwn(existing, name)) values[name] = existing[name];
          continue;
        }
        const text = edits[name];
        const required = Array.isArray(schema.required) && schema.required.includes(name);
        if (text === "" && (!required || field.type !== "string" || field.enum)) continue;
        try {
          if (field.enum) values[name] = field.enum[Number(text)];
          else if (field.type === "string") values[name] = text;
          else if (field.type === "number" || field.type === "integer") {
            const number = Number(text);
            if (!text.trim() || !Number.isFinite(number)) throw new Error();
            values[name] = number;
          } else values[name] = JSON.parse(text);
        } catch { errors[name] = "请输入有效的值"; }
      }
      for (const [name, field] of fields) {
        if (Object.hasOwn(values, name)) {
          try { assertSchema(values[name], field, name); }
          catch { errors[name] = "输入不符合参数 Schema"; }
        }
      }
      try { assertSchema(values, schema, "参数"); } catch { error = "请填写必填参数，并确保输入符合参数 Schema。"; }
    } catch (failure) { error = (failure as Error).message; }
    return { fields, values, errors, error, invalid: !!error || Object.keys(errors).length > 0 };
  }, [schema, value, edits]);
  useEffect(() => { onInvalidChange(result.invalid); }, [result.invalid, onInvalidChange]);
  const update = (name: string, text: string) => setEdits(current => ({ ...current, [name]: text }));
  useEffect(() => {
    if (!result.invalid) {
      const next = JSON.stringify(result.values);
      if (next !== value) onChange(next);
    }
  }, [result, value, onChange]);
  return <fieldset className="bridge-parameter-inputs" disabled={disabled}><legend>请求参数</legend>
    {result.fields.map(([name, field]) => {
      const current = result.values[name];
      const text = Object.hasOwn(edits, name) ? edits[name] : current === undefined ? "" : field.enum ? String(field.enum.findIndex(item => JSON.stringify(item) === JSON.stringify(current))) : field.type === "string" ? String(current) : JSON.stringify(current);
      const inputId = `bridge-parameter-${name}`;
      const required = typeof schema === "object" && Array.isArray(schema.required) && schema.required.includes(name);
      const props = { id: inputId, value: text, "aria-invalid": !!result.errors[name], "aria-describedby": `${inputId}-hint`, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => update(name, event.target.value) };
      return <div className="bridge-parameter-row" key={name}>
        <label htmlFor={inputId}>{field.title || name}{required ? " *" : ""}:</label>
        <div className="bridge-parameter-control">
          {field.enum ? <select {...props}><option value="">请选择</option>{field.enum.map((item, index) => <option key={index} value={index}>{typeof item === "string" ? item : JSON.stringify(item)}</option>)}</select>
            : field.type === "boolean" ? <select {...props}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>
              : field.type === "object" || field.type === "array" ? <Textarea {...props} className="font-mono" rows={5} spellCheck={false} placeholder={field.type === "array" ? "[]" : "{}"} />
                : field["x-ui"]?.widget === "textarea" ? <Textarea {...props} rows={field["x-ui"].rows ?? 5} placeholder={field["x-ui"].placeholder} />
                  : <Input {...props} type={field.type === "number" || field.type === "integer" ? "number" : "text"} step={field.type === "integer" ? 1 : "any"} placeholder={field["x-ui"]?.placeholder} />}
          <div id={`${inputId}-hint`}>{field.description && <p className="field-hint">{field.description}</p>}{result.errors[name] && <p className="field-hint" role="alert">{result.errors[name]}</p>}</div>
        </div>
      </div>;
    })}
    {result.error && <p className="field-hint" role="alert">{result.error}</p>}
    {!result.fields.length && !result.error && <p className="field-hint">此工具无需请求参数。</p>}
  </fieldset>;
}
